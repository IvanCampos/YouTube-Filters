import test from "node:test";
import assert from "node:assert/strict";
import { contentFixture, card, settle } from "./helpers.mjs";

const masks = (document) => [...document.querySelectorAll("[data-yt-red-mask]")];

test("whole-word keywords filter MAGA but restore a recycled Magazine card", async (t) => {
  const { document } = await contentFixture(t, card("a", "MAGA news") + card("b", "Magazine review"), { keywords: ["MAGA"] });
  assert.equal(masks(document).length, 1);
  assert.equal(masks(document)[0].closest("[data-card]").dataset.card, "a");
  const title = document.querySelector('[data-card="a"] #video-title');
  title.setAttribute("title", "Magazine news");
  title.textContent = "Magazine news";
  await settle();
  assert.equal(masks(document).length, 0);
  assert.equal(document.querySelector("[data-yt-red-card]"), null);
  assert.equal(document.querySelector("[data-yt-red-position]"), null);
  title.setAttribute("title", "Magazine covers #MAGA");
  title.textContent = "Magazine covers #MAGA";
  await settle();
  assert.equal(masks(document).length, 1);
});

test("masks only matching thumbnails, preserves titles, image sources and links", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "Spoiler review") + card("b", "Calm cooking"));
  assert.equal(masks(document).length, 1);
  const mask = masks(document)[0];
  assert.equal(mask.tagName, "YTD-THUMBNAIL");
  // jsdom does not resolve CSS variables; rendered colors are checked in the browser fixture.
  assert.equal(mask.style.getPropertyValue("--yt-mask-color"), "#ff0000");
  assert.equal(window.getComputedStyle(mask.firstElementChild).opacity, "0");
  assert.equal(mask.querySelector("a").getAttribute("href"), "/watch?v=a");
  assert.equal(mask.querySelector("img").getAttribute("src"), "https://i.ytimg.com/vi/a/hqdefault.jpg");
  assert.equal(document.querySelector("#video-title").closest("[data-yt-red-mask]"), null);
});

test("supports legacy home/search/channel/playlist/watch renderers", async (t) => {
  const tags = ["ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
    "ytd-compact-video-renderer", "ytd-playlist-video-renderer", "ytd-playlist-panel-video-renderer"];
  const { document } = await contentFixture(t, tags.map((tag, index) => card(`v${index}`, "spoiler", tag)).join(""));
  assert.equal(masks(document).length, tags.length);
});

test("matches a modern lockup using title only, not channel metadata", async (t) => {
  const { document } = await contentFixture(t, `
    <yt-lockup-view-model><a class="yt-lockup-view-model__content-image" href="/watch?v=a"><yt-thumbnail-view-model><img></yt-thumbnail-view-model></a><h3 class="yt-lockup-metadata-view-model__title"><a href="/watch?v=a">A SPOILER review</a></h3></yt-lockup-view-model>
    <yt-lockup-view-model><a class="yt-lockup-view-model__content-image" href="/watch?v=b"><yt-thumbnail-view-model><img></yt-thumbnail-view-model></a><h3 class="yt-lockup-metadata-view-model__title"><a href="/watch?v=b">A normal review</a></h3><span>Spoiler Channel</span></yt-lockup-view-model>`);
  assert.equal(masks(document).length, 1);
  assert.equal(masks(document)[0].getAttribute("href"), "/watch?v=a");
});

test("supports Shorts, mobile and player end-screen previews", async (t) => {
  const { document } = await contentFixture(t, `
    <ytm-shorts-lockup-view-model><a href="/shorts/a"><div class="shortsLockupViewModelHostThumbnailContainer"><img></div></a><h3 class="shortsLockupViewModelHostMetadataTitle">Spoiler short</h3></ytm-shorts-lockup-view-model>
    <ytm-video-with-context-renderer><a href="/watch?v=b"><div class="video-thumbnail-container-large"><img></div></a><h3 class="media-item-headline">Spoiler mobile</h3></ytm-video-with-context-renderer>
    <a class="ytp-videowall-still" href="/watch?v=c"><span class="ytp-videowall-still-image"></span><span class="ytp-videowall-still-info-title">Spoiler end screen</span></a>
    <a class="ytp-ce-video" href="/watch?v=d"><span class="ytp-ce-video-title">Spoiler card</span></a>`);
  assert.equal(masks(document).length, 4);
});

test("supports current camel-case lockups and sponsored preview headlines", async (t) => {
  const { document } = await contentFixture(t, `
    <yt-lockup-view-model><a class="ytLockupViewModelContentImage" href="/watch?v=a"><yt-thumbnail-view-model><img></yt-thumbnail-view-model></a><h3 class="ytLockupMetadataViewModelTitle"><a href="/watch?v=a">Spoiler preview</a></h3></yt-lockup-view-model>
    <yt-lockup-view-model><a class="ytLockupViewModelContentImage" href="https://www.googleadservices.com/example"><yt-thumbnail-view-model><img></yt-thumbnail-view-model></a><span class="ytwFeedAdMetadataViewModelHostTextsStyleCompactHeadline">Spoiler ad title</span></yt-lockup-view-model>`);
  assert.equal(masks(document).length, 2);
  assert.equal(masks(document).every((element) => element.classList.contains("ytLockupViewModelContentImage")), true);
});

test("handles new cards from infinite scrolling", async (t) => {
  const { document } = await contentFixture(t, card("a", "A walk"));
  document.body.insertAdjacentHTML("beforeend", card("b", "spoiler added later"));
  await settle();
  assert.equal(masks(document).length, 1);
  assert.equal(masks(document)[0].closest("[data-card]").dataset.card, "b");
});

test("restores recycled cards when titles change and responds to text-node edits", async (t) => {
  const { document } = await contentFixture(t, card("a", "spoiler"));
  const title = document.querySelector("#video-title");
  title.setAttribute("title", "A calm walk");
  title.textContent = "A calm walk";
  await settle();
  assert.equal(masks(document).length, 0);
  assert.equal(document.querySelector("[data-yt-red-card]"), null);
  title.removeAttribute("title");
  title.firstChild.data = "Spoiler arrived";
  await settle();
  assert.equal(masks(document).length, 1);
});

test("saved keyword changes, pause/resume and clearing restore original thumbnails", async (t) => {
  const { document, storage } = await contentFixture(t, card("a", "spoiler") + card("b", "cooking"));
  await storage.api.local.set({ keywords: ["cooking"] });
  await settle();
  assert.equal(masks(document)[0].closest("[data-card]").dataset.card, "b");
  await storage.api.local.set({ enabled: false });
  await settle();
  assert.equal(masks(document).length, 0);
  assert.equal(document.querySelector("[data-yt-red-position]"), null);
  await storage.api.local.set({ enabled: true });
  await settle();
  assert.equal(masks(document).length, 1);
  await storage.api.local.set({ keywords: [] });
  await settle();
  assert.equal(masks(document).length, 0);
});

test("default empty list and disabled settings leave all previews alone", async (t) => {
  const { document } = await contentFixture(t, card("a", "spoiler"), { enabled: false, keywords: ["spoiler"] });
  assert.equal(masks(document).length, 0);
});

test("unknown card fallback associates matching video URLs without leaking to neighbors", async (t) => {
  const { document } = await contentFixture(t, `
    <section><article><a href="/watch?v=a"><img src="https://i.ytimg.com/vi/a/hqdefault.jpg"></a><a href="/watch?v=a"><h3>Spoiler</h3></a></article>
    <article><a href="/watch?v=b"><img src="https://i.ytimg.com/vi/b/hqdefault.jpg"></a><a href="/watch?v=b"><h3>Cooking</h3></a></article></section>`);
  assert.equal(masks(document).length, 1);
  assert.equal(masks(document)[0].getAttribute("src"), "https://i.ytimg.com/vi/a/hqdefault.jpg");
});

test("does not attribute a mismatched video title during card recycling", async (t) => {
  const { document } = await contentFixture(t, card("a", "spoiler"));
  document.querySelector("ytd-thumbnail a").setAttribute("href", "/watch?v=b");
  await settle();
  assert.equal(masks(document).length, 0);
});

test("covers hover preview content and removes adjacent preview hiding on unmatch", async (t) => {
  const { document, window, storage } = await contentFixture(t, card("a", "spoiler"));
  const thumbnail = document.querySelector("ytd-thumbnail");
  thumbnail.insertAdjacentHTML("beforeend", "<video></video>");
  thumbnail.parentElement.insertAdjacentHTML("beforeend", '<div id="mouseover-overlay"><video></video></div>');
  await settle();
  assert.equal(window.getComputedStyle(thumbnail.querySelector("video")).opacity, "0");
  assert.equal(window.getComputedStyle(document.querySelector("#mouseover-overlay")).opacity, "0");
  await storage.api.local.set({ keywords: [] });
  await settle();
  assert.notEqual(window.getComputedStyle(document.querySelector("#mouseover-overlay")).opacity, "0");
});

test("removed cards are cleaned up and navigation events process the new page", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "spoiler"));
  const removed = document.querySelector("[data-card]");
  removed.remove();
  document.body.insertAdjacentHTML("beforeend", card("b", "spoiler next page"));
  document.dispatchEvent(new window.Event("yt-navigate-finish"));
  await settle();
  assert.equal(removed.querySelector("[data-yt-red-mask]"), null);
  assert.equal(masks(document).length, 1);
});

test("cleans up on pagehide and resumes after back-forward cache restore", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "spoiler"));
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(masks(document).length, 0);
  window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
  await settle();
  assert.equal(masks(document).length, 1);
});

test("unmasks an image when it stops being a video thumbnail", async (t) => {
  const { document } = await contentFixture(t, '<a href="/watch?v=a" title="spoiler"><img src="https://i.ytimg.com/vi/a/hqdefault.jpg"></a>');
  assert.equal(masks(document).length, 1);
  document.querySelector("img").src = "https://example.com/avatar.png";
  await settle();
  assert.equal(masks(document).length, 0);
});
