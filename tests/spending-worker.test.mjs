import test from "node:test";
import assert from "node:assert/strict";
import { worker, popup, youtube, answers, response } from "./worker-helper.mjs";

const totals = async w => (await w.send({ type: "get-analytics" }, popup)).ledger.totals;
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail("Timed out waiting for accounting");
}

test("shared work is charged once; cache hits and keyword matches add no attempts", async () => {
  const started = deferred(), release = deferred();
  const w = worker(async () => { started.resolve(); await release.promise; return response(); });
  const a = w.classify("Shared title"), b = w.classify("Shared title");
  await started.promise;
  assert.equal(Object.keys(w.local.spendingLedger.pending).length, 1, "journal is durable before fetch");
  release.resolve(); await Promise.all([a, b]);
  await w.classify("Shared title");
  await w.chrome.storage.local.set({ keywords: ["keyword"] });
  await w.classify("keyword title");
  assert.equal(w.calls.length, 1);
  assert.equal((await totals(w)).attempts, 1);
  assert.equal((await totals(w)).costNanodollars, 100000);
});

test("concurrent calls and new categories count once each while cached categories remain free", async () => {
  const w = worker(undefined, { enabledClassifiers: ["clickbait"] });
  await Promise.all([w.classify("One"), w.classify("Two")]);
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "spoilers"] });
  await w.classify("One");
  assert.deepEqual(JSON.parse(w.calls[2][1].body).questions.map(question => question.name), ["spoilers"]);
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait"] }); await w.classify("One");
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "spoilers"] }); await w.classify("One");
  assert.equal((await totals(w)).attempts, 3);
  assert.equal((await totals(w)).costNanodollars, 300000);
});

test("key tests count, and history survives keys, pause, cache removal and worker restarts", async () => {
  const w = worker(undefined, { aiEnabled: false });
  await w.send({ type: "test-openai" }, popup);
  assert.equal((await totals(w)).tests, 1);
  await w.chrome.storage.local.set({ openaiApiKey: "new-key", aiEnabled: true });
  await w.classify("A title");
  await w.chrome.storage.local.set({ enabled: false });
  await w.chrome.storage.local.remove("evaluationCache");
  await w.chrome.storage.local.set({ openaiApiKey: "", aiEnabled: false });
  const snapshot = await w.send({ type: "get-analytics" }, popup);
  const restarted = worker(undefined, structuredClone(w.local));
  assert.equal((await totals(restarted)).costNanodollars, 200000);
  assert.equal((await totals(restarted)).tests, 1);
  assert.equal((await restarted.send({ type: "get-analytics" }, popup)).ledger.startedAt, snapshot.ledger.startedAt);
  assert.equal(restarted.calls.length, 0);
});

test("classification errors and HTTP errors still record valid returned usage", async () => {
  for (const fetch of [async () => response("unexpected"), async () => ({ ok: false, status: 422, json: async () => ({
    model: "gpt-6-luna", usage: { input_tokens: 1000, output_tokens: 20 }
  }) })]) {
    const w = worker(fetch);
    assert.equal((await w.classify()).ok, false);
    assert.equal((await totals(w)).costNanodollars, 100000);
    assert.equal((await totals(w)).unresolved, 0);
  }
});

test("missing usage and unknown pricing do not reject otherwise valid classifications", async () => {
  for (const [metadata, field] of [[{}, "unresolved"], [{ model: "future-model", usage: { input_tokens: 1000, output_tokens: 20 } }, "unpriced"]]) {
    const w = worker(async () => ({ ok: true, json: async () => ({ answers: answers(), ...metadata }) }));
    assert.equal((await w.classify()).ok, true);
    assert.equal((await totals(w))[field], 1);
    assert.equal((await totals(w)).costNanodollars, 0);
    await w.classify();
    assert.equal(w.calls.length, 1);
  }
});

test("network loss and timeouts are unresolved attempts, and later retries are separate", async () => {
  let tries = 0;
  const w = worker(async () => { if (++tries === 1) throw new Error("network"); return response(); });
  assert.equal((await w.classify()).ok, false);
  await w.send({ type: "test-openai" }, popup);
  await w.classify();
  assert.equal((await totals(w)).attempts, 3);
  assert.equal((await totals(w)).unresolved, 1);
  assert.equal((await totals(w)).costNanodollars, 200000);
  const timed = worker(async (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("abort")))), {}, {}, { timeoutMs: 5 });
  assert.equal((await timed.classify()).ok, false);
  assert.equal((await totals(timed)).unresolved, 1);
});

test("late responses after key replacement still account for old-key usage", async () => {
  const started = deferred(), release = deferred();
  const w = worker(async () => { started.resolve(); await release.promise; return response(); });
  const request = w.classify(); await started.promise;
  await w.chrome.storage.local.set({ openaiApiKey: "replacement" });
  await request;
  release.resolve();
  await until(async () => (await totals(w)).attempts === 1);
  assert.equal((await totals(w)).costNanodollars, 100000);
  assert.equal(w.local.evaluationCache.entries.length, 0);
});

test("cancellation during journal persistence never sends or charges an obsolete request", async () => {
  const started = deferred(), release = deferred();
  const w = worker(undefined, {}, {}, { beforeSpendingWrite: async patch => {
    if (Object.keys(patch.spendingLedger.pending).length) { started.resolve(); await release.promise; }
  } });
  const request = await w.subscribe(); await started.promise;
  request.cancel(); await request.result;
  release.resolve();
  await until(async () => Object.keys((await w.send({ type: "get-analytics" }, popup)).ledger.pending).length === 0);
  assert.equal(w.calls.length, 0);
  assert.equal((await totals(w)).attempts, 0);
});

test("storage failures expose live unsaved totals without breaking classification", async () => {
  let fail = false;
  const w = worker(undefined, {}, {}, { beforeSpendingWrite: async () => { if (fail) throw new Error("quota"); } });
  await w.send({ type: "get-settings" }); fail = true;
  assert.equal((await w.classify()).ok, true);
  const live = await w.send({ type: "get-analytics" }, popup);
  assert.equal(live.ledger.totals.costNanodollars, 100000);
  assert.match(live.warning, /could not be saved/);
  assert.equal(w.local.spendingLedger.totals.costNanodollars, 0);
  fail = false; await w.classify("Another title");
  assert.equal(w.local.spendingLedger.totals.costNanodollars, 200000);
  assert.equal((await w.send({ type: "get-analytics" }, popup)).warning, "");
});

test("analytics is popup-only and billing data is absent from public settings and cache", async () => {
  const w = worker(); const classification = await w.classify("Private title");
  assert.equal((await w.send({ type: "get-analytics" }, youtube)).ok, false);
  assert.equal((await w.send({ type: "get-analytics" }, { ...popup, url: "https://example.com" })).ok, false);
  for (const data of [classification, w.session, w.local.evaluationCache, await w.send({ type: "get-settings" })]) {
    const text = JSON.stringify(data);
    assert.equal(text.includes("costNanodollars"), false);
    assert.equal(text.includes("input_tokens"), false);
    assert.equal(text.includes("spendingLedger"), false);
  }
  assert.equal(JSON.stringify(w.local.spendingLedger).includes("Private title"), false);
  assert.equal(JSON.stringify(w.local.spendingLedger).includes(w.local.openaiApiKey), false);
});

test("malformed model metadata stays unpriced without blocking valid predicate answers or future requests", async () => {
  for (const model of [null, {}, { toString: null }, ["gpt-6-luna"]]) {
    const w = worker(async () => ({ ok: true, json: async () => ({
      answers: answers(), model, usage: { input_tokens: 1000, output_tokens: 20 }
    }) }));
    assert.equal((await w.classify("First")).ok, true);
    assert.equal((await w.classify("Second")).ok, true);
    assert.equal(w.calls.length, 2);
    const recorded = await totals(w);
    assert.equal(recorded.inputTokens, 2000);
    assert.equal(recorded.outputTokens, 40);
    assert.equal(recorded.unpriced, 2);
    assert.equal(recorded.unresolved, 0);
    assert.equal(recorded.costNanodollars, 0);
  }
});
