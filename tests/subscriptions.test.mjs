import test from "node:test";
import assert from "node:assert/strict";
import { contentFixture, card, settle, classification } from "./helpers.mjs";
const settings = { keywords: [], aiEnabled: true, keyConfigured: true };

function delayedChannel() {
  const channels = [];
  return { channels, connect: () => () => {
    const messages = new Set(), exits = new Set();
    const channel = { onMessage: { addListener: fn => messages.add(fn) }, onDisconnect: { addListener: fn => exits.add(fn) },
      sent: [], postMessage(message) { channel.sent.push(message); },
      emit(message) { for (const fn of messages) fn(message); }, disconnect() { for (const fn of exits) fn(); } };
    channels.push(channel); return channel;
  } };
}

for (const change of ["remove", "recycle", "keyword"]) {
  test(`page releases ${change} subscriptions before queued evaluation`, async t => {
    const mock = delayedChannel();
    const page = await contentFixture(t, card("a", "Old title"), settings, undefined, { connect: mock.connect });
    const channel = mock.channels[0], request = channel.sent.find(message => message.type === "subscribe");
    if (change === "remove") page.document.querySelector('[data-card]').remove();
    if (change === "recycle") {
      const title = page.document.querySelector('#video-title'); title.textContent = "New title"; title.setAttribute("title", "New title");
    }
    if (change === "keyword") await page.storage.api.local.set({ keywords: ["Old title"] });
    channel.emit({ type: "check", requestId: request.requestId, checkId: "check", aiRevision: request.aiRevision });
    assert.equal(channel.sent.find(message => message.type === "relevance").eligible, false);
    assert.ok(channel.sent.some(message => message.type === "cancel" && message.requestId === request.requestId));
    channel.emit({ type: "result", requestId: request.requestId, aiRevision: request.aiRevision, ok: true, ...classification("clickbait") });
    await settle();
    assert.equal(page.document.querySelector('[data-yt-ai-overlay]'), null);
  });
}

test("duplicate cards keep shared interest until the last eligible card disappears", async t => {
  const mock = delayedChannel();
  const page = await contentFixture(t, card("a", "Same title") + card("b", "Same title"), settings, undefined, { connect: mock.connect });
  const channel = mock.channels[0], request = channel.sent.find(message => message.type === "subscribe");
  assert.equal(channel.sent.filter(message => message.type === "subscribe").length, 1);
  page.document.querySelector('[data-card="a"]').remove();
  await settle();
  channel.emit({ type: "check", requestId: request.requestId, checkId: "check", aiRevision: request.aiRevision });
  assert.equal(channel.sent.find(message => message.type === "relevance").eligible, true);
  channel.emit({ type: "result", requestId: request.requestId, aiRevision: request.aiRevision, ok: true, ...classification("clickbait") });
  await settle();
  assert.ok(page.document.querySelector('[data-card="b"] [data-yt-ai-overlay]'));
});

test("leaving the eligibility margin cancels and returning resubscribes", async t => {
  const mock = delayedChannel(); let observer;
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; observer = this; assert.equal(options.rootMargin, "0px"); }
    observe(target) { target.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: 0, bottom: 160 }); queueMicrotask(() => this.callback([{ target, isIntersecting: true }])); }
    unobserve() {}
    disconnect() {}
  }
  const page = await contentFixture(t, card("a", "Title"), settings, undefined, { connect: mock.connect, IntersectionObserver });
  await settle();
  const target = page.document.querySelector('ytd-thumbnail'), channel = mock.channels[0];
  observer.callback([{ target, isIntersecting: false }]);
  assert.ok(channel.sent.some(message => message.type === "cancel"));
  observer.callback([{ target, isIntersecting: true }]); await new Promise(resolve => setTimeout(resolve, 450));
  assert.equal(channel.sent.filter(message => message.type === "subscribe").length, 2);
});

test("port disconnection recovers subscriptions after a bounded reconnect delay", async t => {
  const mock = delayedChannel();
  const page = await contentFixture(t, card("a", "Title"), settings, undefined, { connect: mock.connect });
  mock.channels[0].disconnect();
  await new Promise(resolve => setTimeout(resolve, 1200));
  assert.equal(mock.channels.length, 2);
  const channel = mock.channels[1], request = channel.sent.find(message => message.type === "subscribe");
  assert.ok(request);
  channel.emit({ type: "result", requestId: request.requestId, aiRevision: request.aiRevision, ok: true, ...classification("clickbait") });
  await settle(); assert.ok(page.document.querySelector('[data-yt-ai-overlay]'));
});

test("pagehide cancels interests and a late result cannot restore the page", async t => {
  const mock = delayedChannel();
  const page = await contentFixture(t, card("a", "Title"), settings, undefined, { connect: mock.connect });
  const channel = mock.channels[0], request = channel.sent.find(message => message.type === "subscribe");
  page.window.dispatchEvent(new page.window.Event("pagehide"));
  assert.ok(channel.sent.some(message => message.type === "cancel"));
  channel.emit({ type: "result", requestId: request.requestId, aiRevision: request.aiRevision, ok: true, ...classification("clickbait") });
  await settle(); assert.equal(page.document.querySelector('[data-yt-ai-overlay]'), null);
});

test("preflight catches scroll changes before the next intersection callback", async t => {
  const mock = delayedChannel();
  class IntersectionObserver {
    constructor(callback) { this.callback = callback; }
    observe(target) { target.getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: 0, bottom: 160 }); queueMicrotask(() => this.callback([{ target, isIntersecting: true }])); }
    unobserve() {}
    disconnect() {}
  }
  const page = await contentFixture(t, card("a", "Title"), settings, undefined, { connect: mock.connect, IntersectionObserver });
  await settle();
  const channel = mock.channels[0], request = channel.sent.find(message => message.type === "subscribe");
  page.document.querySelector('ytd-thumbnail').getBoundingClientRect = () => ({ width: 300, height: 160, left: 0, right: 300, top: -500, bottom: -340 });
  channel.emit({ type: "check", requestId: request.requestId, checkId: "check", aiRevision: request.aiRevision });
  assert.equal(channel.sent.find(message => message.type === "relevance").eligible, false);
});
