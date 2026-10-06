import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { worker, catalog, response, youtube } from './worker-helper.mjs';
import { contentFixture, card, popupFixture, chooseStyle, settle } from './helpers.mjs';

const endpoint = 'https://api.openai.com/v1/decisions';
const url = n => `https://i.ytimg.com/vi/video_${n}/hqdefault.jpg`;
const apiCalls = w => w.calls.filter(([url]) => url === endpoint);
const image = byte => new Response(Uint8Array.of(byte), { headers: { 'content-type': 'image/png' } });
const decision = (options, probability = .02) => ({ ok: true, json: async () => ({ model: 'gpt-6-luna', usage: { input_tokens: 100, output_tokens: 0 }, answers: JSON.parse(options.body).questions.map(q => ({ type: 'predicate', name: q.name, probability: typeof probability === 'function' ? probability(q.name) : probability })) }) });
async function until(check) { for (let i = 0; i < 300; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)); } assert.fail('Condition did not become true'); }

test('upgrade applies the focused preset once and retains actions, threshold, key, and keywords', async () => {
  const w = worker(undefined, { optimizationVersion: 0, enabledClassifiers: ['spoilers'], replacementStyle: 'blur', minProbability: .81, keywords: ['saved'] });
  const settings = (await w.send({ type: 'get-settings' })).settings;
  assert.deepEqual(Array.from(settings.enabledClassifiers), Array.from(catalog.normalize(catalog.presets.focused)));
  assert.equal(settings.replacementStyle, 'blur'); assert.equal(settings.minProbability, .81); assert.deepEqual(Array.from(settings.keywords), ['saved']);
  assert.equal(settings.imageSize, 'original'); assert.equal(settings.imageDetail, 'high'); assert.equal(settings.hideEarlyExit, true);
  assert.equal(w.calls.length, 0);
  await w.chrome.storage.local.set({ enabledClassifiers: ['spoilers'], hideEarlyExit: false });
  const restarted = worker(undefined, structuredClone(w.local));
  assert.deepEqual(Array.from((await restarted.send({ type: 'get-settings' })).settings.enabledClassifiers), ['spoilers']);
  assert.equal(restarted.local.hideEarlyExit, false);
});

test('presets and image controls save, discard, and mark classifier drafts', async t => {
  const ui = await popupFixture(t, { enabledClassifiers: ['spoilers'], replacementStyle: 'blur' });
  const select = (id, value) => { const control = ui.document.getElementById(id); control.value = value; control.dispatchEvent(new ui.window.Event('change', { bubbles: true })); };
  select('category-preset', 'focused'); select('image-size', '512'); select('image-detail', 'low');
  assert.equal(ui.document.querySelector('#classifiers-tab .draft-dot').hidden, false);
  ui.document.getElementById('discard').click();
  assert.equal(ui.document.getElementById('image-size').value, 'original'); assert.equal(ui.document.getElementById('image-detail').value, 'high');
  select('category-preset', 'mouth'); select('image-size', '768'); select('image-detail', 'auto');
  ui.document.querySelector('form').dispatchEvent(new ui.window.Event('submit', { cancelable: true })); await settle();
  assert.deepEqual(Array.from(ui.storage.values.enabledClassifiers), ['wide_open_mouth']); assert.equal(ui.storage.values.imageSize, '768'); assert.equal(ui.storage.values.imageDetail, 'auto');
  assert.equal(ui.storage.values.replacementStyle, 'blur');
});

test('concurrent same-title cards with different images reserve the title question only once', async () => {
  const flights = [];
  const w = worker(async (src, options) => src === endpoint ? new Promise(resolve => flights.push({ options, resolve })) : image(src === url(1) ? 1 : 2), { enabledClassifiers: ['clickbait', 'wide_open_mouth'] });
  const a = w.classify('Shared title', { thumbnailUrl: url(1) }), b = w.classify('Shared title', { thumbnailUrl: url(2), sender: { ...youtube, tab: { id: 2 } } });
  await until(() => flights.length === 2);
  assert.equal(flights.flatMap(f => JSON.parse(f.options.body).questions).filter(q => q.name === 'clickbait').length, 1);
  for (const f of flights) f.resolve(decision(f.options));
  assert.equal((await a).ok, true); assert.equal((await b).ok, true);
});

test('identical decoded pixels at different URLs and titles share a pending image question', async () => {
  let release; const w = worker(async (src, options) => src === endpoint ? new Promise(resolve => { release = () => resolve(decision(options, .99)); }) : image(7), { enabledClassifiers: ['wide_open_mouth'] });
  const a = w.classify('First title', { thumbnailUrl: url(1) }), b = w.classify('Different title', { thumbnailUrl: url(2) });
  await until(() => release && w.calls.filter(([src]) => src !== endpoint).length === 2); await new Promise(r => setTimeout(r, 20));
  assert.equal(apiCalls(w).length, 1); release();
  assert.equal((await a).results.wide_open_mouth.probability, .99); assert.equal((await b).results.wide_open_mouth.probability, .99);
});

test('a later interested job retains a shared question when its first owner cancels', async () => {
  const flights = []; const w = worker(async (src, options) => src === endpoint ? new Promise(resolve => flights.push({ options, resolve })) : image(src === url(1) ? 1 : 2), { enabledClassifiers: ['clickbait', 'wide_open_mouth'] });
  const a = await w.subscribe('Shared', { thumbnailUrl: url(1) }); await until(() => flights.length === 1);
  const b = await w.subscribe('Shared', { thumbnailUrl: url(2) }); await until(() => flights.length === 2);
  a.cancel(); assert.equal((await a.result).code, 'cancelled');
  for (const f of flights) f.resolve(decision(f.options));
  assert.equal((await b.result).ok, true); assert.equal(apiCalls(w).length, 2);
});

test('hide-mode title match skips downloads and reports only evaluated categories', async () => {
  const w = worker(async (src, options) => { assert.equal(src, endpoint); return decision(options, .99); }, { enabledClassifiers: ['clickbait', 'wide_open_mouth'], replacementStyle: 'hide' });
  const result = await w.classify('Title match', { thumbnailUrl: url(1) });
  assert.deepEqual(result.evaluatedIds, ['clickbait']); assert.deepEqual(result.skippedIds, ['wide_open_mouth']);
  assert.equal(result.results.wide_open_mouth, undefined); assert.equal(w.calls.length, 1);
  await w.chrome.storage.local.set({ minProbability: 1 });
  // The title is cached, but the changed threshold now needs the image.
  w.calls.length = 0;
  const request = await w.subscribe('Title match', { thumbnailUrl: url(1) });
  assert.equal((await request.result).code, 'thumbnail'); assert.equal(w.calls.length, 1);
});

for (const [style, early] of [['blur', true], ['hide', false], ['hide', true]]) test(`${style}, early=${early}: title miss still evaluates images`, async () => {
  const w = worker(async (src, options) => src === endpoint ? decision(options, id => id === 'wide_open_mouth' ? .99 : .02) : image(4), { enabledClassifiers: ['clickbait', 'wide_open_mouth'], replacementStyle: style, hideEarlyExit: early });
  const result = await w.classify('Ordinary', { thumbnailUrl: url(1) });
  assert.equal(result.results.wide_open_mouth.probability, .99); assert.deepEqual(result.skippedIds, []);
  assert.equal(apiCalls(w).length, style === 'hide' && early ? 2 : 1);
});

test('partial response caches valid answers; only unresolved questions retry after 60s', async () => {
  let now = Date.now(), broken = true;
  const w = worker(async (src, options) => ({ ok: true, json: async () => ({ model: 'gpt-6-luna', usage: { input_tokens: 100 }, answers: JSON.parse(options.body).questions.map(q => q.name === 'rage_bait' && broken ? { type: 'predicate', name: q.name, probability: 'invalid' } : { type: 'predicate', name: q.name, probability: .95 }) }) }), { enabledClassifiers: ['clickbait', 'rage_bait'] }, {}, { now: () => now });
  assert.equal((await w.classify('Title')).code, 'response');
  assert.deepEqual(Object.keys(w.local.evaluationCache.entries[0][1]), ['clickbait']);
  assert.equal((await w.classify('Title')).code, 'response'); assert.equal(apiCalls(w).length, 1);
  now += 60001; broken = false;
  assert.equal((await w.classify('Title')).ok, true);
  assert.deepEqual(JSON.parse(apiCalls(w)[1][1].body).questions.map(q => q.name), ['rage_bait']);
  assert.equal((await w.send({ type: 'get-analytics' }, { id: 'extension-test', url: 'chrome-extension://extension-test/popup.html' })).ledger.totals.attempts, 2);
});

test('repeated invalid answers and refusals use one-hour per-question cooldowns without blocking other evidence', async () => {
  for (const code of ['response', 'refusal']) {
    let now = Date.now(); const w = worker(async (src, options) => ({ ok: true, json: async () => ({ answers: JSON.parse(options.body).questions.map(q => ({ name: q.name, type: code === 'refusal' ? 'refusal' : 'predicate', probability: -1 })) }) }), { enabledClassifiers: ['clickbait'] }, {}, { now: () => now });
    const first = await w.classify('Title'); assert.equal(first.code, code);
    now += 60001;
    const second = await w.classify('Title');
    assert.equal(apiCalls(w).length, code === 'refusal' ? 1 : 2);
    assert.ok(second.retryAt >= now + 3500000);
    await w.classify('Other title'); assert.equal(apiCalls(w).length, code === 'refusal' ? 2 : 3);
    const restarted = worker(undefined, structuredClone(w.local), {}, { now: () => now });
    assert.equal((await restarted.classify('Title')).code, code); assert.equal(restarted.calls.length, 0);
  }
});

test('URL aliases expire in one hour; unchanged pixels reuse scores, changed pixels reevaluate', async () => {
  let now = Date.now(), pixel = 1;
  const w = worker(async (src, options) => src === endpoint ? decision(options, .99) : image(pixel), { enabledClassifiers: ['wide_open_mouth'] }, {}, { now: () => now });
  await w.classify('Title', { thumbnailUrl: url(1) }); assert.equal(w.calls.length, 2);
  await w.classify('Title', { thumbnailUrl: url(1) }); assert.equal(w.calls.length, 2);
  now += 3600001; await w.classify('Title', { thumbnailUrl: url(1) }); assert.equal(w.calls.length, 3); assert.equal(apiCalls(w).length, 1);
  pixel = 2; now += 3600001; await w.classify('Title', { thumbnailUrl: url(1) }); assert.equal(apiCalls(w).length, 2);
});

test('image profile changes invalidate only image scores, with requested detail on the wire', async () => {
  const w = worker(async (src, options) => src === endpoint ? decision(options) : image(1), { enabledClassifiers: ['clickbait', 'wide_open_mouth'] });
  await w.classify('Title', { thumbnailUrl: url(1) });
  await w.chrome.storage.local.set({ imageSize: '512', imageDetail: 'low' });
  await w.classify('Title', { thumbnailUrl: url(1) });
  const body = JSON.parse(apiCalls(w)[1][1].body);
  assert.deepEqual(body.questions.map(q => q.name), ['wide_open_mouth']); assert.equal(body.input[0].content[1].detail, 'low');
});

test('API and image pools independently bound execution without blocking shared waiters', async () => {
  const context = vm.createContext({}); vm.runInContext(await readFile(new URL('../extension/work-sharing.js', import.meta.url), 'utf8'), context);
  const pool = new context.ThumbnailWork.Pool(); let active = 0, maximum = 0;
  await Promise.all(Array.from({ length: 12 }, () => pool.run(async () => { maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 5)); active--; })));
  assert.equal(maximum, 2);
});

test('hidden tabs and short visibility never subscribe; visible dwell is continuous', async t => {
  const page = await contentFixture(t, card('a', 'Title'), { aiEnabled: true, keyConfigured: true }, async () => ({ ok: true, label: 'clickbait' }), { hidden: true });
  assert.equal(page.requests.length, 0);
  Object.defineProperty(page.document, 'hidden', { configurable: true, value: false });
  page.document.dispatchEvent(new page.window.Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 150)); assert.equal(page.requests.length, 0);
  Object.defineProperty(page.document, 'hidden', { configurable: true, value: true }); page.document.dispatchEvent(new page.window.Event('visibilitychange'));
  await settle(); assert.equal(page.requests.length, 0);
  Object.defineProperty(page.document, 'hidden', { configurable: true, value: false }); page.document.dispatchEvent(new page.window.Event('visibilitychange'));
  await new Promise(r => setTimeout(r, 450)); assert.equal(page.requests.length, 1);
});

test('early-exit page results exclude skipped mouth from analytics and cannot survive a change to blur', async t => {
  let complete = false;
  const page = await contentFixture(t, card('a', 'Title'), { aiEnabled: true, keyConfigured: true, enabledClassifiers: ['clickbait', 'wide_open_mouth'], replacementStyle: 'hide', patternVersion: 1 }, async message => ({ ok: true, schemaVersion: catalog.schemaVersion, results: complete ? { clickbait: { probability: .99 }, wide_open_mouth: { probability: .01 } } : { clickbait: { probability: .99 } }, evaluatedIds: complete ? ['clickbait', 'wide_open_mouth'] : ['clickbait'], skippedIds: complete ? [] : ['wide_open_mouth'] }));
  await until(() => page.document.querySelector('[data-yt-hide-card]'));
  assert.ok(page.document.querySelector('[data-yt-hide-card]'));
  await new Promise(r => setTimeout(r, 700));
  const rows = page.observations.flatMap(x => x.events).filter(row => row.s === 'ai');
  assert.ok(rows.length); assert.equal(rows.at(-1).e, 1); assert.equal(rows.at(-1).q, 1);
  complete = true; await page.storage.api.local.set({ replacementStyle: 'blur' }); await settle();
  assert.equal(page.requests.length, 2); assert.equal(page.document.querySelector('[data-yt-hide-card]'), null);
  assert.equal(page.document.querySelector('[data-yt-replacement-style]').getAttribute('data-yt-replacement-style'), 'blur');
});

test('intersection ratio and current geometry must both reach 25% before continuous dwell', async t => {
  let observer, target, overlap = 74;
  class IntersectionObserver {
    constructor(callback, options) { this.callback = callback; observer = this; assert.equal(options.threshold, .25); assert.equal(options.rootMargin, '0px'); }
    observe(element) { target = element; target.getBoundingClientRect = () => ({ width: 300, height: 160, left: target.ownerDocument.defaultView.innerWidth - overlap, right: target.ownerDocument.defaultView.innerWidth - overlap + 300, top: 0, bottom: 160 }); queueMicrotask(() => this.callback([{ target, isIntersecting: true, intersectionRatio: .24 }])); }
    unobserve() {} disconnect() {}
  }
  const page = await contentFixture(t, card('a', 'Title'), { aiEnabled: true, keyConfigured: true }, async () => ({ ok: true, label: 'clickbait' }), { IntersectionObserver });
  assert.equal(page.requests.length, 0);
  observer.callback([{ target, isIntersecting: true, intersectionRatio: .30 }]); await settle();
  assert.equal(page.requests.length, 0, 'geometry can reject a stale observer report');
  overlap = 75; observer.callback([{ target, isIntersecting: true, intersectionRatio: .25 }]);
  await new Promise(r => setTimeout(r, 150)); assert.equal(page.requests.length, 0);
  await settle(); assert.equal(page.requests.length, 1);
});

test('image preparations stay at two even while many logical jobs are waiting', async () => {
  let active = 0, maximum = 0;
  const w = worker(async (src, options) => {
    if (src === endpoint) return decision(options, .99);
    maximum = Math.max(maximum, ++active); await new Promise(r => setTimeout(r, 10)); active--; return image(1);
  }, { enabledClassifiers: ['wide_open_mouth'] });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => w.classify(`Title ${i}`, { thumbnailUrl: url(i) })));
  assert.ok(results.every(r => r.ok)); assert.equal(maximum, 2); assert.equal(apiCalls(w).length, 1);
});

test('question cooldown persists after credential rotation and worker restart', async () => {
  const w = worker(async (src, options) => ({ ok: true, json: async () => ({ answers: JSON.parse(options.body).questions.map(q => ({ name: q.name, type: 'refusal' })) }) }), { enabledClassifiers: ['clickbait'] });
  await w.chrome.storage.local.set({ openaiApiKey: 'rotated-test-key' });
  assert.equal((await w.classify('Title')).code, 'refusal');
  const restarted = worker(undefined, structuredClone(w.local));
  assert.equal((await restarted.classify('Title')).code, 'refusal'); assert.equal(restarted.calls.length, 0);
});

test('queued shared title survives cancellation without paying for its former owner’s image', async () => {
  const flights = [];
  const w = worker(async (src, options) => src === endpoint ? new Promise(resolve => flights.push({ options, resolve })) : image(Number(src.match(/video_(\d+)/)[1])), { enabledClassifiers: ['clickbait', 'wide_open_mouth'] });
  const blockers = [w.classify('Blocker 1', { thumbnailUrl: url(1) }), w.classify('Blocker 2', { thumbnailUrl: url(2) })];
  await until(() => flights.length === 2);
  const a = await w.subscribe('Shared title', { thumbnailUrl: url(3) });
  const b = await w.subscribe('Shared title', { thumbnailUrl: url(4) });
  await until(() => w.calls.filter(([src]) => src !== endpoint).length === 4); await new Promise(r => setTimeout(r, 20));
  a.cancel(); assert.equal((await a.result).code, 'cancelled');
  for (const f of flights) f.resolve(decision(f.options));
  await until(() => flights.length === 4);
  const newQuestions = flights.slice(2).flatMap(f => JSON.parse(f.options.body).questions.map(q => q.name));
  assert.deepEqual(newQuestions.sort(), ['clickbait', 'wide_open_mouth']);
  for (const f of flights.slice(2)) f.resolve(decision(f.options));
  await Promise.all(blockers); assert.equal((await b.result).ok, true);
});

test('missing thumbnail sources still allow title filtering without fabricated mouth scores', async t => {
  const html = card('a', 'Title').replace('https://i.ytimg.com/vi/a/hqdefault.jpg', 'https://example.invalid/image.jpg');
  const page = await contentFixture(t, html, { aiEnabled: true, keyConfigured: true, enabledClassifiers: ['clickbait', 'wide_open_mouth'] }, async () => ({ ok: true, label: 'clickbait' }));
  await until(() => page.document.querySelector('[data-yt-red-mask="purple"]'));
  assert.equal(page.requests.length, 1); assert.equal(page.requests[0].thumbnailUrl, null);
});
