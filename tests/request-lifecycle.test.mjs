import test from "node:test";
import assert from "node:assert/strict";
import { worker, response, ids, youtube } from "./worker-helper.mjs";

async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail("Condition did not become true");
}
function controlled(t, initial = {}) {
  const flights = [];
  const w = worker((_url, options) => new Promise(resolve => flights.push({ options, title: JSON.parse(options.body).state, resolve })), initial);
  t.after(() => { for (const flight of flights) flight.resolve(response()); for (const port of w.clientPorts) port.disconnect(); });
  return { w, flights };
}

test("persistent scores serve an exact title after a browser restart with no session state", async () => {
  const w = worker(undefined, { enabledClassifiers: ["clickbait", "spoilers"] });
  await w.classify("A title!");
  const restarted = worker(undefined, structuredClone(w.local));
  assert.equal((await restarted.classify("A title!")).ok, true);
  assert.equal(restarted.calls.length, 0);
  await restarted.classify("a title!");
  assert.equal(restarted.calls.length, 1, "case is retained");
});

test("adding categories requests only missing scores, while remove/re-enable is free", async () => {
  const w = worker(undefined, { enabledClassifiers: ["clickbait"] });
  await w.classify();
  const expires = w.local.evaluationCache.entries[0][1].clickbait.expires;
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "spoilers"] });
  const combined = await w.classify();
  assert.deepEqual(JSON.parse(w.calls[1][1].body).questions.map(question => question.name), ["spoilers"]);
  assert.deepEqual(Object.keys(combined.results), ["clickbait", "spoilers"]);
  assert.equal(w.local.evaluationCache.entries[0][1].clickbait.expires, expires);
  await w.chrome.storage.local.set({ enabledClassifiers: ["spoilers"] });
  assert.deepEqual(Object.keys((await w.classify()).results), ["spoilers"]);
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "spoilers"] });
  await w.classify();
  assert.equal(w.calls.length, 2);
});

test("only expired scores are requested again", async () => {
  const w = worker(undefined, { enabledClassifiers: ["clickbait", "spoilers"] });
  await w.classify();
  const local = structuredClone(w.local);
  local.evaluationCache.entries[0][1].clickbait.expires = Date.now() - 1;
  const restarted = worker(undefined, local);
  assert.equal((await restarted.classify()).ok, true);
  assert.deepEqual(JSON.parse(restarted.calls[0][1].body).questions.map(question => question.name), ["clickbait"]);
});

test("both pause switches retain completed scores without extending expiry", async () => {
  const w = worker(); await w.classify();
  const stored = structuredClone(w.local.evaluationCache);
  for (const key of ["enabled", "aiEnabled"]) {
    await w.chrome.storage.local.set({ [key]: false });
    assert.equal((await w.classify()).code, "disabled");
    await w.chrome.storage.local.set({ [key]: true });
    assert.equal((await w.classify()).ok, true);
  }
  assert.equal(w.calls.length, 1);
  assert.deepEqual(structuredClone(w.local.evaluationCache), stored);
});

test("pause discards queued jobs but lets sent requests finish and cache", async t => {
  const { w, flights } = controlled(t);
  const first = await w.subscribe("first"), second = await w.subscribe("second");
  await until(() => flights.length === 2);
  const queued = await w.subscribe("queued");
  await w.chrome.storage.local.set({ enabled: false }); await w.send({ type: "get-settings" });
  assert.equal((await queued.result).code, "changed");
  assert.equal((await first.result).code, "changed");
  assert.equal((await second.result).code, "changed");
  assert.ok(flights.every(flight => !flight.options.signal.aborted));
  for (const flight of flights) flight.resolve(response());
  await until(() => w.local.evaluationCache.entries.length === 2);
  await w.chrome.storage.local.set({ enabled: true });
  assert.equal((await w.classify("first")).ok, true);
  assert.equal(flights.length, 2);
});

test("new selections wait for a sent title request and then ask only missing questions", async t => {
  const { w, flights } = controlled(t, { enabledClassifiers: ["clickbait"] });
  const old = await w.subscribe(); await until(() => flights.length === 1);
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "spoilers"] });
  const next = await w.subscribe();
  assert.equal((await old.result).code, "changed");
  assert.equal(flights.length, 1);
  flights[0].resolve(response()); await until(() => flights.length === 2);
  assert.deepEqual(JSON.parse(flights[1].options.body).questions.map(question => question.name), ["spoilers"]);
  flights[1].resolve(response());
  assert.deepEqual(Object.keys((await next.result).results), ["clickbait", "spoilers"]);
});

for (const reason of ["cancel", "disconnect", "keyword", "irrelevant"]) {
  test(`obsolete queued work is discarded for ${reason} without spending tokens`, async t => {
    const { w, flights } = controlled(t);
    const a = await w.subscribe("first"), b = await w.subscribe("second");
    await until(() => flights.length === 2);
    let relevant = true;
    const queued = await w.subscribe("obsolete", { relevant: () => relevant });
    if (reason === "cancel") queued.cancel();
    if (reason === "disconnect") queued.port.disconnect();
    if (reason === "keyword") { await w.chrome.storage.local.set({ keywords: ["obsolete"] }); await w.send({ type: "get-settings" }); }
    if (reason === "irrelevant") relevant = false;
    flights[0].resolve(response()); flights[1].resolve(response());
    await Promise.all([a.result, b.result]);
    if (reason !== "disconnect") assert.equal((await queued.result).ok, false);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(flights.length, 2);
  });
}

test("one subscriber cancelling does not cancel another tab/frame needing the same title", async t => {
  const { w, flights } = controlled(t);
  const a = await w.subscribe("shared", { sender: { ...youtube, frameId: 0 } });
  const b = await w.subscribe("shared", { sender: { ...youtube, tab: { id: 2 }, frameId: 3 } });
  await until(() => flights.length === 1);
  a.cancel(); assert.equal((await a.result).code, "cancelled");
  assert.equal(flights[0].options.signal.aborted, false);
  flights[0].resolve(response());
  assert.equal((await b.result).ok, true);
  assert.equal(flights.length, 1);
});

test("relevance timeout defers without an API call or global backoff", async () => {
  const w = worker();
  const unconfirmed = await w.subscribe("slow", { relevant: () => undefined });
  const result = await unconfirmed.result;
  assert.equal(result.code, "deferred");
  assert.ok(result.retryAt > Date.now());
  assert.equal(w.calls.length, 0);
  assert.equal(w.session.aiStatus, undefined);
  assert.equal((await w.classify("normal")).ok, true);
  assert.equal(w.calls.length, 1);
});

test("credential replacement blocks late cache writes even when the server ignores abort", async t => {
  const { w, flights } = controlled(t);
  const old = await w.subscribe(); await until(() => flights.length === 1);
  await w.chrome.storage.local.set({ openaiApiKey: "replacement" }); await w.send({ type: "get-settings" });
  assert.equal(flights[0].options.signal.aborted, true);
  flights[0].resolve(response()); assert.equal((await old.result).code, "changed");
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(w.local.evaluationCache.entries.length, 0);
  const next = await w.subscribe(); await until(() => flights.length === 2);
  flights[1].resolve(response()); assert.equal((await next.result).ok, true);
  assert.equal(flights[1].options.headers.Authorization, "Bearer replacement");
});

test("obsolete plaintext session scores are discarded; valid new scores persist before plaintext removal", async () => {
  const expires = Date.now() + 60000;
  const session = { publicSettings: { classificationVersion: 5, enabledClassifiers: ["clickbait"] },
    classificationCache: [["Legacy readable title", { schemaVersion: 5, expires, results: { clickbait: { probability: .95 } } }]] };
  let fail = true;
  const w = worker(undefined, { enabledClassifiers: ["clickbait"] }, session, { beforeCacheWrite: async () => { if (fail) throw new Error("quota"); } });
  assert.equal((await w.classify("Legacy readable title")).ok, true);
  assert.equal(w.calls.length, 1);
  assert.equal(w.session.classificationCache.length, 1);
  assert.match(w.session.cacheStatus.error, /could not be saved/);
  fail = false;
  // A restart retries migration and removes the old entries after the write succeeds.
  const restarted = worker(undefined, w.local, w.session);
  assert.equal((await restarted.classify("Legacy readable title")).ok, true);
  assert.equal(restarted.calls.length, 1, "failed persistence requires fresh classification after restart");
  assert.equal(restarted.session.classificationCache, undefined);
  assert.equal(JSON.stringify(restarted.local.evaluationCache).includes("Legacy readable title"), false);
});

test("failed cache writes do not discard new scores or immediately reclassify", async () => {
  const w = worker(undefined, {}, {}, { beforeCacheWrite: async () => { throw new Error("quota"); } });
  assert.equal((await w.classify()).ok, true);
  assert.equal((await w.classify()).ok, true);
  assert.equal(w.calls.length, 1);
  assert.match(w.session.cacheStatus.error, /could not be saved/);
});

test("foreign senders cannot open the classification channel", async () => {
  const w = worker(); await w.send({ type: "get-settings" });
  for (const sender of [{ ...youtube, url: "https://example.com" }, { ...youtube, id: "another-extension" }, { id: youtube.id, url: youtube.url }]) {
    const port = w.connect(sender);
    assert.throws(() => port.postMessage({ type: "subscribe", requestId: "bad", title: "title" }), /Disconnected/);
  }
  assert.equal(w.calls.length, 0);
});

test("legacy scores without an expiry are rejected rather than renewed during migration", async () => {
  const w = worker(undefined, { enabledClassifiers: ["clickbait"] }, {
    publicSettings: { classificationVersion: 3, enabledClassifiers: ["clickbait"] },
    classificationCache: [["A title", { schemaVersion: 3, results: { clickbait: { choice: "match", probability: .95, confidence: .9 } } }]]
  });
  assert.equal((await w.classify()).ok, true);
  assert.equal(w.calls.length, 1);
});
