import test from "node:test";
import assert from "node:assert/strict";
import { popupFixture, settle, classifiers } from "./helpers.mjs";

function data() {
  return { ok: true, totals: { encountered: 10, filtered: 5, keyword: 3, ai: 2, clear: 1, pending: 1, unavailable: 1, unchecked: 2,
    keywords: { crypto: 3, reaction: 2 }, categories: Object.fromEntries(classifiers.ids.map(id => [id, { evaluated: id === "clickbait" || id === "rage_bait" ? 3 : 0, qualified: id === "clickbait" ? 2 : id === "rage_bait" ? 1 : 0, shown: id === "clickbait" ? 2 : 0 }])) },
    daily: [{ day: "2026-09-21", count: 3, denominator: 7, changes: [] }, { day: "2026-09-22", count: 2, denominator: 3, changes: [{ at: 0, fields: ["Keywords", "Probability threshold"] }] }],
    keywords: ["crypto", "reaction"], comparison: { available: true, days: 2, current: { count: 5, denominator: 10 }, previous: { count: 2, denominator: 10 } },
    startedAt: Date.parse("2026-08-01T12:00:00Z"), timeZone: "America/New_York", retentionDays: 90 };
}

test("pattern panels show distinct rate, overlapping keyword shares, category denominators, trends and markers", async t => {
  const { document } = await popupFixture(t, {}, { patterns: data() });
  document.querySelector('#analytics-tab').click(); await settle();
  assert.equal(document.querySelector('#pattern-rate').textContent, "50.0%");
  assert.match(document.querySelector('#pattern-rate-caption').textContent, /5 of 10 distinct/);
  assert.match(document.querySelector('#pattern-outcomes').textContent, /1 pending · 1 unavailable · 2 AI not evaluated/);
  assert.match(document.querySelector('#pattern-keywords').textContent, /crypto3100.0%/);
  assert.match(document.querySelector('#pattern-keywords').textContent, /reaction266.7%/);
  assert.match(document.querySelector('#pattern-categories').textContent, /Clickbait2 \/ 3266.7%/);
  assert.equal(document.querySelectorAll('.pattern-change-dot').length, 1);
  assert.match(document.querySelector('#pattern-daily').textContent, /Probability threshold/);
  assert.match(document.querySelector('#pattern-comparison').textContent, /\+30.0 percentage points/);
  assert.match(document.querySelector('#pattern-chart-scale').textContent, /0–100%/);
});

test("period and pattern controls remain read-only and preserve settings drafts", async t => {
  const { document, window, storage } = await popupFixture(t, {}, { patterns: data() });
  const input = document.querySelector('#keyword-add'); input.value = "draft keyword"; input.dispatchEvent(new window.Event("input", { bubbles: true }));
  document.querySelector('#analytics-tab').click(); await settle();
  const messages = [], original = window.chrome.runtime.sendMessage;
  window.chrome.runtime.sendMessage = async message => { messages.push(message); return original(message); };
  const period = document.querySelector('#pattern-period'); period.value = "30days"; period.dispatchEvent(new window.Event("change")); await settle();
  const metric = document.querySelector('#pattern-metric'); metric.value = "category:clickbait"; metric.dispatchEvent(new window.Event("change")); await settle();
  const mode = document.querySelector('#pattern-mode'); mode.value = "count"; mode.dispatchEvent(new window.Event("change"));
  assert.ok(messages.some(message => message.type === "get-patterns" && message.period === "30days" && message.metric === "category:clickbait"));
  assert.match(document.querySelector('#pattern-chart-scale').textContent, /Count scale/);
  assert.equal(input.value, "draft keyword");
  assert.equal(storage.values.keywords, undefined);
  assert.equal(document.querySelector('#analytics-tab .draft-dot'), null);
});

test("empty and incomplete pattern history is honest, and keyword labels are rendered as text", async t => {
  const malicious = data(); malicious.totals.keywords = { '<img src=x onerror=alert(1)>': 1 }; malicious.warning = "Could not save"; malicious.truncated = true;
  const { document } = await popupFixture(t, {}, { patterns: malicious });
  document.querySelector('#analytics-tab').click(); await settle();
  assert.equal(document.querySelector('#pattern-keywords img'), null);
  assert.match(document.querySelector('#pattern-warning').textContent, /Could not save.*incomplete/);
  const empty = await popupFixture(t);
  empty.document.querySelector('#analytics-tab').click(); await settle();
  assert.equal(empty.document.querySelector('#pattern-rate').textContent, "—");
  assert.match(empty.document.querySelector('#pattern-keywords').textContent, /No keyword matches/);
  assert.match(empty.document.querySelector('#pattern-categories').textContent, /No AI evaluations/);
});
