import test from "node:test";
import assert from "node:assert/strict";
import { contentFixture, card, settle, classification, classifiers } from "./helpers.mjs";

const settings = { keywords: [], aiEnabled: true, keyConfigured: true };

test("whole-word keyword priority leaves substring-only titles eligible for AI", async (t) => {
  const { document, requests } = await contentFixture(t, card("a", "MAGA news") + card("b", "Magazine review"),
    { ...settings, keywords: ["MAGA"] }, async () => ({ ok: true, label: "clickbait" }));
  await settle();
  assert.ok(document.querySelector('[data-card="a"] [data-yt-red-mask="red"]'));
  assert.equal(document.querySelector('[data-card="a"] [data-yt-ai-overlay]'), null);
  assert.ok(document.querySelector('[data-card="b"] [data-yt-red-mask="purple"]'));
  assert.deepEqual(requests.map(request => request.title), ["Magazine review"]);
});

for (const label of ["clickbait", "fear_mongering", ...classifiers.titleIds.slice(12)]) {
  test(`${label} becomes purple even with no keywords`, async (t) => {
    const { document, window, requests } = await contentFixture(t, card("a", "A dramatic title"), settings, async () => ({ ok: true, label }));
    await settle();
    const mask = document.querySelector('[data-yt-red-mask="purple"]');
    assert.ok(mask);
    assert.equal(mask.querySelector('[data-yt-ai-line="choice"]').textContent, classifiers.byId[label].name);
    assert.equal(mask.style.getPropertyValue("--yt-mask-color"), "#8000ff");
    assert.equal(mask.querySelector("a").getAttribute("href"), "/watch?v=a");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].title, "A dramatic title");
    assert.equal("apiKey" in requests[0], false);
  });
}

test("keyword matches remain red without an API request; removing the keyword enables AI", async (t) => {
  const { document, storage, requests } = await contentFixture(t, card("a", "spoiler"), { ...settings, keywords: ["spoiler"] },
    async () => ({ ok: true, label: "clickbait" }));
  assert.equal(document.querySelector("[data-yt-red-mask]").getAttribute("data-yt-red-mask"), "red");
  assert.equal(requests.length, 0);
  await storage.api.local.set({ keywords: [] });
  await settle(); await settle();
  assert.ok(document.querySelector('[data-yt-red-mask="purple"]'));
});

test("neither, uncertain and API failures preserve the original preview", async (t) => {
  for (const result of [{ ok: true, label: "neither" }, { ok: true, label: "uncertain" }, { ok: false, code: "auth" }]) {
    const { document, requests } = await contentFixture(t, card("a", "An ordinary title"), settings, async () => result);
    await settle();
    assert.equal(document.querySelector("[data-yt-red-mask]"), null);
    assert.equal(requests.length, 1);
  }
});

test("late AI responses do not mask a recycled card's new title", async (t) => {
  let resolveOld;
  const { document } = await contentFixture(t, card("a", "Old title"), settings, ({ title }) =>
    title === "Old title" ? new Promise((resolve) => { resolveOld = resolve; }) : Promise.resolve({ ok: true, label: "neither" }));
  const title = document.querySelector("#video-title");
  title.setAttribute("title", "New title");
  title.textContent = "New title";
  resolveOld({ ok: true, label: "clickbait" });
  await settle(); await settle();
  assert.equal(document.querySelector("[data-yt-red-mask]"), null);
});

test("disabling AI restores purple thumbnails and ignores in-flight results", async (t) => {
  let resolve;
  const { document, storage } = await contentFixture(t, card("a", "A title"), settings,
    () => new Promise((done) => { resolve = done; }));
  await storage.api.local.set({ aiEnabled: false });
  resolve({ ok: true, label: "clickbait" });
  await settle(); await settle();
  assert.equal(document.querySelector("[data-yt-red-mask]"), null);
});

test("purple preserves lockup shape and switches to red when a keyword is added", async (t) => {
  const { document, storage } = await contentFixture(t, `<yt-lockup-view-model><a class="ytLockupViewModelContentImage" href="/watch?v=a" style="width:320px;height:180px"><yt-thumbnail-view-model style="border-radius:16px"><img></yt-thumbnail-view-model></a><h3><a href="/watch?v=a">A title</a></h3></yt-lockup-view-model>`,
    settings, async () => ({ ok: true, label: "clickbait" }));
  await settle();
  const mask = document.querySelector('[data-yt-red-mask="purple"]');
  assert.equal(mask.className, "ytLockupViewModelContentImage");
  assert.equal(mask.style.width, "320px");
  assert.equal(mask.style.getPropertyValue("--yt-red-radius"), "16px");
  await storage.api.local.set({ keywords: ["title"] });
  await settle();
  assert.equal(mask.getAttribute("data-yt-red-mask"), "red");
  await storage.api.local.set({ enabled: false });
  await settle();
  assert.equal(mask.hasAttribute("data-yt-red-mask"), false);
});

test("saved custom colors update existing masks without another API request", async (t) => {
  const { document, storage, requests } = await contentFixture(t, card("a", "spoiler") + card("b", "A dramatic title"),
    { ...settings, keywords: ["spoiler"], keywordColor: "#00aabb", aiColor: "#aabb00" }, async () => ({ ok: true, label: "clickbait" }));
  await settle();
  const keyword = document.querySelector('[data-yt-red-mask="red"]');
  const ai = document.querySelector('[data-yt-red-mask="purple"]');
  assert.equal(keyword.style.getPropertyValue("--yt-mask-color"), "#00aabb");
  assert.equal(ai.style.getPropertyValue("--yt-mask-color"), "#aabb00");
  assert.equal(requests.length, 1);
  await storage.api.local.set({ keywordColor: "#123456", aiColor: "#abcdef" });
  await settle();
  assert.equal(keyword.style.getPropertyValue("--yt-mask-color"), "#123456");
  assert.equal(ai.style.getPropertyValue("--yt-mask-color"), "#abcdef");
  assert.equal(requests.length, 1);
});

const lines = document => [...document.querySelectorAll("[data-yt-ai-line]")].map(line => line.textContent);

test("labels show rounded probability, including 100%, only on AI masks", async (t) => {
  const { document } = await contentFixture(t, card("k", "spoiler") + card("a", "bait") + card("b", "fear"),
    { ...settings, keywords: ["spoiler"] }, async ({ title }) => title === "bait" ?
      { ok: true, label: "clickbait", probability: 0.925 } :
      { ok: true, label: "fear_mongering", probability: 1 });
  await settle();
  assert.deepEqual(lines(document), ["Clickbait", "Probability: 93%", "Fear mongering", "Probability: 100%"]);
  assert.equal(document.querySelector('[data-card="k"] [data-yt-ai-overlay]'), null);
});

test("color changes retain one label, maximize contrast, and keep original content hidden", async (t) => {
  const { document, window, storage, requests } = await contentFixture(t, card("a", "bait"), { ...settings, aiColor: "#000000" },
    async () => ({ ok: true, label: "clickbait" }));
  await settle();
  const mask = document.querySelector("[data-yt-red-mask]");
  const overlay = mask.querySelector("[data-yt-ai-overlay]");
  assert.equal(mask.style.getPropertyValue("--yt-ai-label-color"), "#ffffff");
  assert.equal(window.getComputedStyle(overlay).opacity, "1");
  assert.equal(window.getComputedStyle(overlay).pointerEvents, "none");
  assert.equal(window.getComputedStyle(mask.querySelector("a")).opacity, "0");
  await storage.api.local.set({ aiColor: "#ffffff" });
  await settle();
  assert.equal(mask.style.getPropertyValue("--yt-ai-label-color"), "#000000");
  assert.equal(mask.querySelector("[data-yt-ai-overlay]"), overlay);
  assert.equal(requests.length, 1);
  await storage.api.local.set({ keywords: ["bait"] });
  await settle();
  assert.equal(mask.querySelector("[data-yt-ai-overlay]"), null);
});

test("image-only fallback keeps image identity, link, original inline styles and cleans up wrappers", async (t) => {
  const html = '<section><a href="/watch?v=a" title="bait"><img src="https://i.ytimg.com/vi/a/default.jpg" style="width:240px;height:135px;border-radius:16px;margin-left:3px;margin-top:2px"></a></section>';
  const { document, storage, requests } = await contentFixture(t, html, settings, async () => ({ ok: true, label: "clickbait" }));
  const image = document.querySelector("img");
  await settle();
  assert.equal(document.querySelectorAll("[data-yt-mask-wrapper]").length, 1);
  assert.equal(image.closest("a").getAttribute("href"), "/watch?v=a");
  assert.deepEqual(lines(document), ["Clickbait", "Probability: 92%"]);
  assert.equal(requests.length, 1);
  await storage.api.local.set({ enabled: false });
  await settle();
  assert.equal(document.querySelector("[data-yt-mask-wrapper]"), null);
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  assert.equal(document.querySelector("img"), image);
  assert.equal(image.parentElement.tagName, "A");
  assert.equal(image.style.width, "240px");
  assert.equal(image.style.marginLeft, "3px");
  assert.equal(image.style.marginTop, "2px");
  assert.equal(image.style.getPropertyPriority("width"), "");
});

test("recycling labeled cards updates decisions and never extracts label text as a title", async (t) => {
  const { document, requests } = await contentFixture(t, card("a", "bait"), settings,
    async ({ title }) => ({ ok: true, label: title === "bait" ? "clickbait" : title === "fear" ? "fear_mongering" : "neither" }));
  await settle();
  const title = document.querySelector("#video-title");
  title.removeAttribute("title");
  title.textContent = "fear";
  await settle(); await settle();
  assert.equal(lines(document)[0], "Fear mongering");
  title.textContent = "ordinary";
  await settle(); await settle();
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  assert.deepEqual(requests.map(request => request.title), ["bait", "fear", "ordinary"]);
});

test("the probability threshold applies inclusively to raw scores, reuse page cache, and do not restrict keywords", async (t) => {
  const { document, storage, requests } = await contentFixture(t, card("a", "bait") + card("k", "spoiler"),
    { ...settings, keywords: ["spoiler"], minProbability: 0.93 },
    async () => ({ ok: true, label: "clickbait", probability: 0.925 }));
  await settle();
  assert.equal(document.querySelector('[data-card="a"] [data-yt-red-mask]'), null);
  assert.ok(document.querySelector('[data-card="k"] [data-yt-red-mask]'));
  await storage.api.local.set({ minProbability: 0.925 });
  await settle();
  assert.ok(document.querySelector('[data-card="a"] [data-yt-ai-overlay]'));
  await storage.api.local.set({ minProbability: 0.926 });
  await settle();
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  assert.equal(requests.length, 1);
});

test("all replacement styles update live, hide restores cards, and clicks still work without hover", async (t) => {
  const { document, window, storage, requests } = await contentFixture(t, card("a", "bait") + card("b", "ordinary"), settings,
    async ({ title }) => ({ ok: true, label: title === "bait" ? "clickbait" : "neither" }));
  await settle();
  const cardA = document.querySelector('[data-card="a"]');
  const mask = cardA.querySelector("[data-yt-red-mask]");
  const link = mask.querySelector("a");
  let clicks = 0, hovers = 0;
  link.addEventListener("click", event => { event.preventDefault(); clicks++; });
  link.addEventListener("mouseover", () => hovers++);
  for (const style of ["blur", "grayscale", "placeholder", "hide", "solid"]) {
    await storage.api.local.set({ replacementStyle: style });
    await settle();
    assert.equal(mask.getAttribute("data-yt-replacement-style"), style);
    assert.equal(cardA.hasAttribute("data-yt-hide-card"), style === "hide");
    assert.equal(Boolean(mask.querySelector("[data-yt-ai-overlay]")), style !== "hide");
    if (style === "hide") assert.equal(window.getComputedStyle(cardA).display, "none");
    if (["blur", "grayscale"].includes(style)) {
      assert.equal(window.getComputedStyle(link).opacity, "1");
      assert.match(window.getComputedStyle(link).filter, new RegExp(style));
    }
    link.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
    link.click();
  }
  assert.equal(hovers, 0);
  assert.equal(clicks, 5);
  assert.equal(document.querySelector('[data-card="b"]').hasAttribute("data-yt-hide-card"), false);
  assert.equal(requests.length, 2);
  await storage.api.local.set({ replacementStyle: "hide" });
  await settle();
  await storage.api.local.set({ enabled: false });
  await settle();
  assert.equal(document.querySelector("[data-yt-hide-card]"), null);
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
});

test("malformed page responses cannot create labels", async (t) => {
  const { document } = await contentFixture(t, card("a", "bait"), settings,
    async () => ({ ok: true, label: "clickbait", probability: undefined }));
  await settle();
  assert.equal(document.querySelector("[data-yt-red-mask]"), null);
});

test("hiding a modern lockup removes its enclosing feed item and restores recycled cards", async (t) => {
  const { document, window, storage } = await contentFixture(t, '<ytd-rich-item-renderer><yt-lockup-view-model><a class="ytLockupViewModelContentImage" href="/watch?v=a"><img></a><h3><a id="video-title" href="/watch?v=a">bait</a></h3></yt-lockup-view-model></ytd-rich-item-renderer>',
    { ...settings, replacementStyle: "hide" }, async ({ title }) => ({ ok: true, label: title === "bait" ? "clickbait" : "neither" }));
  await settle();
  const item = document.querySelector("ytd-rich-item-renderer");
  assert.equal(window.getComputedStyle(item).display, "none");
  document.querySelector("#video-title").textContent = "ordinary";
  await settle(); await settle();
  assert.equal(item.hasAttribute("data-yt-hide-card"), false);
  assert.equal(document.querySelector("[data-yt-red-mask]"), null);
});

test("image fallback uses fractional dimensions and restores when a keyword takes priority", async (t) => {
  const { document, storage } = await contentFixture(t, '<section><a href="/watch?v=a" title="bait"><img src="https://i.ytimg.com/vi/a/default.jpg" style="width:180px;height:101.25px"></a></section>',
    settings, async () => ({ ok: true, label: "clickbait" }));
  await settle();
  assert.equal(document.querySelector("[data-yt-mask-wrapper]").style.height, "101.25px");
  await storage.api.local.set({ keywords: ["bait"] });
  await settle();
  assert.equal(document.querySelector("[data-yt-mask-wrapper]"), null);
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  assert.equal(document.querySelector("img").getAttribute("data-yt-red-mask"), "red");
});

test("keyword blur is independent of AI style and AI thresholds", async (t) => {
  const { document, storage } = await contentFixture(t, card("k", "spoiler") + card("a", "bait") + card("b", "weak"),
    { ...settings, keywords: ["spoiler"], keywordReplacementStyle: "blur", replacementStyle: "solid", minProbability: 0.9 },
    async ({ title }) => ({ ok: true, label: "clickbait", probability: title === "weak" ? 0.89 : 0.9 }));
  await settle();
  const keyword = document.querySelector('[data-card="k"] [data-yt-red-mask]');
  const ai = document.querySelector('[data-card="a"] [data-yt-red-mask]');
  assert.equal(keyword.getAttribute("data-yt-replacement-style"), "blur");
  assert.equal(ai.getAttribute("data-yt-replacement-style"), "solid");
  assert.equal(document.querySelector('[data-card="b"] [data-yt-red-mask]'), null);
  await storage.api.local.set({ replacementStyle: "hide" });
  await settle();
  assert.equal(document.querySelector('[data-card="a"]').hasAttribute("data-yt-hide-card"), true);
  assert.equal(document.querySelector('[data-card="k"]').hasAttribute("data-yt-hide-card"), false);
  assert.equal(keyword.getAttribute("data-yt-replacement-style"), "blur");
});


test("every category renders its catalog name and match probability", async (t) => {
  const html = classifiers.catalog.map(category => card(category.id, category.id)).join("");
  const { document } = await contentFixture(t, html, settings, async ({ title }) => ({ ok: true, ...classification(title, { probability: 0.97 }) }));
  await settle();
  for (const category of classifiers.catalog.filter(entry => entry.source === "title")) {
    const item = document.querySelector(`[data-card="${category.id}"]`);
    assert.deepEqual(lines(item), [category.name, "Probability: 97%"]);
  }
});

test("probability thresholds hide and restore the strongest category without new requests", async (t) => {
  const result = classification("rage_bait", { probability: 0.96 });
  result.results.shopping_pressure = { probability: 0.93 };
  const { document, storage, requests } = await contentFixture(t, card("a", "A title"),
    { ...settings, minProbability: 0.9 }, async () => ({ ok: true, ...result }));
  await settle();
  assert.equal(lines(document)[0], "Rage bait");
  await storage.api.local.set({ minProbability: .97 });
  await settle();
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  await storage.api.local.set({ minProbability: .93 });
  await settle();
  assert.equal(lines(document)[0], "Rage bait");
  assert.equal(requests.length, 1);
});

test("empty categories restore AI thumbnails, keep keyword filtering, and ignore late results", async (t) => {
  let finish;
  const { document, storage, requests } = await contentFixture(t, card("k", "spoiler") + card("a", "Old title"),
    { ...settings, keywords: ["spoiler"] }, () => new Promise(resolve => { finish = resolve; }));
  await storage.api.local.set({ enabledClassifiers: [] });
  finish({ ok: true, ...classification("rage_bait") });
  await settle(); await settle();
  assert.equal(document.querySelectorAll('[data-yt-red-mask]').length, 1);
  assert.ok(document.querySelector('[data-card="k"] [data-yt-red-mask]'));
  assert.equal(document.querySelector('[data-yt-ai-overlay]'), null);
  document.querySelector('[data-card="a"] #video-title').textContent = "A new title";
  await settle();
  assert.equal(requests.length, 1);
});

test("changing categories reclassifies and removes a previously matched category", async (t) => {
  let selected = classifiers.titleIds;
  const { document, storage, requests } = await contentFixture(t, card("a", "A title"), settings,
    async () => ({ ok: true, ...classification("rage_bait", {}, selected) }));
  await settle();
  assert.equal(lines(document)[0], "Rage bait");
  selected = ["clickbait"];
  await storage.api.local.set({ enabledClassifiers: selected });
  await settle(); await settle();
  assert.equal(document.querySelector('[data-yt-ai-overlay]'), null);
  assert.equal(requests.length, 2);
});

test("new category labels render and stale responses cannot replace a changed selection", async (t) => {
  let finish;
  let first = true;
  const selected = ["sponsorships_sales_pitches", "rankings_listicles"];
  const { document, storage } = await contentFixture(t, card("a", "Sponsored showcase"),
    { ...settings, enabledClassifiers: selected }, async () => {
      if (first) { first = false; return new Promise(resolve => { finish = resolve; }); }
      return { ok: true, ...classification("rankings_listicles", {}, ["rankings_listicles"]) };
    });
  await storage.api.local.set({ enabledClassifiers: ["rankings_listicles"] });
  finish({ ok: true, ...classification("sponsorships_sales_pitches", {}, selected) });
  await settle(); await settle();
  assert.equal(lines(document)[0], "Rankings and listicles");
  await storage.api.local.set({ enabled: false });
  await settle();
  assert.equal(document.querySelector('[data-yt-ai-overlay]'), null);
});

test("zero threshold includes a zero probability and obsolete confidence cannot suppress a match", async t => {
  const { document, storage, requests } = await contentFixture(t, card("a", "A title"),
    { ...settings, enabledClassifiers: ["clickbait"], minProbability: 0, minConfidence: 1 },
    async () => ({ ok: true, ...classification("clickbait", { probability: 0 }, ["clickbait"]) }));
  await settle();
  assert.deepEqual(lines(document), ["Clickbait", "Probability: 0%"]);
  await storage.api.local.set({ minProbability: .01 }); await settle();
  assert.equal(document.querySelector("[data-yt-ai-overlay]"), null);
  assert.equal(requests.length, 1);
});
