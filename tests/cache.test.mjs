import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const sources = await Promise.all(["classifiers.js", "evaluation-cache.js"].map(name => readFile(new URL(`../extension/${name}`, import.meta.url), "utf8")));
function fixture(initial = {}, beforeWrite = async () => {}) {
  let now = Date.now(), errors = 0;
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, structuredClone, Date: class extends Date { static now() { return now; } } });
  for (const source of sources) vm.runInContext(source, context);
  const data = structuredClone(initial);
  const storage = { get: async defaults => ({ ...defaults, ...data }), set: async patch => { await beforeWrite(patch); Object.assign(data, structuredClone(patch)); } };
  const { EvaluationCache, hash, TTL } = context.ThumbnailEvaluationCache;
  const cache = new EvaluationCache(storage, "gpt-6-luna", () => errors++);
  return { cache, data, hash, TTL, get errors() { return errors; }, advance(ms) { now += ms; } };
}
const result = (ids, probability = .95) => ({ schemaVersion: 5, results: Object.fromEntries(ids.map(id => [id, { probability }])) });

test("cache persists hashed titles and per-classifier expiry across restart", async () => {
  const f = fixture(); await f.cache.initialize("secret-key");
  const key = await f.hash("Exact Title!");
  f.cache.merge(key, result(["clickbait"]), ["clickbait"]);
  const firstExpiry = f.cache.read(key, ["clickbait"]).expires;
  f.advance(5000);
  f.cache.merge(key, result(["spoilers"]), ["spoilers"]);
  await f.cache.persist();
  assert.equal(f.data.evaluationCache.entries[0][1].clickbait.expires, firstExpiry);
  assert.equal(f.data.evaluationCache.entries[0][1].spoilers.expires, firstExpiry + 5000);
  assert.equal(JSON.stringify(f.data).includes("Exact Title!"), false);
  assert.equal(JSON.stringify(f.data).includes("secret-key"), false);
  const restarted = fixture(f.data); restarted.advance(5000); await restarted.cache.initialize("secret-key");
  assert.equal(restarted.cache.read(key, ["clickbait", "spoilers"]).missing.length, 0);
  f.advance(f.TTL - 5000);
  assert.deepEqual(Array.from(f.cache.read(key, ["clickbait", "spoilers"]).missing), ["clickbait"]);
  assert.notEqual(await f.hash("Exact Title!"), await f.hash("exact title!"));
});

test("cache rejects incompatible model, schema, format, and credential ownership", async () => {
  const base = fixture(); await base.cache.initialize("original-key");
  const key = await base.hash("Title"); base.cache.merge(key, result(["clickbait"]), ["clickbait"]); await base.cache.persist();
  for (const change of [{ model: "other" }, { format: 0 }, { classificationVersion: 2 }, { owner: "wrong" }]) {
    const data = structuredClone(base.data); Object.assign(data.evaluationCache, change);
    const next = fixture(data); await next.cache.initialize("original-key");
    assert.equal(next.cache.read(key, ["clickbait"]).missing.length, 1);
  }
  const next = fixture(base.data); await next.cache.initialize("replacement-key");
  assert.equal(next.cache.read(key, ["clickbait"]).missing.length, 1);
});

test("cache rejects malformed and expired individual scores without poisoning good scores", async () => {
  const f = fixture(); await f.cache.initialize("key"); const key = await f.hash("title");
  f.cache.merge(key, result(["clickbait", "spoilers"]), ["clickbait", "spoilers"]); await f.cache.persist();
  for (const patch of [{ probability: NaN }, { probability: 2 }, { probability: "0.9" }, { expires: Date.now() - 1 }, { expires: Infinity }]) {
    const data = structuredClone(f.data); Object.assign(data.evaluationCache.entries[0][1].spoilers, patch);
    const next = fixture(data); await next.cache.initialize("key");
    assert.deepEqual(Array.from(next.cache.read(key, ["clickbait", "spoilers"]).missing), ["spoilers"]);
  }
  assert.equal(f.cache.merge(key, result(["clickbait"]), ["clickbait", "spoilers"]), false);
});

test("cache evicts the oldest title after 5000 and reads refresh LRU order", async () => {
  const f = fixture(); await f.cache.initialize("key");
  for (let n = 0; n < 5000; n++) f.cache.merge(n.toString(16).padStart(64, "0"), result(["clickbait"]), ["clickbait"]);
  const first = "0".repeat(64); f.cache.read(first, ["clickbait"]);
  f.cache.merge("f".repeat(64), result(["clickbait"]), ["clickbait"]);
  await f.cache.persist();
  assert.equal(f.data.evaluationCache.entries.length, 5000);
  assert.equal(f.cache.read(first, ["clickbait"]).missing.length, 0);
  assert.equal(f.cache.read("1".padStart(64, "0"), ["clickbait"]).missing.length, 1);
});

test("failed persistence keeps memory results and later writes recover", async () => {
  let fail = true;
  const f = fixture({}, async () => { if (fail) throw new Error("quota"); });
  await f.cache.initialize("key"); const key = await f.hash("title"); f.cache.merge(key, result(["clickbait"]), ["clickbait"]);
  assert.equal(await f.cache.persist(), false);
  assert.equal(f.errors, 1);
  assert.equal(f.cache.read(key, ["clickbait"]).missing.length, 0);
  fail = false; assert.equal(await f.cache.persist(), true);
});

test("serialized writes cannot restore scores after credential clearing", async () => {
  let finish, started;
  const began = new Promise(resolve => { started = resolve; });
  let first = true;
  const f = fixture({}, async () => { if (first) { first = false; started(); await new Promise(resolve => { finish = resolve; }); } });
  await f.cache.initialize("old-key"); const key = await f.hash("title"); f.cache.merge(key, result(["clickbait"]), ["clickbait"]);
  const writing = f.cache.persist(); await began;
  const clearing = f.cache.clear("new-key");
  finish(); await Promise.all([writing, clearing]);
  assert.equal(f.data.evaluationCache.entries.length, 0);
  assert.equal(f.data.evaluationCache.owner, await f.hash("new-key"));
});

test('title and image TTLs differ, URL aliases expire hourly, and pixels are never stored', async () => {
  const f = fixture(); await f.cache.initialize('key');
  const title = await f.hash('title'), image = await f.hash('pixels'), url = await f.hash('url');
  const images = ['wide_open_mouth', 'brush_lettering_only', 'brush_background_only'];
  f.cache.merge(title, result(['clickbait']), ['clickbait']);
  f.cache.merge(image, result(images), images);
  const titleExpiry = f.cache.read(title, ['clickbait']).expires;
  for (const id of images) assert.equal(titleExpiry - f.cache.read(image, [id]).expires, 23 * 86400000);
  f.cache.setAlias(url, image); assert.equal(f.cache.alias(url).key, image);
  f.advance(3600001); assert.equal(f.cache.alias(url), null);
  f.advance(7 * 86400000); assert.deepEqual(Array.from(f.cache.read(image, images).missing), images);
  assert.equal(f.cache.read(title, ['clickbait']).missing.length, 0);
});

test('one changed instruction fingerprint invalidates only that category', async () => {
  const f = fixture(); await f.cache.initialize('key'); const key = await f.hash('title');
  f.cache.merge(key, result(['clickbait', 'spoilers']), ['clickbait', 'spoilers']); await f.cache.persist();
  f.data.evaluationCache.fingerprints.clickbait = 'old';
  const restarted = fixture(f.data); await restarted.cache.initialize('key');
  assert.deepEqual(Array.from(restarted.cache.read(key, ['clickbait', 'spoilers']).missing), ['clickbait']);
});

test('separate 5000-entry capacities and a combined four-MiB budget include metadata and aliases', async () => {
  const f = fixture(); await f.cache.initialize('key');
  for (let i = 0; i < 5000; i++) {
    f.cache.merge(i.toString(16).padStart(64, '0'), result(['clickbait']), ['clickbait']);
    const imageId = i % 2 ? 'brush_background_only' : 'wide_open_mouth';
    f.cache.merge((i + 5000).toString(16).padStart(64, '0'), result([imageId]), [imageId]);
  }
  await f.cache.persist(); assert.equal(f.data.evaluationCache.entries.length, 10000);
  for (let i = 0; i < 5000; i++) f.cache.merge(i.toString(16).padStart(64, '0'), result(Array.from(catalogIds())), Array.from(catalogIds()));
  function catalogIds() { return ['clickbait', 'fear_mongering', 'rage_bait', 'divisive_framing', 'personal_drama', 'celebrity_gossip', 'gambling_promotion', 'get_rich_quick', 'miracle_cure', 'shopping_pressure', 'engagement_bait', 'artificial_urgency', 'conspiracy_framing', 'spoilers', 'financial_price_predictions', 'crypto_nft_promotion', 'reaction_content', 'harassment_pranks', 'giveaways_contests', 'sponsorships_sales_pitches', 'rankings_listicles']; }
  for (let i = 0; i < 5000; i++) f.cache.setAlias((i + 10000).toString(16).padStart(64, '0'), (i + 5000).toString(16).padStart(64, '0'));
  await f.cache.persist(); assert.ok(Buffer.byteLength(JSON.stringify(f.data.evaluationCache)) <= 4 * 1024 * 1024);
});
