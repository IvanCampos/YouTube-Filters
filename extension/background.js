importScripts("classifiers.js", "decisions.js", "thumbnail-images.js", "keywords.js", "evaluation-cache.js", "work-sharing.js", "spending.js", "patterns.js");

(() => {
  "use strict";
  const DEFAULTS = { enabled: true, keywords: [], aiEnabled: false, openaiApiKey: "", keywordColor: "#ff0000", aiColor: "#8000ff", minProbability: 0.9, replacementStyle: null, keywordReplacementStyle: null, enabledClassifiers: null, optimizationVersion: 0, hideEarlyExit: true, imageSize: "original", imageDetail: "high" };
  const classifiers = globalThis.ThumbnailClassifiers;
  const { EvaluationCache, hash } = globalThis.ThumbnailEvaluationCache;
  let settings = { ...DEFAULTS };
  const enabledIds = () => classifiers.normalize(settings.enabledClassifiers);
  const automatic = () => settings.enabled && settings.aiEnabled && settings.openaiApiKey && enabledIds().length > 0;
  let revision = crypto.randomUUID();
  let scoreRevision = crypto.randomUUID();
  let credentialGeneration = 0;
  let active = 0;
  const apiPool = new ThumbnailWork.Pool(), imagePool = new ThumbnailWork.Pool();
  const questions = new ThumbnailWork.Questions(), preparations = new Map();
  let blocked = null;
  let temporaryFailures = 0;
  const queue = [];
  const jobs = new Map();
  const clients = new Set();
  const controllers = new Set();
  const spending = new ThumbnailSpending.SpendingLedger(chrome.storage.local);
  const patterns = new ThumbnailPatterns.PatternLedger(chrome.storage.local);
  const cache = new EvaluationCache(chrome.storage.local, OpenAIDecisions.MODEL, () => {
    chrome.storage.session.set({ cacheStatus: { error: "Classification cache could not be saved. Scores remain available until the worker restarts." } }).catch(() => {});
  });

  function publicSettings() {
    return { enabled: settings.enabled !== false, keywords: settings.keywords,
      patternVersion: patterns.value?.version || 0, patternTimeZone: patterns.value?.timeZone || "UTC",
      aiEnabled: settings.aiEnabled === true, keyConfigured: Boolean(settings.openaiApiKey), aiRevision: revision, scoreRevision,
      enabledClassifiers: enabledIds(), hideEarlyExit: settings.hideEarlyExit !== false,
      imageSize: classifiers.cleanImageSize(settings.imageSize), imageDetail: classifiers.cleanImageDetail(settings.imageDetail), classificationVersion: classifiers.schemaVersion,
      keywordColor: RedThumbnailKeywords.cleanColor(settings.keywordColor, "#ff0000"),
      aiColor: RedThumbnailKeywords.cleanColor(settings.aiColor, "#8000ff"),
      minProbability: RedThumbnailKeywords.cleanThreshold(settings.minProbability, 0.9),
      replacementStyle: RedThumbnailKeywords.cleanStyle(settings.replacementStyle),
      keywordReplacementStyle: RedThumbnailKeywords.cleanStyle(settings.keywordReplacementStyle, "blur") };
  }
  const publish = () => chrome.storage.session.set({ publicSettings: publicSettings() });
  async function persist() {
    if (await cache.persist()) {
      await chrome.storage.session.set({ cacheStatus: null }).catch(() => {});
      return true;
    }
    return false;
  }
  const ready = (async () => {
    await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
    await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" });
    await spending.initialize();
    settings = await chrome.storage.local.get(DEFAULTS);
    if (!Number.isSafeInteger(settings.optimizationVersion) || settings.optimizationVersion < 1) {
      const patch = { enabledClassifiers: classifiers.normalize(classifiers.presets.focused), hideEarlyExit: true, optimizationVersion: 1 };
      await chrome.storage.local.set(patch); Object.assign(settings, patch);
    }
    await patterns.initialize(settings, spending.value.timeZone);
    if (settings.keywordReplacementStyle == null) {
      settings.keywordReplacementStyle = RedThumbnailKeywords.cleanStyle(settings.replacementStyle, "blur");
      await chrome.storage.local.set({ keywordReplacementStyle: settings.keywordReplacementStyle });
    }
    await cache.initialize(settings.openaiApiKey);
    const session = await chrome.storage.session.get({ classificationCache: [], publicSettings: null, aiStatus: null });
    const compatible = session.publicSettings?.classificationVersion === classifiers.schemaVersion;
    if (compatible && JSON.stringify(session.publicSettings.enabledClassifiers) === JSON.stringify(enabledIds())) revision = session.publicSettings.aiRevision || revision;
    if (await persist()) await chrome.storage.session.remove("classificationCache");
    if (session.aiStatus?.ok === false && !["thumbnail", "refusal", "response"].includes(session.aiStatus.code)) {
      blocked = session.aiStatus; temporaryFailures = blocked.attempts || 0;
    }
    await publish();
  })();
  let updates = ready;

  function post(client, value) {
    if (client.closed) return;
    try { client.port.postMessage(value); } catch { disconnect(client); }
  }
  function finish(sub, result) {
    if (sub.done) return;
    sub.done = true;
    sub.client.subs.delete(sub.id);
    sub.job?.subscribers.delete(sub);
    for (const [id, check] of sub.client.checks) if (check.sub === sub) { sub.client.checks.delete(id); check.resolve(false); }
    post(sub.client, { type: "result", requestId: sub.id, ...result });
    const job = sub.job;
    if (job && !job.running && !job.subscribers.size) {
      const index = queue.indexOf(job);
      if (index >= 0) queue.splice(index, 1);
      if (jobs.get(job.key) === job) jobs.delete(job.key);
    }
  }
  function invalidateSubscriptions() {
    revision = crypto.randomUUID();
    for (const client of clients) for (const sub of [...client.subs.values()]) finish(sub, { ok: false, code: "changed" });
  }
  function disconnect(client) {
    if (client.closed) return;
    client.closed = true;
    for (const sub of [...client.subs.values()]) finish(sub, { ok: false, code: "cancelled" });
    clients.delete(client);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !Object.keys(DEFAULTS).some(key => key in changes)) return;
    updates = updates.catch(() => {}).then(async () => {
      const next = await chrome.storage.local.get(DEFAULTS);
      const keyChanged = settings.openaiApiKey !== next.openaiApiKey;
      const reset = keyChanged || settings.enabled !== next.enabled || settings.aiEnabled !== next.aiEnabled ||
        JSON.stringify(enabledIds()) !== JSON.stringify(classifiers.normalize(next.enabledClassifiers)) ||
        ["minProbability", "replacementStyle", "hideEarlyExit", "imageSize", "imageDetail"].some(key => settings[key] !== next[key]);
      if (reset) invalidateSubscriptions();
      settings = next;
      if (keyChanged) {
        credentialGeneration++; scoreRevision = crypto.randomUUID();
        for (const controller of controllers) controller.abort();
        jobs.clear(); preparations.clear();
        blocked = null; temporaryFailures = 0;
        await cache.clear(settings.openaiApiKey);
        // A credential change must not allow legacy entries to return on restart.
        await chrome.storage.session.remove("classificationCache");
        await chrome.storage.session.set({ aiStatus: null });
      }
      await patterns.updateSettings(settings);
      await publish();
      pump();
    });
  });
  function trustedPopup(sender) {
    return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL("popup.html");
  }
  function youtubeSender(sender) {
    if (sender.id !== chrome.runtime.id || !sender.tab) return false;
    try { const url = new URL(sender.url); return ["https:", "http:"].includes(url.protocol) && /(^|\.)youtube\.com$/.test(url.hostname); }
    catch { return false; }
  }
  function eligible(sub) {
    return !sub.done && !sub.client.closed && sub.revision === revision && automatic() &&
      !RedThumbnailKeywords.createMatcher(settings.keywords)(sub.title);
  }
  function confirm(sub) {
    if (!eligible(sub)) return Promise.resolve(false);
    return new Promise(resolve => {
      const checkId = crypto.randomUUID();
      const timer = setTimeout(() => { sub.client.checks.delete(checkId); resolve(false); }, 1000);
      sub.client.checks.set(checkId, { sub, resolve: value => { clearTimeout(timer); resolve(value); } });
      post(sub.client, { type: "check", requestId: sub.id, checkId, aiRevision: revision });
    });
  }
  async function callApi(title, ids, epoch, test = false, needed = () => true, imageData = null, detail = "high") {
    if (epoch !== credentialGeneration) return { ok: false, code: "changed" };
    if (!settings.openaiApiKey) return { ok: false, code: "key", error: "Save your OpenAI Decisions API key first." };
    if (test) blocked = null;
    if (blocked && (!blocked.retryAt || blocked.retryAt > Date.now())) return blocked;
    const controller = new AbortController();
    controllers.add(controller);
    const attemptId = crypto.randomUUID();
    const apiKey = settings.openaiApiKey;
    let timeout;
    try {
      timeout = setTimeout(() => controller.abort(), 12000);
      await updates;
      if (epoch !== credentialGeneration || controller.signal.aborted) return { ok: false, code: "changed" };
      if (!needed() || !await (needed.verify?.() ?? true)) return { ok: false, code: "cancelled" };
      await spending.begin(attemptId, test ? "test" : "automatic");
      await updates;
      // The key may have changed while the pending journal was being saved.
      if (epoch !== credentialGeneration || controller.signal.aborted) {
        await spending.cancel(attemptId);
        return { ok: false, code: "changed" };
      }
      if (!needed() || !await (needed.verify?.() ?? true)) {
        await spending.cancel(attemptId);
        return { ok: false, code: "cancelled" };
      }
      if (blocked && (!blocked.retryAt || blocked.retryAt > Date.now())) {
        const reason = blocked;
        await spending.cancel(attemptId);
        return reason;
      }
      const finalIds = needed.ids?.(ids) || ids;
      if (!finalIds.length) { await spending.cancel(attemptId); return { ok: false, code: "cancelled" }; }
      const value = await OpenAIDecisions.classify(title, apiKey, controller.signal, finalIds, undefined,
        metadata => spending.complete(attemptId, metadata), imageData, detail);
      if (epoch !== credentialGeneration) return { ok: false, code: "changed" };
      if (test && !value.complete) return { ok: false, code: "response", error: "OpenAI returned an incomplete decision.", retryAt: Date.now() + 60000 };
      blocked = null; temporaryFailures = 0;
      await chrome.storage.session.set({ aiStatus: { ok: true, message: "OpenAI Decisions is connected.", at: Date.now() } }).catch(() => {});
      return { ok: true, ...value };
    } catch (error) {
      if (epoch !== credentialGeneration) return { ok: false, code: "changed" };
      const result = { ok: false, code: error.code || "network", error: error instanceof OpenAIDecisions.ClassificationError ? error.message : "Classification failed. Please try again.", retryAt: error.retryAt || 0 };
      if (result.retryAt) {
        temporaryFailures++;
        result.attempts = temporaryFailures;
        result.retryAt = Math.max(result.retryAt, Date.now() + Math.min(300000, 30000 * 2 ** Math.min(temporaryFailures - 1, 4)));
      }
      // A broken thumbnail or per-item refusal must not stop unrelated videos.
      if (!["thumbnail", "refusal", "response"].includes(result.code)) blocked = result;
      await chrome.storage.session.set({ aiStatus: { ...result, at: Date.now() } }).catch(() => {});
      return result;
    } finally {
      clearTimeout(timeout); controllers.delete(controller);
      // No response body (abort, timeout, network loss) leaves an unresolved cost.
      await spending.complete(attemptId);
    }
  }
  const jobIds = job => enabledIds().filter(id => !classifiers.isImage(id) || job.thumbnailUrl);
  const earlyMode = () => settings.hideEarlyExit !== false && RedThumbnailKeywords.cleanStyle(settings.replacementStyle) === "hide";
  function readJobCache(job, ids = jobIds(job)) {
    const results = {}, missing = []; let expires = Infinity;
    for (const id of ids) {
      const hit = classifiers.isImage(id) && job.imageExpires <= Date.now() ? { missing: [id] } : cache.read(classifiers.isImage(id) ? job.imageKey : job.titleKey, [id]);
      if (hit.missing.length) missing.push(id);
      else { results[id] = hit.results[id]; expires = Math.min(expires, hit.expires); }
    }
    if (ids.some(classifiers.isImage) && job.imageKey) expires = Math.min(expires, job.imageExpires || 0);
    return { results, missing, expires: Number.isFinite(expires) ? expires : 0 };
  }
  function deliverCached(job) {
    const ids = jobIds(job), titles = ids.filter(id => !classifiers.isImage(id));
    const hit = readJobCache(job), titleHit = readJobCache(job, titles);
    const skip = earlyMode() && titles.length && !titleHit.missing.length && classifiers.strongest({ schemaVersion: classifiers.schemaVersion, results: titleHit.results }, titles, publicSettings().minProbability);
    const chosen = skip ? titleHit : hit;
    if (chosen.missing.length || !Object.keys(chosen.results).length) return;
    for (const sub of [...job.subscribers]) {
      if (!eligible(sub)) { finish(sub, { ok: false, code: "cancelled" }); continue; }
      finish(sub, { ok: true, schemaVersion: classifiers.schemaVersion, results: chosen.results, expires: chosen.expires,
        evaluatedIds: skip ? titles : ids, skippedIds: skip ? ids.filter(id => !titles.includes(id)) : [], aiRevision: revision });
    }
  }
  function interest(job) {
    const needed = () => job.epoch === credentialGeneration && [...job.subscribers].some(eligible);
    needed.verify = async () => {
      const confirmations = await Promise.all([...job.subscribers].map(async sub => {
        const valid = await confirm(sub);
        if (!valid) finish(sub, { ok: false, code: "deferred", retryAt: Date.now() + 1000 });
        return valid;
      }));
      return needed() && confirmations.some(Boolean);
    };
    return needed;
  }
  async function getImage(job, needed) {
    const images = jobIds(job).filter(classifiers.isImage);
    if (job.imageExpires > Date.now() && job.imageKey && !cache.read(job.imageKey, images).missing.length) return;
    const key = `${job.epoch}:${job.urlKey}`;
    let preparation = preparations.get(key);
    if (!preparation) {
      preparation = { interests: new Set() };
      preparations.set(key, preparation);
      const profile = classifiers.imageProfile(settings), size = settings.imageSize;
      preparation.promise = imagePool.run(async () => {
        const relevant = () => job.epoch === credentialGeneration && [...preparation.interests].some(check => check());
        if (!relevant()) return null;
        const controller = new AbortController(); controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), 12000);
        try {
          const image = await ThumbnailImages.prepare(job.thumbnailUrl, controller.signal, undefined, undefined, size);
          if (!relevant()) return null;
          const imageKey = await hash(`image:${profile}:${image.pixelHash}:${image.width}x${image.height}`);
          if (!relevant()) return null;
          cache.setAlias(job.urlKey, imageKey);
          await persist();
          return { ...image, imageKey, expires: cache.alias(job.urlKey)?.expires };
        } finally { clearTimeout(timer); controllers.delete(controller); }
      }).finally(() => { if (preparations.get(key) === preparation) preparations.delete(key); });
    }
    preparation.interests.add(needed);
    try {
      const image = await preparation.promise;
      if (image) Object.assign(job, { imageKey: image.imageKey, imageData: image.dataURL, imageExpires: image.expires });
    } catch (error) {
      throw new OpenAIDecisions.ClassificationError("thumbnail", error instanceof ThumbnailImages.ThumbnailError ? error.message : "The thumbnail could not be loaded.", Date.now() + 60000);
    } finally { preparation.interests.delete(needed); }
  }
  async function evaluate(job, ids, needed) {
    const items = [];
    for (const id of readJobCache(job, ids).missing) {
      const evidence = classifiers.isImage(id) ? job.imageKey : job.titleKey;
      const failureKey = await hash(`${evidence}:${id}:${cache.fingerprints[id]}`);
      const key = `${job.epoch}:${failureKey}`;
      const failure = cache.failure(failureKey);
      if (failure?.retryAt > Date.now()) return { ok: false, ...failure, error: "Some selected categories could not be evaluated. Cached answers will be reused." };
      items.push({ id, key, failureKey });
    }
    const outcomes = await questions.run(items, needed, async (owned, relevant) => apiPool.run(async () => {
      const responses = {}, fresh = [];
      // Cache writes can finish while hashing, preparing images, or waiting for
      // an API slot. Recheck at dispatch so reservations never repay that work.
      for (const item of owned) {
        const hit = cache.read(classifiers.isImage(item.id) ? job.imageKey : job.titleKey, [item.id]);
        const failure = cache.failure(item.failureKey);
        if (!hit.missing.length) responses[item.id] = { ok: true };
        else if (failure?.retryAt > Date.now()) responses[item.id] = { ok: false, ...failure };
        else fresh.push(item);
      }
      if (!fresh.length) return responses;
      const requested = fresh.map(item => item.id);
      relevant.ids = ids => ids.filter(id => owned.some(item => item.id === id && [...item.reservation.interests].some(check => check())));
      const result = await callApi(requested.every(classifiers.isImage) ? "Evaluate the thumbnail." : job.title, requested, job.epoch, false, relevant, job.imageData, classifiers.cleanImageDetail(settings.imageDetail));
      if (job.epoch !== credentialGeneration) return Object.fromEntries(owned.map(item => [item.id, { ok: false, code: "changed" }]));
      for (const item of fresh) {
        if (result.ok && result.results[item.id]) {
          cache.merge(classifiers.isImage(item.id) ? job.imageKey : job.titleKey,
            { schemaVersion: classifiers.schemaVersion, results: { [item.id]: result.results[item.id] } }, [item.id]);
          cache.failures.delete(item.failureKey); responses[item.id] = { ok: true };
        } else if (result.ok && result.unresolved[item.id]) responses[item.id] = { ok: false, ...cache.fail(item.failureKey, result.unresolved[item.id].code), error: "Some selected categories could not be evaluated. Cached answers will be reused." };
        else if (result.ok) responses[item.id] = { ok: false, code: "cancelled" };
        else responses[item.id] = result;
      }
      await persist(); return responses;
    }));
    return Object.values(outcomes).find(value => !value?.ok) || { ok: true };
  }
  async function runJob(job) {
    await updates;
    if (job.epoch !== credentialGeneration) { if (job.test) job.resolve({ ok: false, code: "changed" }); return; }
    if (job.test) { job.resolve(await apiPool.run(() => callApi(job.title, ["clickbait"], job.epoch, true))); return; }
    deliverCached(job);
    const needed = interest(job);
    if (!needed() || !await needed.verify()) return;
    const ids = jobIds(job), titles = ids.filter(id => !classifiers.isImage(id));
    let outcome = { ok: true };
    if (earlyMode() && titles.length) {
      outcome = await evaluate(job, titles, needed);
      deliverCached(job);
      if (!needed()) return;
    }
    if (outcome.ok && ids.some(classifiers.isImage)) {
      try { await getImage(job, needed); }
      catch (error) { outcome = { ok: false, code: error.code, error: error.message, retryAt: error.retryAt }; }
    }
    if (needed() && outcome.ok) outcome = await evaluate(job, ids, needed);
    await updates;
    if (job.epoch !== credentialGeneration) return;
    deliverCached(job);
    if (!outcome.ok && outcome.error) await chrome.storage.session.set({ aiStatus: { ...outcome, at: Date.now() } }).catch(() => {});
    for (const sub of [...job.subscribers]) finish(sub, outcome.ok ? { ok: false, code: "cancelled", retryAt: Date.now() + 1000 } : outcome);
    job.imageData = null;
  }
  function pump() {
    while (queue.length) {
      const job = queue.shift();
      job.queued = false; job.running = true; active++;
      runJob(job).catch(() => {
        if (job.test) job.resolve({ ok: false, code: "storage", error: "Extension storage is unavailable." });
        else for (const sub of [...job.subscribers]) finish(sub, { ok: false, code: "unavailable", retryAt: Date.now() + 1000 });
      }).finally(() => {
        job.running = false; active--;
        if (!job.test && job.epoch === credentialGeneration && job.subscribers.size) enqueue(job);
        else if (jobs.get(job.key) === job) jobs.delete(job.key);
        pump();
      });
    }
  }
  function enqueue(job) {
    if (job.running || job.queued) return;
    if (queue.length + active >= 100) {
      const result = { ok: false, code: "busy", retryAt: Date.now() + 5000 };
      if (job.test) job.resolve(result);
      else for (const sub of [...job.subscribers]) finish(sub, result);
      return;
    }
    job.queued = true; queue.push(job); pump();
  }
  async function subscribe(client, message) {
    if (client.subs.has(message.requestId)) return;
    const sub = { id: message.requestId, client, title: typeof message.title === "string" ? message.title.trim() : "", revision: message.aiRevision, done: false, job: null };
    client.subs.set(sub.id, sub);
    await updates;
    if (sub.done) return;
    if (typeof message.title !== "string" || !sub.title || message.title.length > 1000) { finish(sub, { ok: false, code: "title" }); return; }
    if (sub.revision !== revision) { finish(sub, { ok: false, code: "changed" }); return; }
    if (!eligible(sub)) { finish(sub, { ok: false, code: "disabled" }); return; }
    const epoch = credentialGeneration;
    const thumbnailUrl = enabledIds().some(classifiers.isImage) ? ThumbnailImages.cleanURL(message.thumbnailUrl) : null;
    if (message.thumbnailUrl != null && enabledIds().some(classifiers.isImage) && !thumbnailUrl) {
      finish(sub, { ok: false, code: "thumbnail", retryAt: Date.now() + 60000 }); return;
    }
    if (!thumbnailUrl && !enabledIds().some(id => !classifiers.isImage(id))) {
      finish(sub, { ok: false, code: "thumbnail", retryAt: Date.now() + 60000 }); return;
    }
    const titleKey = await hash(sub.title);
    const urlKey = thumbnailUrl ? await hash(`thumbnail:${classifiers.imageProfile(settings)}:${thumbnailUrl}`) : null;
    const alias = urlKey ? cache.alias(urlKey) : null;
    const imageKey = alias?.key || null;
    const key = `${epoch}:${revision}:${titleKey}:${urlKey || ""}`;
    if (sub.done || epoch !== credentialGeneration || !eligible(sub)) { finish(sub, { ok: false, code: "changed" }); return; }
    let job = jobs.get(key);
    if (!job) { job = { key, titleKey, imageKey, urlKey, imageExpires: alias?.expires || 0, thumbnailUrl, title: sub.title, epoch, subscribers: new Set(), running: false, queued: false }; jobs.set(key, job); }
    sub.job = job; job.subscribers.add(sub);
    deliverCached(job);
    if (job.subscribers.size) enqueue(job);
  }
  chrome.runtime.onConnect.addListener(port => {
    if (port.name !== "thumbnail-classification" || !youtubeSender(port.sender)) { port.disconnect(); return; }
    const client = { port, subs: new Map(), checks: new Map(), closed: false };
    clients.add(client);
    port.onDisconnect.addListener(() => disconnect(client));
    port.onMessage.addListener(message => {
      if (client.closed || typeof message?.requestId !== "string" || message.requestId.length > 100) return;
      if (message.type === "subscribe") {
        subscribe(client, message).catch(() => {
          const sub = client.subs.get(message.requestId);
          if (sub) finish(sub, { ok: false, code: "unavailable", retryAt: Date.now() + 1000 });
        });
      } else if (message.type === "cancel") {
        const sub = client.subs.get(message.requestId);
        if (sub) finish(sub, { ok: false, code: "cancelled" });
      } else if (message.type === "relevance") {
        const check = client.checks.get(message.checkId);
        if (check?.sub.id === message.requestId) {
          client.checks.delete(message.checkId);
          check.resolve(message.eligible === true && message.aiRevision === revision && eligible(check.sub));
        }
      }
    });
  });
  async function handle(message, sender) {
    await updates;
    const popup = trustedPopup(sender);
    if (!popup && !youtubeSender(sender)) return { ok: false, code: "sender" };
    if (message?.type === "get-settings") return { ok: true, settings: publicSettings() };
    if (message?.type === "get-analytics" && popup) return { ok: true, ...spending.snapshot() };
    if (message?.type === "get-patterns" && popup) return { ok: true, ...await patterns.summary(message.period, message.metric) };
    if (message?.type === "record-patterns" && youtubeSender(sender)) return { ok: await patterns.record(message.events, message.version) };
    if (message?.type === "test-openai" && popup) {
      const result = await new Promise(resolve => enqueue({ title: "A quiet walk through a public park", test: true, epoch: credentialGeneration, resolve }));
      if (result.ok) { invalidateSubscriptions(); await publish(); }
      return result;
    }
    return { ok: false, code: "message" };
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    handle(message, sender).then(respond, () => respond({ ok: false, code: "unavailable", error: "Extension settings are unavailable. Reload the extension." }));
    return true;
  });
  ready.catch(() => {});
})();
