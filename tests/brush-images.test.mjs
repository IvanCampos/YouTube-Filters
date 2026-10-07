import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { worker, catalog, youtube } from "./worker-helper.mjs";
import { popupFixture, contentFixture, chooseStyle, files, card, settle } from "./helpers.mjs";

const brushIds = ["brush_lettering_only", "brush_background_only"];
const endpoint = "https://api.openai.com/v1/decisions";
const thumbnail = "https://i.ytimg.com/vi/brush/hqdefault.jpg";
const imageData = "data:image/png;base64,AQ==";
const apiCalls = w => w.calls.filter(([url]) => url === endpoint);
const image = byte => new Response(Uint8Array.of(byte), { headers: { "content-type": "image/png" } });
const decision = (options, score = () => .95) => ({ ok: true, json: async () => ({
  answers: JSON.parse(options.body).questions.map(q => ({ type: "predicate", name: q.name, probability: score(q.name) }))
}) });

test("either brush predicate requires image evidence and uses an image-only rubric", async () => {
  const context = vm.createContext({});
  vm.runInContext(files["classifiers.js"], context);
  vm.runInContext(await readFile(new URL("../extension/decisions.js", import.meta.url), "utf8"), context);
  for (const id of brushIds) {
    assert.equal(catalog.byId[id].source, "image");
    const body = context.OpenAIDecisions.requestBody("Title", [id], imageData);
    assert.equal(body.input[0].content[1].image_url, imageData);
    assert.equal(body.questions[0].name, id);
    assert.match(body.questions[0].instructions, /Judge image only/);
    for (const evidence of [null, thumbnail]) {
      assert.throws(() => context.OpenAIDecisions.requestBody("Title", [id], evidence), error => error.code === "thumbnail");
    }
  }
  assert.deepEqual(Array.from(catalog.titleIds), Array.from(catalog.presets.titles));
  assert.ok(brushIds.every(id => !catalog.titleIds.includes(id) && !catalog.presets.focused.includes(id)));
});

test("AI Brushed Images is opt-in, selects both cases, and supports discard and individual saves", async t => {
  const initial = ["clickbait", "wide_open_mouth"];
  const ui = await popupFixture(t, { openaiApiKey: "dummy", enabledClassifiers: initial });
  const select = () => {
    const preset = ui.document.getElementById("category-preset");
    preset.value = "brushed";
    preset.dispatchEvent(new ui.window.Event("change", { bubbles: true }));
  };
  for (const id of brushIds) assert.equal(ui.document.getElementById(`classifier-${id}`).checked, false);
  select(); chooseStyle(ui.document, "classifier", "hide");
  assert.deepEqual([...ui.document.querySelectorAll("#classifier-list input:checked")].map(input => input.value), brushIds);
  ui.document.getElementById("discard").click();
  for (const id of brushIds) assert.equal(ui.document.getElementById(`classifier-${id}`).checked, false);
  assert.deepEqual(ui.storage.values.enabledClassifiers, initial);
  select(); chooseStyle(ui.document, "classifier", "hide");
  ui.document.getElementById("ai-enabled").click();
  ui.document.getElementById("save").click(); await settle();
  assert.deepEqual(Array.from(ui.storage.values.enabledClassifiers), brushIds);
  assert.equal(ui.storage.values.replacementStyle, "hide");
  const reopened = await popupFixture(t, ui.storage.values);
  assert.equal(reopened.document.getElementById("category-preset").value, "brushed");
  reopened.document.getElementById("classifier-brush_background_only").click();
  reopened.document.getElementById("save").click(); await settle();
  assert.deepEqual(Array.from(reopened.storage.values.enabledClassifiers), ["brush_lettering_only"]);
});

for (const id of brushIds) test(`${id} works alone, rejects missing images, and caches by image across titles and restart`, async () => {
  const fetch = async (url, options) => url === endpoint ? decision(options) : image(1);
  const w = worker(fetch, { enabledClassifiers: [id] });
  for (const thumbnailUrl of [null, "https://example.com/brush.png"]) {
    assert.equal((await w.classify("Title", { thumbnailUrl })).code, "thumbnail");
  }
  assert.equal(w.calls.length, 0);
  const result = await w.classify("Title", { thumbnailUrl: thumbnail });
  assert.equal(result.ok, true); assert.equal(result.results[id].probability, .95);
  const body = JSON.parse(apiCalls(w)[0][1].body);
  assert.deepEqual(body.questions.map(q => q.name), [id]);
  assert.equal(body.input[0].content[1].image_url, imageData);
  assert.equal(body.input[0].content[0].text, "Evaluate the thumbnail.");
  assert.equal((await w.classify("Different title", { thumbnailUrl: thumbnail })).ok, true);
  assert.equal(w.calls.length, 2, "one download and one API call cover both titles");
  const restarted = worker(fetch, structuredClone(w.local));
  assert.equal((await restarted.classify("Third title", { thumbnailUrl: thumbnail })).results[id].probability, .95);
  assert.equal(restarted.calls.length, 0);
});

test("enabling brush checks after a cached mouth score fetches evidence and pays only for missing categories", async () => {
  const w = worker(async (url, options) => url === endpoint ? decision(options) : image(1), { enabledClassifiers: ["clickbait", "wide_open_mouth"] });
  assert.equal((await w.classify("Title", { thumbnailUrl: thumbnail })).ok, true);
  await w.chrome.storage.local.set({ enabledClassifiers: ["clickbait", "wide_open_mouth", ...brushIds] });
  const result = await w.classify("Title", { thumbnailUrl: thumbnail });
  assert.equal(result.ok, true);
  for (const id of brushIds) assert.equal(result.results[id].probability, .95);
  const body = JSON.parse(apiCalls(w)[1][1].body);
  assert.deepEqual(body.questions.map(q => q.name), brushIds);
  assert.equal(body.input[0].content[1].image_url, imageData);
  assert.equal(w.calls.filter(([url]) => url === thumbnail).length, 2);
  assert.equal((await w.classify("Title", { thumbnailUrl: thumbnail })).ok, true);
  assert.equal(w.calls.length, 4);
});

test("real worker and content scripts hide either brush case at the threshold and keep plain and below-threshold cards visible", async t => {
  const names = ["lettering", "background", "plain", "below"], urls = names.map(name => `https://i.ytimg.com/vi/${name}/hqdefault.jpg`);
  const w = worker(async (url, options) => {
    if (url !== endpoint) return image(urls.indexOf(url) + 1);
    const body = JSON.parse(options.body), data = body.input[0].content[1].image_url;
    const byte = Buffer.from(data.split(",")[1], "base64")[0];
    return decision(options, id => id === brushIds[byte - 1] ? .9 : byte === 4 && id === brushIds[0] ? .8999 : .02);
  }, { enabledClassifiers: brushIds, replacementStyle: "hide", minProbability: .9 });
  const dom = new JSDOM(`<!doctype html><body>${names.map(name => card(name, "Same title")).join("")}</body>`, {
    url: "https://www.youtube.com/", runScripts: "outside-only", pretendToBeVisual: true
  });
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: 0, bottom: 160 });
  t.after(() => { dom.window.dispatchEvent(new dom.window.Event("pagehide")); dom.window.close(); });
  dom.window.chrome = { storage: w.chrome.storage, runtime: { sendMessage: message => w.send(message, youtube), connect: () => w.connect(youtube) } };
  const manifest = JSON.parse(await readFile(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  for (const name of manifest.content_scripts[0].js) dom.window.eval(files[name]);
  await settle(); await settle();
  assert.deepEqual([...dom.window.document.querySelectorAll("[data-yt-hide-card]")].map(node => node.dataset.card), ["lettering", "background"]);
  assert.equal(apiCalls(w).length, 4, "different pixels with the same title are evaluated separately");
  for (const [, options] of apiCalls(w)) assert.deepEqual(JSON.parse(options.body).questions.map(q => q.name), brushIds);
  await w.chrome.storage.local.set({ enabledClassifiers: [] }); await settle();
  assert.equal(dom.window.document.querySelector("[data-yt-hide-card]"), null);
  assert.equal(apiCalls(w).length, 4);
});

test("a late brush match cannot hide a card whose thumbnail changed", async t => {
  let complete;
  const page = await contentFixture(t, card("brush", "Same title"), { aiEnabled: true, keyConfigured: true, enabledClassifiers: brushIds, replacementStyle: "hide" }, message =>
    message.thumbnailUrl === thumbnail ? new Promise(resolve => { complete = resolve; }) : Promise.resolve({ ok: true, label: "neither" }));
  page.document.querySelector("img").src = "https://i.ytimg.com/vi/plain/hqdefault.jpg";
  complete({ ok: true, label: "brush_lettering_only" }); await settle(); await settle();
  assert.equal(page.document.querySelector("[data-yt-hide-card]"), null);
  assert.equal(page.requests.length, 2);
});
