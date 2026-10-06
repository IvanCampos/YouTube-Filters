import test from "node:test";
import assert from "node:assert/strict";
import { contentFixture, card, settle } from "./helpers.mjs";

const ai = { keywords: [], aiEnabled: true, keyConfigured: true };
const match = async () => ({ ok: true, label: "clickbait" });
const hidden = element => element.hasAttribute("data-yt-preview-suppressed");

// jsdom has no decoder: model media state and non-bubbling browser playback events.
function media(window, parent, tag = "video") {
  const element = window.document.createElement(tag);
  let paused = true, pauses = 0;
  Object.defineProperty(element, "paused", { get: () => paused });
  element.pause = () => { paused = true; pauses++; };
  element.play = () => { throw new Error("Filtering must never resume playback"); };
  parent.append(element);
  return {
    element, get pauses() { return pauses; },
    start(type = "play") { paused = false; element.dispatchEvent(new window.Event(type)); },
    setPlaying() { paused = false; }
  };
}

test("a delayed classifier result stops previews that already started", async (t) => {
  let resolve;
  const { document, window } = await contentFixture(t, card("a", "bait"), ai,
    () => new Promise(done => { resolve = done; }));
  const preview = media(window, document.querySelector("ytd-thumbnail a"));
  preview.start();
  assert.equal(preview.pauses, 0, "unclassified thumbnails keep normal playback");
  resolve({ ok: true, label: "clickbait" });
  await settle();
  assert.equal(preview.pauses, 1);
  assert.equal(hidden(preview.element), true);
  for (const type of ["play", "playing", "play"]) preview.start(type);
  assert.equal(preview.pauses, 4, "each later playback attempt is stopped synchronously");
});

test("late sibling video and audio are stopped during mutation delivery", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "bait"), ai, match);
  await settle();
  for (const tag of ["video", "audio"]) {
    const preview = media(window, document.querySelector("[data-card]"), tag);
    preview.setPlaying();
    await new Promise(resolve => window.queueMicrotask(resolve));
    assert.equal(preview.pauses, 1);
    assert.equal(hidden(preview.element), true);
    assert.equal(window.getComputedStyle(preview.element).visibility, "hidden");
  }
});

test("detached previews require a matching, unambiguous video link and release on reuse", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "bait") + card("b", "calm"), ai,
    async ({ title }) => ({ ok: true, label: title === "bait" ? "clickbait" : "neither" }));
  await settle();
  const host = document.createElement("ytd-video-preview");
  host.innerHTML = '<a href="/watch?v=a">Watch</a><div id="mouseover-overlay"></div>';
  document.body.append(host);
  const preview = media(window, host.querySelector("div"));
  preview.start();
  assert.equal(preview.pauses, 1);
  assert.equal(hidden(host), true);
  let hovers = 0, clicks = 0;
  const link = host.querySelector("a");
  link.addEventListener("mouseover", () => hovers++);
  link.addEventListener("click", event => { event.preventDefault(); clicks++; });
  link.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  link.click();
  assert.equal(hovers, 0);
  assert.equal(clicks, 1);
  link.href = "/watch?v=b";
  preview.start();
  assert.equal(preview.pauses, 1, "recycled identity is checked before mutation delivery");
  assert.equal(hidden(host), false);
  assert.equal(hidden(preview.element), false);
  link.removeAttribute("href");
  preview.start();
  assert.equal(preview.pauses, 1, "missing identity cannot hide an unrelated player");
  link.href = "/watch?v=a";
  host.insertAdjacentHTML("beforeend", '<a href="/watch?v=b">Other video</a>');
  preview.start();
  assert.equal(preview.pauses, 1, "ambiguous identity is not guessed");
});

test("all styles stop previews, and threshold/AI changes release them without resuming", async (t) => {
  const { document, window, storage } = await contentFixture(t, card("a", "bait"), ai, match);
  await settle();
  const preview = media(window, document.querySelector("[data-card]"));
  for (const style of ["solid", "blur", "grayscale", "placeholder", "hide"]) {
    await storage.api.local.set({ replacementStyle: style });
    await settle();
    preview.start();
    assert.equal(preview.element.paused, true, style);
    assert.equal(hidden(preview.element), true, style);
  }
  await storage.api.local.set({ minProbability: 1 });
  preview.start();
  assert.equal(hidden(preview.element), false);
  assert.equal(preview.element.paused, false);
  await storage.api.local.set({ minProbability: 0 });
  await settle();
  assert.equal(preview.element.paused, true);
  await storage.api.local.set({ aiEnabled: false });
  assert.equal(hidden(preview.element), false);
  preview.start();
  assert.equal(preview.element.paused, false);
});

test("keyword guards restore immediately when a title or video link is recycled", async (t) => {
  const { document, window, storage } = await contentFixture(t, card("a", "spoiler"));
  const preview = media(window, document.querySelector("ytd-thumbnail a"));
  preview.start();
  assert.equal(preview.pauses, 1);
  const title = document.querySelector("#video-title");
  title.textContent = "calm";
  title.setAttribute("title", "calm");
  preview.start();
  assert.equal(preview.pauses, 1);
  assert.equal(hidden(preview.element), false);
  title.textContent = "spoiler";
  title.setAttribute("title", "spoiler");
  await settle();
  const link = document.querySelector("ytd-thumbnail a");
  link.href = "/watch?v=b";
  preview.start();
  assert.equal(preview.element.paused, false);
  link.href = "/watch?v=a";
  await settle();
  await storage.api.local.set({ keywords: [] });
  preview.start();
  assert.equal(preview.element.paused, false);
  assert.equal(hidden(preview.element), false);
});

test("normal cards and main, Shorts, and mini players keep playing", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "spoiler") + card("b", "calm"));
  const normal = media(window, document.querySelector('[data-card="b"]'));
  normal.start();
  assert.equal(normal.pauses, 0);
  // Same video ID elsewhere on the page never authorizes suppressing a real player.
  for (const markup of ['<div id="movie_player"></div>', '<div id="shorts-player"></div>',
    '<ytd-reel-video-renderer></ytd-reel-video-renderer>', '<ytd-miniplayer></ytd-miniplayer>']) {
    const outer = document.createElement("div");
    outer.innerHTML = markup;
    document.body.append(outer);
    const player = outer.firstElementChild;
    player.insertAdjacentHTML("beforeend", '<a href="/watch?v=a">Watch</a>');
    const actual = media(window, player);
    actual.start();
    assert.equal(actual.pauses, 0, markup);
    assert.equal(hidden(actual.element), false);
  }
  const unmatchedPortal = document.createElement("ytd-video-preview");
  unmatchedPortal.innerHTML = '<a href="/watch?v=b">Watch</a>';
  document.body.append(unmatchedPortal);
  const unmatched = media(window, unmatchedPortal);
  unmatched.start();
  assert.equal(unmatched.pauses, 0);
});

test("media moved into the main player is released and detached nodes are cleaned up", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "spoiler"));
  const preview = media(window, document.querySelector("ytd-thumbnail"));
  preview.start();
  const player = document.createElement("div");
  player.id = "movie_player";
  document.body.append(player);
  player.append(preview.element);
  preview.start();
  assert.equal(preview.element.paused, false);
  assert.equal(hidden(preview.element), false);
  document.querySelector("ytd-thumbnail").append(preview.element);
  preview.start();
  preview.element.remove();
  await new Promise(resolve => window.queueMicrotask(resolve));
  assert.equal(hidden(preview.element), false);
});

test("pagehide tears down guards and bfcache restore reinstalls them once", async (t) => {
  const { document, window } = await contentFixture(t, card("a", "spoiler"));
  const preview = media(window, document.querySelector("ytd-thumbnail"));
  preview.start();
  window.dispatchEvent(new window.Event("pagehide"));
  assert.equal(hidden(preview.element), false);
  preview.start();
  assert.equal(preview.element.paused, false);
  window.dispatchEvent(new window.PageTransitionEvent("pageshow", { persisted: true }));
  await settle();
  assert.equal(preview.element.paused, true);
  const pauses = preview.pauses;
  preview.start();
  assert.equal(preview.pauses, pauses + 1);
});

test("end-screen thumbnail hover is blocked without pausing its enclosing main player", async (t) => {
  const { document, window } = await contentFixture(t,
    '<div id="movie_player"><a class="ytp-videowall-still" href="/watch?v=a"><span class="ytp-videowall-still-image"></span><span class="ytp-videowall-still-info-title">spoiler</span></a></div>');
  const player = media(window, document.querySelector("#movie_player"));
  player.start();
  assert.equal(player.pauses, 0);
  const tile = document.querySelector("a");
  let hovers = 0, clicks = 0, exits = 0;
  tile.addEventListener("mouseover", () => hovers++);
  tile.addEventListener("mouseleave", () => exits++);
  tile.addEventListener("click", event => { event.preventDefault(); clicks++; });
  tile.dispatchEvent(new window.MouseEvent("mouseover", { bubbles: true }));
  tile.dispatchEvent(new window.MouseEvent("mouseleave"));
  tile.click();
  assert.equal(hovers, 0);
  assert.equal(clicks, 1);
  assert.equal(exits, 1, "leave events still reach YouTube cleanup handlers");
});
