import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import vm from "node:vm";
import { worker, popup, youtube } from "./worker-helper.mjs";

const context = vm.createContext({ structuredClone, TextEncoder });
for (const name of ["classifiers.js", "keywords.js", "spending.js", "patterns.js"]) vm.runInContext(await readFile(new URL(`../extension/${name}`, import.meta.url), "utf8"), context);
const { PatternLedger, bits, range } = context.ThumbnailPatterns;
const ids = Array.from(context.ThumbnailClassifiers.ids);
const settings = { enabled: true, keywords: ["Crypto", "reaction", "__proto__"], aiEnabled: true, openaiApiKey: "secret", enabledClassifiers: ["clickbait", "rage_bait"], minProbability: .9 };
const hash = async value => createHash("sha256").update(value).digest("hex");
function fixture(initial = {}) {
  let now = Date.parse("2026-08-01T12:00:00Z"), fail = false;
  const data = structuredClone(initial);
  const storage = { get: async defaults => ({ ...defaults, ...data }), set: async patch => { if (fail) throw new Error("quota"); Object.assign(data, structuredClone(patch)); } };
  const ledger = new PatternLedger(storage, { now: () => now, hash });
  const event = (videoId, state = "keyword", overrides = {}) => ({ videoId, at: now, s: state, k: state === "keyword" ? ["Crypto"] : [],
    e: ["ai", "clear"].includes(state) ? bits(settings.enabledClassifiers) : 0, q: state === "ai" ? bits(["clickbait"]) : 0, w: state === "ai" ? 0 : -1, ...overrides });
  return { ledger, data, event, time: value => { now = Date.parse(value); }, fail: value => { fail = value; }, record: events => ledger.record(events, ledger.value.version) };
}

test("all keyword matches preserve literal Unicode-aware matching, overlap and prototype-like keywords", () => {
  const matcher = context.RedThumbnailKeywords.createMatcher(["Crypto", "reaction", "cat", ".*", "__proto__"]);
  assert.deepEqual(Array.from(matcher.all("CRYPTO reaction vacation .* __proto__")), ["Crypto", "reaction", ".*", "__proto__"]);
  assert.equal(matcher("vacation"), false);
});

test("distinct videos are deduplicated across batches, with every overlapping keyword counted", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "America/New_York");
  await Promise.all([f.record([f.event("same-video", "keyword", { k: ["Crypto", "reaction"] })]), f.record([f.event("same-video", "keyword", { k: ["crypto", "reaction"] })])]);
  await f.record([f.event("second", "keyword", { k: ["__proto__"] })]);
  const summary = await f.ledger.summary("today");
  assert.equal(summary.totals.encountered, 2);
  assert.equal(summary.totals.keyword, 2);
  assert.equal(summary.totals.keywords.crypto, 1);
  assert.equal(summary.totals.keywords.reaction, 1);
  assert.equal(summary.totals.keywords.__proto__, 1);
  assert.equal(JSON.stringify(f.data).includes("same-video"), false);
  assert.equal(JSON.stringify(f.data).includes('"secret"'), false);
});

test("AI categories count all qualified matches but only one displayed reason", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("overlap", "ai", { q: bits(settings.enabledClassifiers) }), f.event("ordinary", "clear"), f.event("keyword")]);
  const { totals } = await f.ledger.summary("today");
  assert.equal(totals.encountered, 3);
  assert.equal(totals.filtered, 2);
  assert.equal(totals.categories.clickbait.evaluated, 2);
  assert.equal(totals.categories.clickbait.qualified, 1);
  assert.equal(totals.categories.clickbait.shown, 1);
  assert.equal(totals.categories.rage_bait.qualified, 1);
  assert.equal(totals.categories.rage_bait.shown, 0);
});

test("rate denominators retain pending, unavailable and unchecked videos; final decisions resist duplicate pending reports", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("p", "pending"), f.event("u", "unavailable"), f.event("n", "unchecked"), f.event("clear", "clear"), f.event("filtered")]);
  let result = await f.ledger.summary("today");
  assert.equal(result.totals.encountered, 5);
  assert.equal(result.totals.filtered, 1);
  assert.equal(result.totals.pending, 1);
  await f.record([f.event("p", "ai")]);
  await f.record([f.event("p", "pending")]);
  result = await f.ledger.summary("today");
  assert.equal(result.totals.encountered, 5);
  assert.equal(result.totals.filtered, 2);
  assert.equal(result.totals.pending, 0);
});

test("period totals use the latest observed outcome while daily trends retain historical outcomes", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  f.time("2026-09-21T12:00:00Z"); await f.record([f.event("repeat")]);
  f.time("2026-09-22T12:00:00Z"); await f.record([f.event("repeat", "ai")]);
  f.time("2026-09-23T12:00:00Z");
  const overall = await f.ledger.summary("week"), keywords = await f.ledger.summary("week", "keyword:crypto");
  assert.equal(overall.totals.encountered, 1);
  assert.equal(overall.totals.ai, 1);
  assert.equal(overall.totals.keyword, 0);
  assert.equal(overall.daily.reduce((sum, day) => sum + day.count, 0), 2);
  assert.equal(keywords.daily[0].count, 1);
  assert.equal(keywords.daily[1].count, 0);
});

test("rule changes create markers, reject old revisions, and never recompute older observations", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC"); await f.record([f.event("old")]);
  const oldVersion = f.ledger.value.version;
  await f.ledger.updateSettings({ ...settings, keywordColor: "#ffffff" });
  assert.equal(f.ledger.value.version, oldVersion);
  await f.ledger.updateSettings({ ...settings, minProbability: .95, keywords: ["reaction"] });
  assert.equal(await f.ledger.record([f.event("stale")], oldVersion), false);
  const result = await f.ledger.summary("today");
  assert.equal(result.totals.encountered, 1);
  assert.equal(result.totals.keywords.crypto, 1);
  assert.deepEqual(Array.from(result.daily[0].changes[0].fields), ["Keywords", "Probability threshold"]);
});

test("pausing or changing rules resolves obsolete pending observations without changing completed matches", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("waiting", "pending"), f.event("matched")]);
  await f.ledger.updateSettings({ ...settings, enabled: false });
  const result = await f.ledger.summary("today");
  assert.equal(result.totals.pending, 0);
  assert.equal(result.totals.unavailable, 1);
  assert.equal(result.totals.keyword, 1);
});

test("comparisons use completed equivalent calendar days and category-specific denominators", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "America/New_York");
  f.time("2026-09-14T12:00:00Z"); await f.record([f.event("last-week", "ai"), f.event("last-clear", "clear")]);
  f.time("2026-09-21T12:00:00Z"); await f.record([f.event("this-week", "ai"), f.event("keyword")]);
  f.time("2026-09-23T12:00:00Z"); await f.record([f.event("today", "clear")]);
  const result = await f.ledger.summary("week", "category:clickbait");
  assert.equal(result.comparison.available, true);
  assert.equal(result.comparison.days, 2);
  assert.equal(result.comparison.current.count, 1);
  assert.equal(result.comparison.current.denominator, 1);
  assert.equal(result.comparison.previous.denominator, 2);
  assert.equal(result.daily.at(-1).denominator, 1);
  assert.equal(range("week", "2027-01-01").start, "2026-12-28");
  assert.equal(range("month", "2028-03-31").elapsed, 29);
  assert.equal(range("30days", "2026-03-09").start, "2026-02-08");
});

test("restarts retain history and the saved time zone, converting interrupted pending observations", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "America/New_York"); await f.record([f.event("one"), f.event("pending", "pending")]);
  const next = fixture(f.data); await next.ledger.initialize(settings, "Asia/Tokyo");
  const result = await next.ledger.summary("today");
  assert.equal(result.timeZone, "America/New_York");
  assert.equal(result.totals.encountered, 2);
  assert.equal(result.totals.pending, 0);
  assert.equal(result.totals.unavailable, 1);
});

test("invalid reports cannot add fabricated keywords, categories, identities or unsafe timestamps", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("a", "keyword", { k: ["not-configured"] }), f.event("b", "ai", { e: 1 }), f.event("https://youtube.com"),
    f.event("c", "keyword", { at: NaN }), f.event("d", "keyword", { at: 0 }), f.event("e", "clear", { q: 1 }), f.event("f", "ai", { w: 20 })]);
  assert.equal((await f.ledger.summary("today")).totals.encountered, 0);
});

test("bounded retention and storage failures remain visible without changing spending history", async () => {
  const f = fixture({ spendingLedger: { untouched: true } }); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("old")]);
  f.time("2026-11-01T12:00:00Z"); f.fail(true); await f.record([f.event("new")]);
  const result = await f.ledger.summary("30days");
  assert.equal(result.totals.encountered, 1);
  assert.match(result.warning, /could not be saved/);
  assert.equal(Object.keys(f.ledger.value.days).length, 1);
  assert.equal(f.data.spendingLedger.untouched, true);
  f.fail(false); await f.ledger.updateSettings(settings);
  assert.equal((await f.ledger.summary()).warning, "");
});

test("capacity eviction is bounded and flagged, including large sets of matched keywords", async () => {
  const f = fixture();
  const words = Array.from({ length: 100 }, (_, index) => `word-${index}-${"x".repeat(490)}`);
  await f.ledger.initialize({ ...settings, keywords: words }, "UTC");
  await f.record(Array.from({ length: 40 }, (_, index) => f.event(`video-${index}`, "keyword", { k: words })));
  const result = await f.ledger.summary("today");
  assert.equal(result.truncated, true);
  assert.ok(result.totals.encountered < 40);
  assert.ok(new TextEncoder().encode(JSON.stringify(f.data.filterPatterns)).length <= 1500000);
});

test("malformed stored history is preserved and displayed as session-only", async () => {
  const f = fixture({ filterPatterns: { format: 99, preserve: true } });
  await f.ledger.initialize(settings, "UTC"); await f.record([f.event("new")]);
  assert.equal(f.data.filterPatterns.preserve, true);
  assert.match((await f.ledger.summary()).warning, /session-only/);
});

test("worker observation messages are YouTube-only, summaries popup-only, and recording makes no API requests", async () => {
  const w = worker(undefined, settings);
  const { settings: publicSettings } = await w.send({ type: "get-settings" });
  const message = { type: "record-patterns", version: publicSettings.patternVersion, events: [{ videoId: "privateVideoId", at: Date.now(), s: "keyword", k: ["Crypto"], e: 0, q: 0, w: -1 }] };
  assert.equal((await w.send(message, popup)).ok, false);
  assert.equal((await w.send(message, { ...youtube, url: "https://example.com" })).ok, false);
  assert.equal((await w.send(message, youtube)).ok, true);
  assert.equal((await w.send(message, { ...youtube, tab: { id: 2 } })).ok, true);
  assert.equal((await w.send({ type: "get-patterns" }, youtube)).ok, false);
  const summary = await w.send({ type: "get-patterns", period: "today" }, popup);
  assert.equal(summary.totals.encountered, 1);
  assert.equal(w.calls.length, 0);
  assert.equal(JSON.stringify(w.local.filterPatterns).includes("privateVideoId"), false);
  assert.equal(JSON.stringify(w.session).includes("filterPatterns"), false);
});

test("predicate upgrade preserves observations and records one method-change marker", async () => {
  const f = fixture(); await f.ledger.initialize(settings, "UTC");
  await f.record([f.event("saved")]);
  const data = structuredClone(f.data);
  delete data.filterPatterns.config.classificationVersion;
  data.filterPatterns.config.confidence = .8;
  const version = data.filterPatterns.version;
  const upgraded = fixture(data); await upgraded.ledger.initialize(settings, "UTC");
  const result = await upgraded.ledger.summary("today");
  assert.equal(result.totals.encountered, 1);
  assert.equal(result.totals.keyword, 1);
  assert.equal(upgraded.ledger.value.version, version + 1);
  assert.deepEqual(Array.from(upgraded.ledger.value.changes.at(-1).fields), ["AI classification method"]);
  assert.equal("confidence" in upgraded.ledger.value.config, false);
  await upgraded.ledger.updateSettings({ ...settings, minConfidence: 1 });
  assert.equal(upgraded.ledger.value.version, version + 1, "obsolete confidence changes have no effect");
  const restarted = fixture(upgraded.data); await restarted.ledger.initialize(settings, "UTC");
  assert.equal(restarted.ledger.value.version, version + 1);
  assert.equal(restarted.ledger.value.changes.length, 1);
});
