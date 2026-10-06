import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { files, card, settle, chooseStyle } from "./helpers.mjs";

import { worker, catalog, ids, youtube, popup, answers, answerResponse, response } from "./worker-helper.mjs";

test("uses documented endpoint, Bearer key and typed payload; keeps credentials private", async () => {
  const w = worker();
  const result = await w.classify("You will never believe this!");
  assert.equal(result.results.clickbait.probability, .92);
  const [url, options] = w.calls[0];
  assert.equal(url, "https://api.openai.com/v1/decisions");
  assert.equal(options.headers.Authorization, "Bearer test-key-not-a-real-secret");
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  const payload = JSON.parse(options.body);
  assert.equal(payload.input, "You will never believe this!");
  assert.equal(payload.model, "gpt-6-luna");
  assert.deepEqual(payload.questions.map(question => question.name), ids);
  for (const id of ids) {
    assert.equal(payload.questions.find(question => question.name === id).type, "predicate");
    assert.deepEqual(Object.keys(payload.questions.find(question => question.name === id)), ["type", "name", "instructions"]);
    assert.ok(payload.questions.find(question => question.name === id).instructions.endsWith(catalog.byId[id].rubric));
  }
  assert.equal(w.accesses.local, "TRUSTED_CONTEXTS");
  assert.equal(JSON.stringify(w.session).includes(w.local.openaiApiKey), false);
  assert.equal(JSON.stringify(await w.send({ type: "get-settings" })).includes(w.local.openaiApiKey), false);
});

test("deduplicates requests and caches classification for repeated titles", async () => {
  const w = worker(async () => { await new Promise(resolve => setTimeout(resolve, 10)); return response("fear_mongering"); });
  const results = await Promise.all([w.classify(), w.classify(), w.classify()]);
  assert.ok(results.every(result => result.results.fear_mongering.probability === .92));
  assert.equal(w.calls.length, 1);
  await w.classify();
  assert.equal(w.calls.length, 1);
});

test("limits concurrency to two calls across tabs", async () => {
  let active = 0;
  let maximum = 0;
  const w = worker(async () => { active++; maximum = Math.max(maximum, active); await new Promise(resolve => setTimeout(resolve, 15)); active--; return response(); });
  await Promise.all(Array.from({ length: 8 }, (_, i) => w.classify(`Title ${i}`)));
  assert.equal(maximum, 2);
});

test("authentication failure is visible and stops repeated calls without leaking raw errors", async () => {
  const w = worker(async () => ({ ok: false, status: 401 }));
  const result = await w.classify();
  assert.equal(result.code, "auth");
  assert.match(w.session.aiStatus.error, /rejected/);
  await w.classify("Another title");
  assert.equal(w.calls.length, 1);
});

test("rate limits honor Retry-After and pause further requests", async () => {
  const w = worker(async () => ({ ok: false, status: 429, headers: new Headers({ "retry-after": "120" }) }));
  const start = Date.now();
  const result = await w.classify();
  assert.ok(result.retryAt >= start + 120000);
  await w.classify("Another title");
  assert.equal(w.calls.length, 1);
});

test("malformed results and network failures do not create a successful classification", async () => {
  for (const fetchImpl of [async () => response("unexpected"), async () => { throw new Error("private request details"); }]) {
    const w = worker(fetchImpl);
    const result = await w.classify();
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("private request details"), false);
    assert.equal(w.local.evaluationCache?.entries.length || 0, 0);
  }
});

test("rejects non-YouTube senders and disabled or missing-key requests", async () => {
  const w = worker();
  assert.equal((await w.send({ type: "classify-title", title: "a" }, { ...youtube, url: "https://example.com" })).code, "sender");
  assert.equal((await w.send({ type: "test-openai" })).code, "message");
  for (const initial of [{ aiEnabled: false }, { enabled: false }, { openaiApiKey: "" }]) {
    const disabled = worker(undefined, initial);
    assert.equal((await disabled.classify()).code, "disabled");
    assert.equal(disabled.calls.length, 0);
  }
  assert.equal(w.calls.length, 0);
});

test("replacing/removing the key invalidates cache and uses the new key", async () => {
  const w = worker();
  await w.classify();
  await w.chrome.storage.local.set({ openaiApiKey: "replacement-key" });
  await w.classify();
  assert.equal(w.calls.length, 2);
  assert.equal(w.calls[1][1].headers.Authorization, "Bearer replacement-key");
  await w.chrome.storage.local.set({ openaiApiKey: "" });
  assert.equal((await w.classify()).code, "disabled");
});

test("the popup can test a saved key without enabling automatic classification", async () => {
  const w = worker(undefined, { aiEnabled: false });
  assert.equal((await w.send({ type: "test-openai" }, popup)).ok, true);
  assert.equal(w.calls.length, 1);
});

test("removing the key aborts pending fetches and discards their results", async () => {
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  let signal;
  const w = worker(async (_url, options) => {
    signal = options.signal;
    started();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  });
  const result = w.classify();
  await pending;
  await w.chrome.storage.local.set({ openaiApiKey: "" });
  assert.equal((await result).code, "changed");
  assert.equal(signal.aborted, true);
  assert.equal(w.local.evaluationCache.entries.length, 0);
});

test("a successful key test resumes classification after an authentication failure", async () => {
  let working = false;
  const w = worker(async () => working ? response() : { ok: false, status: 401 });
  await w.classify();
  const oldRevision = (await w.send({ type: "get-settings" })).settings.aiRevision;
  working = true;
  assert.equal((await w.send({ type: "test-openai" }, popup)).ok, true);
  assert.notEqual((await w.send({ type: "get-settings" })).settings.aiRevision, oldRevision);
  assert.equal((await w.classify("A new title")).ok, true);
});

test("extracts only predicate probabilities through messages and persistent caches", async () => {
  const w = worker(async () => response("fear_mongering", { probability: .73 }));
  for (const result of [await w.classify(), await w.classify()]) {
    assert.equal(result.results.fear_mongering.probability, .73);
    assert.deepEqual(Object.keys(result.results.fear_mongering), ["probability"]);
    assert.equal(result.results.clickbait.probability, .02);
  }
  assert.equal(w.calls.length, 1);
  const restarted = worker(undefined, w.local);
  assert.equal((await restarted.classify()).results.fear_mongering.probability, .73);
  assert.equal(restarted.calls.length, 0);
  assert.deepEqual(Object.keys(w.local.evaluationCache.entries[0][1].fear_mongering), ["probability", "expires"]);
});

test("old and malformed session cache entries become misses and are reclassified", async () => {
  const fresh = worker();
  const config = (await fresh.send({ type: "get-settings" })).settings;
  for (const value of [{ label: "clickbait" }, { label: "clickbait", probability: 0.92, confidence: 0.84 },
    { schemaVersion: catalog.schemaVersion, results: { clickbait: { choice: "match", probability: 0.9, confidence: 2 } } }]) {
    const w = worker(undefined, {}, { publicSettings: config, classificationCache: [["A title", { ...value, expires: Date.now() + 60000 }]] });
    const result = await w.classify();
    assert.equal(result.results.clickbait.probability, 0.92);
    assert.equal(w.calls.length, 1);
  }
});

test("rejects missing, nonnumeric, nonfinite and out-of-range predicate probabilities without caching", async () => {
  for (const probability of [undefined, null, "0.9", NaN, Infinity, -Infinity, -.01, 1.01, {}, []]) {
    const w = worker(async () => response("clickbait", { probability }));
    assert.equal((await w.classify()).code, "response", String(probability));
    assert.equal(Object.hasOwn(w.local.evaluationCache.entries[0]?.[1] || {}, "clickbait"), false);
  }
});

test("accepts metric endpoints and changing thresholds or styles reuses cached scores", async () => {
  const w = worker(async () => response("clickbait", { probability: 0 }));
  assert.equal((await w.classify()).results.clickbait.probability, 0);
  const before = (await w.send({ type: "get-settings" })).settings.aiRevision;
  await w.chrome.storage.local.set({ aiEnabled: true, minProbability: 0.8, minConfidence: 0.9, replacementStyle: "blur" });
  const config = (await w.send({ type: "get-settings" })).settings;
  assert.notEqual(config.aiRevision, before);
  assert.equal(config.minProbability, 0.8);
  assert.equal("minConfidence" in config, false);
  assert.equal(config.replacementStyle, "blur");
  assert.equal((await w.classify()).results.clickbait.probability, 0);
  assert.equal(w.calls.length, 1);
});

test("new installs use blur for keywords and 90% match probability; saved shared styles and zero minimums survive upgrades", async () => {
  const fresh = (await worker().send({ type: "get-settings" })).settings;
  assert.equal(fresh.keywordReplacementStyle, "blur");
  assert.equal(fresh.replacementStyle, "solid");
  assert.equal(fresh.minProbability, 0.9);
  assert.equal("minConfidence" in fresh, false);
  const upgraded = worker(undefined, { replacementStyle: "grayscale", minProbability: 0, minConfidence: 0 });
  const saved = (await upgraded.send({ type: "get-settings" })).settings;
  assert.equal(saved.keywordReplacementStyle, "grayscale");
  assert.equal(saved.replacementStyle, "grayscale");
  assert.equal(saved.minProbability, 0);
  assert.equal("minConfidence" in saved, false);
  await upgraded.chrome.storage.local.set({ keywordReplacementStyle: "blur" });
  const changed = (await upgraded.send({ type: "get-settings" })).settings;
  assert.equal(changed.keywordReplacementStyle, "blur");
  assert.equal(changed.replacementStyle, "grayscale");
});

test("selected categories alone are requested; changing selection preserves scores and advances revisions", async () => {
  const w = worker(undefined, { enabledClassifiers: ["rage_bait", "clickbait"] });
  await w.classify();
  assert.deepEqual(JSON.parse(w.calls[0][1].body).questions.map(question => question.name), ["clickbait", "rage_bait"]);
  const previous = (await w.send({ type: "get-settings" })).settings.aiRevision;
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "rage_bait", "rage_bait"] });
  await w.classify();
  assert.equal(w.calls.length, 1, "equivalent selections reuse cache");
  await w.chrome.storage.local.set({ enabledClassifiers: ["miracle_cure"] });
  const config = (await w.send({ type: "get-settings" })).settings;
  assert.notEqual(config.aiRevision, previous);
  const result = await w.classify();
  assert.deepEqual(Object.keys(result.results), ["miracle_cure"]);
  assert.equal(w.calls.length, 2);
  const restarted = worker(undefined, { ...w.local, enabledClassifiers: ["engagement_bait"] });
  assert.deepEqual(Object.keys((await restarted.classify()).results), ["engagement_bait"]);
  assert.equal(restarted.calls.length, 1, "a missing category is evaluated after restart");
});

test("empty selection makes no automatic requests but the saved-key test still works", async () => {
  const w = worker(undefined, { enabledClassifiers: [] });
  assert.deepEqual(Array.from((await w.send({ type: "get-settings" })).settings.enabledClassifiers), []);
  assert.equal((await w.classify()).code, "disabled");
  assert.equal(w.calls.length, 0);
  assert.equal((await w.send({ type: "test-openai" }, popup)).ok, true);
  assert.deepEqual(JSON.parse(w.calls[0][1].body).questions.map(question => question.name), ["clickbait"]);
  assert.equal(w.local.evaluationCache.entries.length, 0, "manual tests do not pollute automatic cache");
});

test("category changes keep sent work running and discard late deliveries", async () => {
  let started, complete;
  const pending = new Promise(resolve => { started = resolve; });
  let signal;
  const w = worker(async (_url, options) => {
    signal = options.signal;
    started();
    return new Promise(resolve => { complete = resolve; });
  });
  const old = w.classify();
  await pending;
  await w.chrome.storage.local.set({ enabledClassifiers: [] });
  await w.send({ type: "get-settings" });
  assert.equal(signal.aborted, false);
  complete(response());
  assert.equal((await old).code, "changed");
  await settle();
  assert.equal(w.local.evaluationCache.entries.length, 1);
});

test("one missing or malformed answer preserves valid scores without applying a partial result", async () => {
  for (const invalid of [undefined, null, { type: "predicate", probability: 2 }, { type: "choice", choice: "match", probabilities: { match: 0.9 }, confidence: .9 }]) {
    const data = answers();
    data.artificial_urgency = invalid;
    const w = worker(async () => answerResponse(data));
    const result = await w.classify();
    assert.equal(result.ok, false);
    assert.equal(result.results, undefined);
    assert.equal(w.local.evaluationCache.entries.length, 1);
    assert.equal(Object.keys(w.local.evaluationCache.entries[0][1]).length, ids.length - 1);
  }
});


test("real popup saves propagate through the worker to separate keyword and AI page styles", async (t) => {
  const w = worker(undefined, { keywords: ["spoiler"], keywordReplacementStyle: "blur", replacementStyle: "solid" });
  const page = new JSDOM(`<!doctype html><style>${files["content.css"]}</style><body>${card("k", "spoiler")}${card("a", "AI title")}</body>`, {
    url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  const ui = new JSDOM(files["popup.html"], { url: "https://extension.test/", runScripts: "outside-only" });
  page.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: 0, bottom: 160 });
  t.after(() => { page.window.dispatchEvent(new page.window.Event("pagehide")); page.window.close(); ui.window.close(); });
  for (const [dom, sender] of [[page, youtube], [ui, popup]]) {
    dom.window.chrome = { storage: w.chrome.storage, runtime: { sendMessage: message => w.send(message, sender), connect: () => w.connect(sender) } };
    dom.window.eval(files["classifiers.js"]);
    dom.window.eval(files["keywords.js"]);
  }
  page.window.eval(files["ai-overlay.js"]);
  page.window.eval(files["content.js"]);
  ui.window.eval(files["spending.js"]);
  ui.window.eval(files["analytics.js"]);
  ui.window.eval(files["popup.js"]);
  await settle(); await settle();
  const keyword = page.window.document.querySelector('[data-card="k"] [data-yt-red-mask]');
  const ai = page.window.document.querySelector('[data-card="a"] [data-yt-red-mask]');
  assert.equal(keyword.getAttribute("data-yt-replacement-style"), "blur");
  assert.equal(ai.getAttribute("data-yt-replacement-style"), "solid");
  for (const style of ["grayscale", "placeholder", "hide", "solid", "blur"]) {
    chooseStyle(ui.window.document, "keyword", style);
    ui.window.document.querySelector('form').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
    await settle();
    assert.equal(keyword.getAttribute("data-yt-replacement-style"), style);
    assert.equal(keyword.closest('[data-card]').hasAttribute('data-yt-hide-card'), style === "hide");
    assert.equal(ai.getAttribute("data-yt-replacement-style"), "solid");
    assert.equal(w.local.replacementStyle, "solid");
  }
  chooseStyle(ui.window.document, "classifier", "hide");
  ui.window.document.querySelector('form').dispatchEvent(new ui.window.Event('submit', { cancelable: true }));
  await settle();
  assert.equal(keyword.getAttribute("data-yt-replacement-style"), "blur");
  assert.equal(ai.getAttribute("data-yt-replacement-style"), "hide");
  assert.equal(w.calls.length, 1, "style saves reuse existing classifications");
  const revision = (await w.send({ type: "get-settings" }, popup)).settings.aiRevision;
  const theme = ui.window.document.querySelector('#popup-theme');
  theme.value = "dark";
  theme.dispatchEvent(new ui.window.Event('change'));
  ui.window.document.querySelector('#save').click();
  await settle();
  const publicSettings = (await w.send({ type: "get-settings" }, popup)).settings;
  assert.equal(w.local.popupTheme, "dark");
  assert.equal(publicSettings.aiRevision, revision);
  assert.equal("popupTheme" in publicSettings, false);
  assert.equal(w.calls.length, 1, "theme saves keep cached evaluations");
});

test("legacy style migration is persisted once and later classifier changes never alter keyword style", async () => {
  const w = worker(undefined, { replacementStyle: "grayscale" });
  await w.send({ type: "get-settings" });
  assert.equal(w.local.keywordReplacementStyle, "grayscale");
  await w.chrome.storage.local.set({ replacementStyle: "hide" });
  assert.equal((await w.send({ type: "get-settings" })).settings.keywordReplacementStyle, "grayscale");
  await w.chrome.storage.local.set({ keywordReplacementStyle: "blur" });
  const restarted = worker(undefined, w.local, w.session);
  const config = (await restarted.send({ type: "get-settings" })).settings;
  assert.equal(config.keywordReplacementStyle, "blur");
  assert.equal(config.replacementStyle, "hide");
});

test("version 2 scores with identical saved categories are discarded on upgrade", async () => {
  const initial = { enabledClassifiers: ids.slice(0, 12) };
  const old = worker(undefined, initial);
  await old.classify();
  const session = structuredClone(old.session);
  session.classificationCache = [["A title", { schemaVersion: 2, results: { clickbait: { choice: "match", probability: .95, confidence: .9 } }, expires: Date.now() + 60000 }]];
  const previousRevision = session.publicSettings.aiRevision;
  session.publicSettings.classificationVersion = 2;
  for (const [, entry] of session.classificationCache) entry.schemaVersion = 2;
  const upgraded = worker(undefined, initial, session);
  const result = await upgraded.classify();
  assert.equal(result.schemaVersion, 5);
  assert.notEqual(result.aiRevision, previousRevision);
  assert.equal(upgraded.calls.length, 1);
  assert.deepEqual(Array.from(upgraded.session.publicSettings.enabledClassifiers), initial.enabledClassifiers);
});

test("version 3 Choice scores are discarded while preferences and spending history survive", async () => {
  const old = worker(undefined, { enabledClassifiers: ["clickbait"], minProbability: .87, minConfidence: .99 });
  await old.classify();
  const local = structuredClone(old.local), session = structuredClone(old.session);
  const expires = Date.now() + 60000;
  local.evaluationCache.classificationVersion = 3;
  local.evaluationCache.entries[0][1].clickbait = { choice: "match", probability: 1, confidence: 1, expires };
  session.publicSettings.classificationVersion = 3;
  session.classificationCache = [["A title", { schemaVersion: 3, expires, results: { clickbait: { choice: "match", probability: 1, confidence: 1 } } }]];
  const w = worker(undefined, local, session);
  const before = await w.send({ type: "get-analytics" }, popup);
  assert.equal(before.ledger.totals.attempts, 1);
  const result = await w.classify();
  assert.equal(result.results.clickbait.probability, .92);
  assert.notEqual(result.aiRevision, session.publicSettings.aiRevision);
  assert.equal(result.schemaVersion, 5);
  assert.equal(w.session.classificationCache, undefined);
  assert.equal(w.calls.length, 1);
  const config = (await w.send({ type: "get-settings" })).settings;
  assert.equal(config.minProbability, .87);
  assert.equal("minConfidence" in config, false);
  assert.equal((await w.send({ type: "get-analytics" }, popup)).ledger.totals.attempts, 2);
});

test("new categories alone use their rubrics and retain independent scores", async () => {
  const selected = ids.slice(12);
  const w = worker(async () => response("reaction_content"), { enabledClassifiers: selected });
  const result = await w.classify("Reacting to a performance");
  const questions = Object.fromEntries(JSON.parse(w.calls[0][1].body).questions.map(q => [q.name, q]));
  assert.deepEqual(Object.keys(questions), selected);
  assert.deepEqual(Object.keys(result.results), selected);
  assert.equal(result.results.reaction_content.probability, .92);
  for (const id of selected) {
    assert.ok(questions[id].instructions.endsWith(catalog.byId[id].rubric));
    assert.match(questions[id].instructions, /Judge title wording only/);
  }
});

test("missing or malformed new-category answers never apply partial results", async () => {
  for (const id of ids.slice(12)) {
    for (const value of [undefined, { type: "choice", choice: "match", probabilities: { match: NaN }, confidence: .9 }]) {
      const data = answers();
      data[id] = value;
      const w = worker(async () => answerResponse(data));
      assert.equal((await w.classify()).code, "response", id);
      assert.equal(Object.hasOwn(w.local.evaluationCache.entries[0]?.[1] || {}, id), false);
    }
  }
});
