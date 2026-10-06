import test from "node:test";
import assert from "node:assert/strict";
import { contentFixture, card, settle, classification } from "./helpers.mjs";

function viewport() {
  const observers = [];
  class IntersectionObserver {
    constructor(callback, options = {}) { this.callback = callback; this.options = options; this.targets = new Set(); observers.push(this); }
    observe(target) {
      this.targets.add(target);
      target.getBoundingClientRect = () => {
        const top = target.closest('[data-card]')?.dataset.offscreen ? 2000 : 10;
        return { width: 300, height: 160, left: 0, right: 300, top, bottom: top + 160 };
      };
      queueMicrotask(() => this.callback([{ target, isIntersecting: !target.closest('[data-card]')?.dataset.offscreen }]));
    }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  }
  return { IntersectionObserver, observers };
}
const events = page => page.observations.flatMap(message => message.events);

test("only viewport cards are observed; overlapping literal keywords are recorded without API requests", async t => {
  const view = viewport();
  const html = card("seen", "Crypto reaction") + card("far", "Crypto reaction").replace('data-card="far"', 'data-card="far" data-offscreen="true"');
  const page = await contentFixture(t, html, { keywords: ["crypto", "reaction"], patternVersion: 1 }, undefined, view);
  await settle(); await settle();
  assert.equal(events(page).length, 1);
  assert.equal(events(page)[0].videoId, "seen");
  assert.deepEqual(Array.from(events(page)[0].k), ["crypto", "reaction"]);
  assert.equal(events(page)[0].s, "keyword");
  assert.equal(page.requests.length, 0);
  page.document.dispatchEvent(new page.window.Event("yt-navigate-finish")); await settle(); await settle();
  assert.equal(events(page).length, 1, "rescans do not inflate observations");
  assert.equal(JSON.stringify(page.observations).includes("Crypto reaction"), false, "no titles in telemetry");
});

test("cached classification outcomes count for distinct videos and retain every qualifying category", async t => {
  const view = viewport();
  const result = classification("clickbait");
  result.results.rage_bait = { probability: .91 };
  const page = await contentFixture(t, card("one", "Same title") + card("two", "Same title"),
    { keywords: [], aiEnabled: true, keyConfigured: true, patternVersion: 1, minProbability: .9 }, async () => ({ ok: true, ...result }), view);
  await settle(); await settle(); await settle();
  const completed = events(page).filter(event => event.s === "ai");
  assert.deepEqual([...new Set(completed.map(event => event.videoId))].sort(), ["one", "two"]);
  assert.ok(completed.every(event => event.q === 5 && event.w === 0));
  assert.equal(page.requests.length, 1);
  assert.ok(completed.every(event => event.e > 0));
});

test("keyword-only nonmatches are explicitly AI-not-evaluated, and pause prevents collection", async t => {
  const page = await contentFixture(t, card("plain", "Quiet walk"), { keywords: [], patternVersion: 1 }, undefined, viewport());
  await settle(); await settle();
  assert.equal(events(page)[0].s, "unchecked");
  await page.storage.api.local.set({ enabled: false });
  page.document.body.insertAdjacentHTML("beforeend", card("paused", "Another video"));
  await settle(); await settle();
  assert.equal(events(page).some(event => event.videoId === "paused"), false);
});

test("leaving the viewport makes pending observations unavailable without adding requests", async t => {
  const view = viewport();
  const page = await contentFixture(t, card("pending", "Still waiting"), { aiEnabled: true, keyConfigured: true, patternVersion: 1 }, () => new Promise(() => {}), view);
  await settle(); await settle();
  assert.ok(events(page).some(event => event.s === "pending"));
  const observer = view.observers.find(item => item.options.rootMargin === "0px" && item.options.threshold !== .25);
  const target = page.document.querySelector("ytd-thumbnail");
  target.closest('[data-card]').dataset.offscreen = "true";
  observer.callback([{ target, isIntersecting: false }]);
  await settle(); await settle();
  assert.equal(events(page).at(-1).s, "unavailable");
  assert.equal(page.requests.length, 1);
});

test("new identities on recycled cards are observed independently and hidden matches remain counted", async t => {
  const page = await contentFixture(t, card("first", "Crypto news"), { keywords: ["crypto"], keywordReplacementStyle: "hide", patternVersion: 1 }, undefined, viewport());
  await settle(); await settle();
  assert.equal(events(page)[0].s, "keyword");
  assert.ok(page.document.querySelector('[data-yt-hide-card]'));
  for (const link of page.document.querySelectorAll('a')) link.href = "https://www.youtube.com/watch?v=recycled";
  const title = page.document.querySelector('#video-title'); title.textContent = "A quiet walk"; title.setAttribute("title", "A quiet walk");
  await settle(); await settle();
  assert.ok(events(page).some(event => event.videoId === "recycled" && event.s === "unchecked"));
});

test("background tabs collect nothing until they become visible", async t => {
  const page = await contentFixture(t, card("background", "Crypto news"), { keywords: ["crypto"], patternVersion: 1 }, undefined, { ...viewport(), hidden: true });
  await settle(); await settle();
  assert.equal(events(page).length, 0);
  Object.defineProperty(page.document, "hidden", { configurable: true, value: false });
  page.document.dispatchEvent(new page.window.Event("visibilitychange"));
  await settle(); await settle();
  assert.equal(events(page).length, 1);
  assert.equal(events(page)[0].videoId, "background");
});
