import test from "node:test";
import assert from "node:assert/strict";
import { classifiers, classification } from "./helpers.mjs";

const expected = ["clickbait", "fear_mongering", "rage_bait", "divisive_framing", "personal_drama", "celebrity_gossip", "gambling_promotion", "get_rich_quick", "miracle_cure", "shopping_pressure", "engagement_bait", "artificial_urgency", "conspiracy_framing", "spoilers", "financial_price_predictions", "crypto_nft_promotion", "reaction_content", "harassment_pranks", "giveaways_contests", "sponsorships_sales_pitches", "rankings_listicles"];

test("catalog preserves categories, explicit empty selections and stable order", () => {
  assert.deepEqual(Array.from(classifiers.ids), [...expected, "wide_open_mouth", "brush_lettering_only", "brush_background_only"]);
  assert.deepEqual(Array.from(classifiers.normalize(undefined)), expected);
  assert.deepEqual(Array.from(classifiers.normalize([])), []);
  assert.deepEqual(Array.from(classifiers.normalize(["rage_bait", "unknown", "clickbait", "rage_bait"])), ["clickbait", "rage_bait"]);
});

test("highest probability wins, exact ties follow catalog order, and the threshold is inclusive", () => {
  const data = classification();
  Object.assign(data.results, { clickbait: { probability: .92 }, rage_bait: { probability: .95 }, fear_mongering: { probability: .89 } });
  const pick = () => classifiers.strongest(data, classifiers.titleIds, .9);
  assert.equal(pick().label, "rage_bait");
  data.results.clickbait.probability = .95;
  assert.equal(pick().label, "clickbait");
  assert.equal(classifiers.strongest(data, classifiers.titleIds, 1), null);
  const endpoint = classification("clickbait", { probability: 0 }, ["clickbait"]);
  assert.equal(classifiers.strongest(endpoint, ["clickbait"], 0).probability, 0);
  assert.equal(classifiers.strongest(endpoint, ["clickbait"], .01), null);
  endpoint.results.clickbait.probability = 1;
  assert.equal(classifiers.strongest(endpoint, ["clickbait"], 1).probability, 1);
});

test("invalid probabilities, incomplete answers and legacy schemas cannot produce partial matches", () => {
  for (const mutate of [
    data => { delete data.results.rage_bait; },
    ...[undefined, null, NaN, Infinity, -.1, 1.1, "0.9"].map(value => data => { data.results.rage_bait.probability = value; }),
    data => { data.schemaVersion = 3; },
    data => { data.results.unknown = { probability: 1 }; }
  ]) {
    const data = classification("clickbait"); mutate(data);
    assert.equal(classifiers.strongest(data, classifiers.titleIds, 0), null);
  }
});

for (const id of expected) {
  test(`${id} qualifies at the probability boundary and rejects a score just below it`, () => {
    const data = classification(id, { probability: .9 });
    const pick = () => classifiers.strongest(data, classifiers.titleIds, .9);
    assert.equal(pick().label, id);
    data.results[id].probability = .8999;
    assert.equal(pick(), null);
    data.results[id].probability = .9;
    data.results.clickbait = { ...data.results[id] };
    assert.equal(pick().label, "clickbait");
    data.results[id].probability = .95;
    assert.equal(pick().label, id);
  });
}

test("saved selections are unchanged and later categories win only with higher probability", () => {
  const original = expected.slice(0, 12);
  assert.deepEqual(Array.from(classifiers.normalize(original)), original);
  const data = classification("conspiracy_framing");
  data.results.rankings_listicles = { ...data.results.conspiracy_framing };
  assert.equal(classifiers.strongest(data, classifiers.titleIds, .9).label, "conspiracy_framing");
  data.results.rankings_listicles.probability = .99;
  assert.equal(classifiers.strongest(data, classifiers.titleIds, .9).label, "rankings_listicles");
});
