import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../extension/spending.js", import.meta.url), "utf8");
const context = vm.createContext({ structuredClone });
vm.runInContext(source, context);
const { SpendingLedger, create, summarize, formatCost, dayAt } = context.ThumbnailSpending;
const usage = (input = 1000, output = 20, model = "gpt-6-luna") => ({ model, usage: { input_tokens: input, output_tokens: output } });
function fixture(initial = {}, options = {}) {
  let now = Date.parse("2026-09-23T16:00:00Z"), fail = false;
  const data = structuredClone(initial);
  const storage = {
    get: async defaults => { if (options.readFailure) throw new Error("unavailable"); return { ...defaults, ...data }; },
    set: async patch => { if (fail) throw new Error("quota"); Object.assign(data, structuredClone(patch)); }
  };
  const ledger = new SpendingLedger(storage, { now: () => now, timeZone: "America/New_York", ...options });
  return { ledger, data, time: date => { now = Date.parse(date); }, fail: value => { fail = value; }, summary: () => summarize(ledger.value, now) };
}

test("reported tokens produce exact nanodollar totals, with free output and no rounding per attempt", async () => {
  const f = fixture(); await f.ledger.initialize();
  await f.ledger.begin("first"); await f.ledger.complete("first", usage());
  assert.equal(f.summary().periods.today.costNanodollars, 100000);
  assert.equal(formatCost(42000), "$0.000042");
  await Promise.all(Array.from({ length: 100 }, async (_, i) => {
    await f.ledger.begin(`small-${i}`); await f.ledger.complete(`small-${i}`, usage(1, 5000));
  }));
  assert.equal(f.data.spendingLedger.totals.costNanodollars, 110000);
  assert.equal(f.data.spendingLedger.totals.attempts, 101);
  assert.equal(f.data.spendingLedger.totals.inputTokens, 1100);
  assert.equal(f.data.spendingLedger.totals.outputTokens, 500020);
  assert.equal(formatCost(42), "<$0.000001");
  assert.equal(formatCost(0), "$0.000000");
  assert.equal(formatCost(4200000000000), "$4200.000000");
  assert.equal(f.data.spendingLedger.rates["gpt-6-luna-decisions@2026-10-06"].input, 100);
});

test("completion is idempotent and cancellation of an unsent attempt removes the journal", async () => {
  const f = fixture(); await f.ledger.initialize();
  await f.ledger.begin("test", "test");
  assert.equal(f.summary().periods.all.pending, 1);
  assert.equal(f.summary().periods.all.tests, 1);
  await Promise.all([f.ledger.complete("test", usage()), f.ledger.complete("test", usage())]);
  await f.ledger.begin("cancel"); await f.ledger.cancel("cancel"); await f.ledger.complete("cancel", usage());
  assert.equal(f.data.spendingLedger.totals.attempts, 1);
  assert.equal(f.data.spendingLedger.totals.tests, 1);
  assert.equal(f.summary().periods.all.pending, 0);
});

test("restarting converts pending attempts to unresolved exactly once", async () => {
  const f = fixture(); await f.ledger.initialize();
  await f.ledger.begin("interrupted", "test");
  const restarted = fixture(f.data); await restarted.ledger.initialize();
  assert.equal(restarted.summary().periods.all.unresolved, 1);
  assert.equal(restarted.summary().periods.all.attempts, 1);
  assert.equal(restarted.summary().periods.all.tests, 1);
  assert.equal(restarted.summary().periods.all.pending, 0);
  await restarted.ledger.complete("interrupted", usage());
  const again = fixture(restarted.data); await again.ledger.initialize();
  assert.equal(again.summary().periods.all.unresolved, 1);
  assert.equal(again.summary().periods.all.costNanodollars, 0);
});

test("unknown models preserve tokens as unpriced, malformed usage is unresolved", async () => {
  const f = fixture(); await f.ledger.initialize();
  await f.ledger.begin("unknown"); await f.ledger.complete("unknown", usage(1000, 20, "future-model"));
  assert.equal(f.summary().periods.all.unpriced, 1);
  for (const [i, value] of [undefined, {}, usage(-1), usage(1.5), usage(NaN), usage(Infinity), usage("1000"), usage(1, null)].entries()) {
    await f.ledger.begin(`invalid-${i}`); await f.ledger.complete(`invalid-${i}`, value);
  }
  assert.equal(f.summary().periods.all.unresolved, 8);
  assert.equal(f.summary().periods.all.costNanodollars, 0);
  await f.ledger.begin("zero"); await f.ledger.complete("zero", usage(0, 0));
  assert.equal(f.summary().periods.all.unresolved, 8);
});

test("calendar periods use a saved local time zone, Monday weeks, and calendar months", () => {
  const ledger = create(Date.parse("2026-08-01T12:00:00Z"), "America/New_York");
  for (const day of ["2026-08-31", "2026-09-01", "2026-09-20", "2026-09-21", "2026-09-23"]) {
    ledger.days[day] = { ...ledger.totals, attempts: 1, inputTokens: 1000, costNanodollars: 42000 };
  }
  ledger.totals = { ...ledger.totals, attempts: 5, inputTokens: 5000, costNanodollars: 210000 };
  const { periods } = summarize(ledger, Date.parse("2026-09-24T03:59:59Z"));
  assert.equal(periods.today.attempts, 1);
  assert.equal(periods.week.attempts, 2);
  assert.equal(periods.month.attempts, 4);
  assert.equal(periods.all.attempts, 5);
  assert.equal(summarize(ledger, Date.parse("2026-09-24T04:00:00Z")).periods.today.attempts, 0);
  assert.equal(summarize(ledger, Date.parse("2026-09-28T04:00:00Z")).periods.week.attempts, 0);
  assert.equal(summarize(ledger, Date.parse("2026-10-01T04:00:00Z")).periods.month.attempts, 0);
});

test("DST, leap days and year-crossing weeks use calendar arithmetic", () => {
  for (const [time, day] of [
    ["2026-03-08T05:00:00Z", "2026-03-08"], ["2026-03-09T03:59:59Z", "2026-03-08"],
    ["2026-11-01T04:00:00Z", "2026-11-01"], ["2026-11-02T04:59:59Z", "2026-11-01"],
    ["2028-03-01T04:59:59Z", "2028-02-29"]
  ]) assert.equal(dayAt(Date.parse(time), "America/New_York"), day);
  const ledger = create(Date.parse("2026-12-28T12:00:00Z"), "America/New_York");
  ledger.days["2026-12-28"] = { ...ledger.totals, attempts: 1 };
  ledger.days["2027-01-01"] = { ...ledger.totals, attempts: 2 };
  ledger.totals.attempts = 3;
  const result = summarize(ledger, Date.parse("2027-01-01T17:00:00Z"));
  assert.equal(result.periods.week.attempts, 3);
  assert.equal(result.periods.month.attempts, 2);
  assert.equal(result.periods.today.attempts, 2);
});

test("request start dates survive midnight and retention never discards lifetime totals", async () => {
  const f = fixture(); f.time("2026-08-31T23:00:00Z"); await f.ledger.initialize();
  await f.ledger.begin("august"); await f.ledger.complete("august", usage());
  f.time("2026-10-01T03:59:59Z"); await f.ledger.begin("september");
  f.time("2026-10-01T04:00:01Z"); await f.ledger.complete("september", usage());
  assert.equal(f.summary().periods.today.attempts, 0);
  assert.equal(f.summary().periods.month.attempts, 0);
  assert.equal(f.summary().periods.week.attempts, 1);
  assert.equal(f.summary().periods.all.attempts, 2);
  assert.deepEqual(Object.keys(f.data.spendingLedger.days), ["2026-09-30"]);
  f.time("2026-11-01T17:00:00Z"); await f.ledger.persist();
  assert.equal(Object.keys(f.data.spendingLedger.days).length, 0);
  assert.equal(f.summary().periods.all.costNanodollars, 200000);
});

test("saved time zone and historical costs survive new rates and browser time-zone changes", async () => {
  const f = fixture(); await f.ledger.initialize(); await f.ledger.begin("old"); await f.ledger.complete("old", usage());
  const updated = fixture(f.data, { timeZone: "Asia/Tokyo", prices: { "gpt-6-luna": { id: "new-price", model: "gpt-6-luna", input: 84, output: 1 } } });
  await updated.ledger.initialize(); await updated.ledger.begin("new"); await updated.ledger.complete("new", usage());
  assert.equal(updated.summary().timeZone, "America/New_York");
  assert.equal(updated.summary().periods.all.costNanodollars, 184020);
  assert.equal(Object.keys(updated.data.spendingLedger.rates).length, 2);
});

test("failed writes keep live totals and a later write recovers without duplicate charges", async () => {
  const f = fixture(); await f.ledger.initialize(); f.fail(true);
  await f.ledger.begin("unsaved"); await f.ledger.complete("unsaved", usage());
  assert.equal(f.summary().periods.all.costNanodollars, 100000);
  assert.equal(f.data.spendingLedger.totals.costNanodollars, 0);
  assert.match(f.ledger.snapshot().warning, /could not be saved/);
  f.fail(false); await f.ledger.persist();
  assert.equal(f.data.spendingLedger.totals.costNanodollars, 100000);
  assert.equal(f.ledger.snapshot().warning, "");
});

test("invalid or unreadable history is preserved instead of overwritten", async () => {
  for (const options of [{}, { readFailure: true }]) {
    const f = fixture({ spendingLedger: { format: 999, important: "preserve" } }, options);
    await f.ledger.initialize(); await f.ledger.begin("memory"); await f.ledger.complete("memory", usage());
    assert.match(f.ledger.snapshot().warning, /session-only/);
    assert.equal(f.data.spendingLedger.important, "preserve");
    assert.equal(f.summary().periods.all.costNanodollars, 100000);
  }
});

test("metadata cannot store titles, keys or arbitrary response properties", async () => {
  const f = fixture(); await f.ledger.initialize(); await f.ledger.begin("safe");
  await f.ledger.complete("safe", { ...usage(), title: "private-title", apiKey: "private-key", other: "private-data" });
  assert.equal(JSON.stringify(f.data).includes("private-"), false);
});

test("Decisions long-context input pricing applies only above 272,000 tokens and output remains free", async () => {
  const f = fixture(); await f.ledger.initialize();
  await f.ledger.begin("boundary"); await f.ledger.complete("boundary", usage(272000, 5000));
  assert.equal(f.summary().periods.all.costNanodollars, 27200000);
  await f.ledger.begin("long"); await f.ledger.complete("long", usage(272001, 5000));
  assert.equal(f.summary().periods.all.costNanodollars, 27200000 + 272001 * 200);
  assert.equal(f.data.spendingLedger.rates["gpt-6-luna-decisions@2026-10-06-long"].input, 200);
});
