import test from "node:test";
import assert from "node:assert/strict";
import { popupFixture, settle } from "./helpers.mjs";

test("Analytics is a third keyboard-accessible tab and preserves independent settings drafts", async t => {
  const { document, window, storage } = await popupFixture(t);
  const keywords = document.querySelector("#keywords-tab"), classifiers = document.querySelector("#classifiers-tab"), analytics = document.querySelector("#analytics-tab");
  assert.equal(document.querySelectorAll('[role="tab"]').length, 3);
  assert.equal(analytics.querySelector(".draft-dot"), null);
  document.querySelector("#keyword-add").value = "unfinished";
  document.querySelector("#keyword-add").dispatchEvent(new window.Event("input"));
  keywords.dispatchEvent(new window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert.equal(document.activeElement, analytics);
  assert.equal(document.querySelector("#analytics-panel").hidden, false);
  await settle();
  assert.equal(document.querySelector("#spend-today").textContent, "$0.000000");
  assert.equal(document.querySelector("#save").disabled, false);
  analytics.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
  assert.equal(document.activeElement, classifiers);
  classifiers.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(document.activeElement, analytics);
  analytics.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert.equal(document.activeElement, keywords);
  assert.equal(document.querySelector("#keyword-add").value, "unfinished");
  assert.equal(storage.values.keywords, undefined);
});

test("live usage updates do not dirty settings, and Discard does not reset totals", async t => {
  const { document, window, storage } = await popupFixture(t);
  document.querySelector("#analytics-tab").click(); await settle();
  const ledger = window.ThumbnailSpending.create();
  ledger.totals = { ...ledger.totals, attempts: 1, inputTokens: 1, costNanodollars: 42 };
  ledger.days[window.ThumbnailSpending.dayAt(Date.now(), ledger.timeZone)] = { ...ledger.totals };
  await storage.api.local.set({ spendingLedger: ledger }); await settle();
  assert.equal(document.querySelector("#spend-all").textContent, "<$0.000001");
  assert.equal(document.querySelector("#spend-all").title, "$0.000000042");
  assert.equal(document.querySelector("#save").disabled, true);
  document.querySelector("#keyword-add").value = "draft";
  document.querySelector("#keyword-add").dispatchEvent(new window.Event("input"));
  document.querySelector("#discard").click();
  assert.equal(document.querySelector("#spend-all").textContent, "<$0.000001");
  assert.equal(storage.values.spendingLedger.totals.costNanodollars, 42);
  assert.match(document.querySelector("#analytics-start").textContent, /Tracking since/);
  assert.match(document.querySelector("#analytics-zone").textContent, /Calendar time zone/);
});

test("pending, unresolved, unknown-price and persistence notices remain visible", async t => {
  const { document, window, storage } = await popupFixture(t, {}, { analyticsWarning: "Spending history could not be saved." });
  const ledger = window.ThumbnailSpending.create();
  ledger.totals = { ...ledger.totals, attempts: 3, unresolved: 2, unpriced: 1 };
  ledger.pending.waiting = { startedAt: Date.now(), kind: "test" };
  ledger.days[window.ThumbnailSpending.dayAt(Date.now(), ledger.timeZone)] = { ...ledger.totals };
  await storage.api.local.set({ spendingLedger: ledger });
  document.querySelector("#analytics-tab").click(); await settle();
  const warning = document.querySelector("#analytics-warning");
  assert.equal(warning.hidden, false);
  assert.match(warning.textContent, /could not be saved/);
  assert.match(warning.textContent, /Unresolved usage: 2 attempts/);
  assert.match(warning.textContent, /Unpriced usage: 1 attempt/);
  assert.match(warning.textContent, /1 pending/);
  assert.match(document.querySelector("#analytics-period-details").textContent, /Key tests \(included\)/);
});

test("failed refresh preserves prior totals and reports they may be stale", async t => {
  const { document, window } = await popupFixture(t);
  document.querySelector("#analytics-tab").click(); await settle();
  window.chrome.runtime.sendMessage = async () => { throw new Error("disconnected"); };
  await window.ThumbnailAnalytics.refresh();
  assert.equal(document.querySelector("#spend-all").textContent, "$0.000000");
  assert.match(document.querySelector("#analytics-status").textContent, /out of date/);
});

test("Analytics refreshes calendar periods on focus without recording new usage", async t => {
  const { document, window, storage } = await popupFixture(t);
  let now = Date.parse("2026-09-30T23:59:59Z");
  const RealDate = window.Date;
  window.Date = class extends RealDate { static now() { return now; } };
  const ledger = window.ThumbnailSpending.create(now, "UTC");
  ledger.totals = { ...ledger.totals, attempts: 1, inputTokens: 1000, costNanodollars: 42000 };
  ledger.days["2026-09-30"] = { ...ledger.totals };
  await storage.api.local.set({ spendingLedger: ledger });
  document.querySelector("#analytics-tab").click(); await settle();
  assert.equal(document.querySelector("#spend-today").textContent, "$0.000042");
  now = Date.parse("2026-10-01T00:00:01Z");
  window.dispatchEvent(new window.Event("focus")); await settle();
  assert.equal(document.querySelector("#spend-today").textContent, "$0.000000");
  assert.equal(document.querySelector("#spend-month").textContent, "$0.000000");
  assert.equal(document.querySelector("#spend-week").textContent, "$0.000042");
  assert.equal(document.querySelector("#spend-all").textContent, "$0.000042");
  assert.equal(storage.values.spendingLedger.totals.attempts, 1);
});
