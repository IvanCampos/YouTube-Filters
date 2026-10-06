(() => {
  "use strict";

  const { createMatcher, cleanColor, cleanThreshold, cleanStyle } = globalThis.RedThumbnailKeywords;
  const overlay = globalThis.ThumbnailAIOverlay;
  const classifiers = globalThis.ThumbnailClassifiers;
  function validResult(value, requested = value?.ids || settings.enabledClassifiers) {
    const ids = value?.evaluatedIds || value?.ids || requested;
    const skipped = value?.skippedIds || [];
    if ((value?.expires && value.expires <= Date.now()) || !classifiers.validResult(value, ids) ||
        !Array.isArray(ids) || JSON.stringify(ids) !== JSON.stringify(classifiers.normalize(ids)) ||
        JSON.stringify(classifiers.normalize([...ids, ...skipped])) !== JSON.stringify(classifiers.normalize(requested))) return false;
    if (!skipped.length) return ids.length === requested.length;
    return settings.hideEarlyExit && settings.replacementStyle === "hide" && skipped.length === 1 && skipped[0] === classifiers.imageId &&
      !ids.includes(classifiers.imageId) && Boolean(classifiers.strongest(value, ids, settings.minProbability));
  }
  const strongest = value => validResult(value) ? classifiers.strongest(value, value?.evaluatedIds || value?.ids || settings.enabledClassifiers, settings.minProbability) : null;
  const LOCKUP_IMAGE = ".ytLockupViewModelContentImage, .yt-lockup-view-model__content-image";
  const CARD = [
    "ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer",
    "ytd-compact-video-renderer", "ytd-playlist-video-renderer",
    "ytd-playlist-renderer", "ytd-grid-playlist-renderer", "ytd-compact-playlist-renderer",
    "ytd-radio-renderer", "ytd-movie-renderer", "ytd-compact-movie-renderer",
    "ytd-playlist-panel-video-renderer", "ytd-reel-item-renderer",
    "yt-lockup-view-model", "ytm-shorts-lockup-view-model", "ytm-shorts-lockup-view-model-v2",
    ".shortsLockupViewModelHost", ".shortsLockupViewModelHostOutsideMetadata",
    "ytm-video-with-context-renderer", "ytm-compact-video-renderer",
    "ytm-video-card-renderer", "ytm-playlist-video-renderer", "ytm-reel-item-renderer",
    ".ytp-videowall-still", ".ytp-ce-video", ".ytp-suggestion-link", "ytd-video-preview"
  ].join(",");
  const THUMBNAIL = [
    "[data-yt-mask-wrapper]", "ytd-thumbnail", "yt-thumbnail-view-model", "yt-thumbnail",
    ".yt-lockup-view-model__content-image", ".ytLockupViewModelContentImage", ".shortsLockupViewModelHostThumbnailContainer",
    ".shortsLockupViewModelHostThumbnail", ".reel-item-thumbnail",
    ".video-thumbnail-container-large", ".video-thumbnail-container-compact",
    ".media-item-thumbnail-container", ".ytp-videowall-still", ".ytp-ce-video",
    ".ytp-suggestion-link", "img[src*='ytimg.com/vi']", "img[data-thumb*='ytimg.com/vi']"
  ].join(",");
  const TITLE = [
    "#video-title", "#video-title-link", ".yt-lockup-metadata-view-model__title", ".ytLockupMetadataViewModelTitle",
    ".ytwFeedAdMetadataViewModelHostTextsStyleCompactHeadline",
    ".shortsLockupViewModelHostMetadataTitle", ".shortsLockupViewModelHostOutsideMetadataTitle",
    ".reel-item-endpoint", ".media-item-headline", ".compact-media-item-headline",
    ".ytp-videowall-still-info-title", ".ytp-ce-video-title", ".ytp-suggestion-title"
  ].join(",");
  const PREVIEW = "ytd-video-preview, ytd-moving-thumbnail-renderer, .ytThumbnailViewModelVideoPreview, #mouseover-overlay, #hover-overlays";
  const MEDIA = "video, audio";
  // These are playback surfaces, not thumbnail previews (even on /watch pages).
  const PLAYER = "#movie_player, #shorts-player, ytd-reel-video-renderer, ytm-reel-video-renderer, ytd-miniplayer";

  let settings = { enabled: true, keywords: [], aiEnabled: false, keyConfigured: false, aiRevision: "", enabledClassifiers: [] };
  let matches = createMatcher([]);
  let timer = null;
  let stopped = false;
  let initialVersion = 0;
  let fullScan = false;
  const pending = new Set();
  const marked = new Set();
  // Weak ownership lets removed/recycled cards be garbage collected.
  const owners = new WeakMap();
  const identities = new WeakMap();
  const cardCounts = new Map();
  const suppressedPreviews = new Set();
  const patternObserver = globalThis.ThumbnailPatternObserver ? new ThumbnailPatternObserver(element => schedule(element)) : null;
  const hoverEvents = ["pointerover", "pointerenter", "pointermove", "mouseover", "mouseenter", "mousemove"];

  function suppressThumbnailHover(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    let overMask = currentReplacement(target.closest("[data-yt-red-mask]"));
    if (!overMask && (target.closest(PREVIEW) || target.matches(MEDIA))) overMask = Boolean(previewMask(target));
    // Enter events can target the enclosing card instead of its thumbnail link.
    // Also cover sibling preview layers occupying the same thumbnail rectangle.
    if (!overMask) {
      const card = target.closest("[data-yt-red-card]");
      overMask = card && [...card.querySelectorAll("[data-yt-red-mask]")].some((mask) => {
        if (!currentReplacement(mask)) return false;
        const rect = mask.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && event.clientX >= rect.left && event.clientX < rect.right &&
          event.clientY >= rect.top && event.clientY < rect.bottom;
      });
    }
    if (overMask) event.stopImmediatePropagation();
    // Do not cancel clicks, focus, context menus, or leave/out events used for cleanup.
  }

  function guardHover() {
    for (const type of hoverEvents) window.addEventListener(type, suppressThumbnailHover, true);
    for (const type of ["play", "playing"]) window.addEventListener(type, suppressPreviewPlayback, true);
  }

  // Install before YouTube registers its hover handlers, even before the DOM exists.
  guardHover();
  const classifications = new Map();
  const watched = new Set();
  const nearby = new WeakSet();
  let visibleSince = new WeakMap();
  const dwellIdentity = new WeakMap();
  const DWELL = 300;
  function visibleEnough(element) {
    const r = element.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, window.innerWidth) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0));
    return r.width > 0 && r.height > 0 && area / (r.width * r.height) >= .25;
  }
  const subscriptions = new Map();
  let classificationPort = null;
  let requestSequence = 0;
  let reconnectAfter = 0;
  let retryTimer = null;
  let retryDue = Infinity;
  const visibilityObserver = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && (entry.intersectionRatio ?? (visibleEnough(entry.target) ? 1 : 0)) >= .25) {
        nearby.add(entry.target);
        if (!visibleSince.has(entry.target)) visibleSince.set(entry.target, Date.now());
        retryAfter(Date.now() + DWELL);
        schedule(entry.target);
      } else { nearby.delete(entry.target); visibleSince.delete(entry.target); releaseObsolete(); }
    }
  }, { rootMargin: "0px", threshold: .25 }) : null;

  const aiActive = () => settings.enabled && settings.aiEnabled && settings.keyConfigured && settings.enabledClassifiers.length > 0;

  function retryAfter(time) {
    if (!Number.isFinite(time) || time >= retryDue || stopped) return;
    clearTimeout(retryTimer);
    retryDue = time;
    retryTimer = setTimeout(() => { retryDue = Infinity; retryTimer = null; schedule(); },
      Math.min(2147483647, Math.max(250, time - Date.now())));
  }

  function requestRelevant(entry) {
    if (stopped || document.hidden || !aiActive() || entry.revision !== settings.aiRevision || matches(entry.title)) return false;
    for (const [element, key] of entry.elements) {
      if (!element.isConnected || !element.matches(THUMBNAIL) ||
          titleFor(element, getScope(element)).trim() !== entry.title || videoKey(thumbnailLink(element)?.getAttribute("href")) !== key || thumbnailFor(element) !== entry.thumbnailUrl) {
        entry.elements.delete(element);
        continue;
      }
      if ((!visibilityObserver || nearby.has(element)) && visibleEnough(element) &&
          visibleSince.has(element) && Date.now() - visibleSince.get(element) >= DWELL) return true;
    }
    return false;
  }

  function cancelSubscription(entry) {
    subscriptions.delete(entry.id);
    if (classifications.get(entry.key) === entry) classifications.delete(entry.key);
    try { classificationPort?.postMessage({ type: "cancel", requestId: entry.id }); } catch { /* Reconnect on next scan. */ }
  }
  function releaseObsolete() {
    for (const entry of [...subscriptions.values()]) if (!requestRelevant(entry)) cancelSubscription(entry);
  }
  function connectClassifications() {
    if (classificationPort) return classificationPort;
    const port = chrome.runtime.connect({ name: "thumbnail-classification" });
    classificationPort = port;
    port.onMessage.addListener(message => {
      if (classificationPort !== port) return;
      const entry = subscriptions.get(message.requestId);
      if (message.type === "check") {
        const eligible = Boolean(entry && requestRelevant(entry));
        port.postMessage({ type: "relevance", requestId: message.requestId, checkId: message.checkId,
          aiRevision: settings.aiRevision, eligible });
        if (entry && !eligible) cancelSubscription(entry);
        return;
      }
      if (message.type !== "result" || !entry) return;
      subscriptions.delete(entry.id);
      if (!requestRelevant(entry) || classifications.get(entry.key) !== entry) {
        if (classifications.get(entry.key) === entry) classifications.delete(entry.key);
        return;
      }
      entry.pending = false;
      entry.elements.clear();
      if (message.ok && message.aiRevision === settings.aiRevision && validResult(message, entry.ids)) {
        Object.assign(entry, { schemaVersion: message.schemaVersion, results: message.results, expires: message.expires, evaluatedIds: message.evaluatedIds || entry.ids, skippedIds: message.skippedIds || [] });
        if (message.expires) retryAfter(message.expires);
      } else {
        entry.retryAt = message.retryAt || (message.code === "changed" ? Date.now() + 1000 : Infinity);
        retryAfter(entry.retryAt);
      }
      schedule();
    });
    port.onDisconnect.addListener(() => {
      if (classificationPort !== port) return;
      classificationPort = null;
      for (const entry of subscriptions.values()) if (classifications.get(entry.key) === entry) classifications.delete(entry.key);
      subscriptions.clear();
      if (!stopped) {
        reconnectAfter = Date.now() + 1000;
        // Read the latest revision before resubscribing after a worker restart.
        const version = initialVersion;
        Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "get-settings" })).then(response => {
          if (!stopped && version === initialVersion && response?.ok) applySettings(response.settings);
        }).catch(() => {});
        retryAfter(Date.now() + 1000);
      }
    });
    return port;
  }

  function thumbnailFor(element) {
    return settings.enabledClassifiers.includes(classifiers.imageId) ? globalThis.ThumbnailImages.forElement(element) : null;
  }
  function evaluationKey(element, title) {
    const url = thumbnailFor(element);
    return url ? JSON.stringify([title, url]) : title;
  }
  function aiLabel(element, title) {
    if (!aiActive() || !title || title.length > 1000) return null;
    const thumbnailUrl = thumbnailFor(element);
    const ids = settings.enabledClassifiers.filter(id => id !== classifiers.imageId || thumbnailUrl);
    if (!ids.length) return null;
    const key = evaluationKey(element, title);
    const cached = classifications.get(key);
    if (validResult(cached)) return strongest(cached);
    if (reconnectAfter > Date.now()) { retryAfter(reconnectAfter); return null; }
    if (visibilityObserver && !watched.has(element)) {
      watched.add(element);
      visibilityObserver.observe(element);
    }
    if (document.hidden || !visibleEnough(element) || (visibilityObserver && !nearby.has(element))) { visibleSince.delete(element); return null; }
    const identity = `${key}:${videoKey(thumbnailLink(element)?.getAttribute("href"))}`;
    if (dwellIdentity.get(element) !== identity) { dwellIdentity.set(element, identity); visibleSince.delete(element); }
    if (!visibleSince.has(element)) visibleSince.set(element, Date.now());
    const due = visibleSince.get(element) + DWELL;
    if (Date.now() < due) { retryAfter(due); return null; }
    if (cached?.pending) {
      cached.elements.set(element, videoKey(thumbnailLink(element)?.getAttribute("href")));
      return null;
    }
    if (cached?.retryAt > Date.now()) return null;
    const entry = { id: String(++requestSequence), title, key, thumbnailUrl, ids, revision: settings.aiRevision, pending: true,
      elements: new Map([[element, videoKey(thumbnailLink(element)?.getAttribute("href"))]]) };
    classifications.set(key, entry);
    subscriptions.set(entry.id, entry);
    while (classifications.size > 500) {
      const oldest = classifications.values().next().value;
      if (oldest.pending) cancelSubscription(oldest);
      else classifications.delete(classifications.keys().next().value);
    }
    try {
      connectClassifications().postMessage({ type: "subscribe", requestId: entry.id, title, thumbnailUrl, aiRevision: entry.revision });
    } catch {
      cancelSubscription(entry);
      retryAfter(Date.now() + 1000);
    }
    return null;
  }

  function videoKey(href) {
    try {
      const url = new URL(href, location.href);
      if (!/(^|\.)youtube\.com$/.test(url.hostname)) return null;
      if (url.pathname === "/watch") return url.searchParams.get("v");
      return url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1] ?? null;
    } catch { return null; }
  }

  function thumbnailLink(element) {
    return element.closest("a[href]") ?? element.querySelector("a[href]");
  }

  function getScope(element) {
    // Prefer the feed item around modern lockups so hiding also removes its slot.
    const card = element.closest("ytd-rich-item-renderer, ytd-video-renderer, ytd-grid-video-renderer, ytd-compact-video-renderer") ?? element.closest(CARD);
    if (card) return card;
    // For unfamiliar renderers, stop before crossing into a list of different videos.
    let scope = element;
    const key = videoKey(thumbnailLink(element)?.getAttribute("href"));
    if (!key) return scope;
    for (let depth = 0; depth < 5 && scope.parentElement; depth++) {
      const parent = scope.parentElement;
      if (parent === document.body || parent === document.documentElement) break;
      const keys = new Set([...parent.querySelectorAll("a[href]")]
        .map((link) => videoKey(link.getAttribute("href"))).filter(Boolean));
      if (keys.size > 1) break;
      scope = parent;
      if (scope.querySelector(TITLE) || scope.querySelector("h3")) break;
    }
    return scope;
  }

  function titleFor(element, scope) {
    const link = thumbnailLink(element);
    const key = videoKey(link?.getAttribute("href"));
    for (const title of scope.querySelectorAll(TITLE)) {
      const titleLink = title.closest("a[href]") ?? title.querySelector("a[href]");
      const titleKey = videoKey(titleLink?.getAttribute("href"));
      if (key && titleKey && key !== titleKey) continue;
      const text = title.getAttribute("title") || overlay.textWithoutOverlay(title);
      if (text) return text;
    }
    if (key) {
      for (const candidate of scope.querySelectorAll("a[href]")) {
        if (candidate === link || videoKey(candidate.getAttribute("href")) !== key) continue;
        const text = candidate.getAttribute("title") || overlay.textWithoutOverlay(candidate.querySelector("h3")) ||
          overlay.textWithoutOverlay(candidate);
        if (text) return text;
      }
    }
    const heading = scope.querySelector("h3");
    const headingLink = heading?.closest("a[href]") ?? heading?.querySelector("a[href]");
    const headingKey = videoKey(headingLink?.getAttribute("href"));
    const headingText = key && headingKey && key !== headingKey ? "" : overlay.textWithoutOverlay(heading);
    return headingText || link?.getAttribute("title") ||
      element.getAttribute("title") || element.querySelector("img[alt]")?.getAttribute("alt") ||
      element.getAttribute("alt") || link?.getAttribute("aria-label") ||
      element.getAttribute("aria-label") || "";
  }

  function currentReplacement(mask) {
    if (!mask || stopped || !settings.enabled || !marked.has(mask) || !mask.isConnected) return false;
    const scope = owners.get(mask);
    const identity = identities.get(mask);
    if (!identity || !scope?.contains(mask) || getScope(mask) !== scope) return false;
    const title = titleFor(mask, scope).trim();
    if (identity.title !== title || identity.key !== videoKey(thumbnailLink(mask)?.getAttribute("href"))) return false;
    // Check current settings and identity synchronously, before a debounced rescan.
    return matches(title) || (aiActive() && Boolean(strongest(classifications.get(evaluationKey(mask, title)))));
  }

  function previewHost(element) {
    let host = element.closest(PREVIEW);
    // A nested preview layer may keep its video link on the outer preview host.
    for (let outer = host?.parentElement?.closest(PREVIEW); outer; outer = host.parentElement?.closest(PREVIEW)) host = outer;
    return host;
  }

  function previewMask(element) {
    if (!element.isConnected || element.closest(PLAYER)) return null;
    const host = previewHost(element);
    const links = host ? [host.closest("a[href]"), ...host.querySelectorAll("a[href]")] : [];
    const keys = new Set(links.filter(Boolean).map(link => videoKey(link.getAttribute("href"))).filter(Boolean));
    // Never guess which video an ambiguous or recycled preview belongs to.
    if (keys.size > 1) return null;
    const key = keys.values().next().value;
    const scope = element.closest("[data-yt-red-card]");
    const candidates = scope ? [scope, ...scope.querySelectorAll("[data-yt-red-mask]")] : host && key ? marked : [];
    for (const mask of candidates) {
      if (currentReplacement(mask) && (!key || identities.get(mask).key === key)) return mask;
    }
    return null;
  }

  function updatePreview(element) {
    const suppress = Boolean(previewMask(element));
    element.toggleAttribute("data-yt-preview-suppressed", suppress);
    if (suppress) {
      suppressedPreviews.add(element);
      if (element instanceof HTMLMediaElement && !element.paused) element.pause();
    } else {
      suppressedPreviews.delete(element);
    }
  }

  function refreshPreviews(roots) {
    const candidates = new Set(suppressedPreviews);
    if (!stopped && marked.size) {
      for (const root of roots) {
        if (root.matches?.(`${MEDIA}, ${PREVIEW}`)) candidates.add(root);
        root.querySelectorAll(`${MEDIA}, ${PREVIEW}`).forEach(node => candidates.add(node));
      }
    }
    for (const element of candidates) updatePreview(element);
  }

  function suppressPreviewPlayback(event) {
    const media = event.target;
    if (!(media instanceof HTMLMediaElement)) return;
    refreshPreviews([previewHost(media) ?? media]);
  }

  function unmark(element) {
    overlay.remove(element);
    element.removeAttribute("data-yt-red-mask");
    element.removeAttribute("data-yt-replacement-style");
    element.removeAttribute("data-yt-red-position");
    element.style.removeProperty("--yt-red-radius");
    element.style.removeProperty("--yt-mask-color");
    element.style.removeProperty("--yt-original-background");
    marked.delete(element);
    identities.delete(element);
    const owner = owners.get(element);
    if (owner) {
      const count = (cardCounts.get(owner) ?? 1) - 1;
      if (count === 0) {
        owner.removeAttribute("data-yt-red-card");
        owner.removeAttribute("data-yt-hide-card");
        cardCounts.delete(owner);
      } else cardCounts.set(owner, count);
      owners.delete(element);
    }
    return overlay.unwrap(element) || element;
  }

  function inspect(element) {
    if (!element.isConnected) return;
    if (element.hasAttribute("data-yt-mask-wrapper") && !element.querySelector("img[src*='ytimg.com/vi'], img[data-thumb*='ytimg.com/vi']")) {
      unmark(element);
      return;
    }
    // Modern cards use this exact link box for thumbnail sizing and clipping.
    // Never expand the mask to a surrounding legacy thumbnail wrapper.
    const lockupImage = element.querySelector(LOCKUP_IMAGE);
    if (lockupImage) {
      if (marked.has(element)) unmark(element);
      inspect(lockupImage);
      return;
    }
    // Prefer one mask on the outer visual container, including its hover preview.
    const outer = element.matches(LOCKUP_IMAGE) ? null : element.parentElement?.closest(THUMBNAIL);
    if (outer) {
      if (marked.has(element)) unmark(element);
      return;
    }
    const scope = getScope(element);
    const title = titleFor(element, scope).trim();
    // Explicit keywords have priority and do not incur an API request.
    const label = settings.enabled && !matches(title) ? aiLabel(element, title) : null;
    const color = settings.enabled && matches(title) ? "red" :
      label ? "purple" : null;
    patternObserver?.observe(element, { settings, videoId: videoKey(thumbnailLink(element)?.getAttribute("href")), title, scope, outcome: () => {
      const result = classifications.get(evaluationKey(element, title));
      const evaluated = color !== "red" && aiActive() && validResult(result);
      const bits = ids => ids.reduce((mask, id) => mask | (1 << classifiers.ids.indexOf(id)), 0);
      const evaluatedIds = result?.evaluatedIds || result?.ids || settings.enabledClassifiers;
      const qualified = evaluated ? evaluatedIds.filter(id => {
        const score = result.results[id];
        return score.probability >= settings.minProbability;
      }) : [];
      return { s: color === "red" ? "keyword" : label ? "ai" : evaluated ? "clear" :
        !aiActive() || title.length > 1000 ? "unchecked" : result?.retryAt > Date.now() ? "unavailable" : "pending",
        k: color === "red" ? matches.all(title) : [], e: evaluated ? bits(evaluatedIds) : 0,
        q: bits(qualified), w: label ? classifiers.ids.indexOf(label.label) : -1 };
    } });
    if (!color) {
      if (marked.has(element)) unmark(element);
      return;
    }
    const style = color === "red" ? settings.keywordReplacementStyle : settings.replacementStyle;
    if ((color === "red" && ["solid", "hide"].includes(style) && element.hasAttribute("data-yt-mask-wrapper")) ||
        (marked.has(element) && owners.get(element) !== scope)) {
      inspect(unmark(element));
      return;
    }
    if (element.tagName === "IMG" && (color === "purple" || !["solid", "hide"].includes(style))) {
      if (marked.has(element)) unmark(element);
      element = overlay.wrapImage(element);
    }
    if (!marked.has(element)) {
      element.style.setProperty("--yt-original-background", getComputedStyle(element).background || "transparent");
      // YouTube often rounds an inner image/link instead of the outer container.
      // Copy that rounding before applying the mask so its red background is clipped too.
      const surfaces = [element, ...element.querySelectorAll(
        "a[href], yt-thumbnail-view-model, .ytThumbnailViewModelImage, yt-image, img"
      )];
      const radius = surfaces.map((surface) => getComputedStyle(surface).borderRadius)
        .find((value) => value.split(/[\s/]+/).some((part) => parseFloat(part) > 0));
      element.style.setProperty("--yt-red-radius", radius || "12px");
      if (getComputedStyle(element).position === "static") element.setAttribute("data-yt-red-position", "");
      element.setAttribute("data-yt-red-mask", color);
      scope.setAttribute("data-yt-red-card", "");
      owners.set(element, scope);
      cardCounts.set(scope, (cardCounts.get(scope) ?? 0) + 1);
      marked.add(element);
    }
    if (element.getAttribute("data-yt-red-mask") !== color) element.setAttribute("data-yt-red-mask", color);
    identities.set(element, { title, thumbnailUrl: thumbnailFor(element), key: videoKey(thumbnailLink(element)?.getAttribute("href")) });
    const fill = color === "red" ? settings.keywordColor : settings.aiColor;
    if (element.style.getPropertyValue("--yt-mask-color") !== fill) element.style.setProperty("--yt-mask-color", fill);
    if (element.getAttribute("data-yt-replacement-style") !== style) {
      element.setAttribute("data-yt-replacement-style", style);
    }
    scope.toggleAttribute("data-yt-hide-card", style === "hide");
    if (color === "purple" && style !== "hide") {
      overlay.render(element, label, style === "placeholder" ? "#e5e7eb" :
        ["blur", "grayscale"].includes(style) ? "#000000" : fill);
    }
    else overlay.remove(element);
  }

  function scan(root) {
    if (root.matches?.(THUMBNAIL)) inspect(root);
    root.querySelectorAll(THUMBNAIL).forEach(inspect);
  }

  function flush() {
    timer = null;
    patternObserver?.prune();
    for (const element of marked) {
      if (!element.isConnected || !element.matches(THUMBNAIL)) unmark(element);
    }
    for (const element of watched) {
      if (!element.isConnected) { visibilityObserver?.unobserve(element); watched.delete(element); }
    }
    if (!settings.enabled || (!settings.patternVersion && settings.keywords.length === 0 && !aiActive())) {
      [...marked].forEach(unmark);
    } else if (fullScan) {
      scan(document);
    } else {
      for (const root of pending) if (root.isConnected) scan(root);
    }
    releaseObsolete();
    pending.clear();
    fullScan = false;
    // Stop previews already playing when an asynchronous classification arrives.
    refreshPreviews([document]);
  }

  function schedule(root = document) {
    if (stopped) return;
    if (root === document) fullScan = true;
    else if (!fullScan) pending.add(root);
    if (timer === null) timer = setTimeout(flush, 60);
  }

  const observer = new MutationObserver((mutations) => {
    if ((!settings.enabled || (!settings.patternVersion && settings.keywords.length === 0 && !aiActive())) && marked.size === 0) return;
    const previewRoots = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === Node.ELEMENT_NODE ?
        mutation.target : mutation.target.parentElement;
      if (!target) continue;
      if (mutation.attributeName === "style" && target.hasAttribute("data-yt-red-mask") &&
          thumbnailFor(target) === identities.get(target)?.thumbnailUrl) continue;
      previewRoots.add(previewHost(target) ?? target);
      schedule(target.closest(CARD) ?? getScope(target));
      if (mutation.type === "childList") {
        for (const child of mutation.addedNodes) {
          if (child.nodeType === Node.ELEMENT_NODE) schedule(child);
        }
      }
    }
    // Playback and visual suppression must not wait for the 60 ms card scan.
    refreshPreviews(previewRoots);
  });

  function applySettings(next) {
    if (next.aiRevision !== settings.aiRevision || next.aiEnabled !== settings.aiEnabled || next.enabled !== settings.enabled ||
        JSON.stringify(classifiers.normalize(next.enabledClassifiers)) !== JSON.stringify(settings.enabledClassifiers) ||
        ["minProbability", "replacementStyle", "hideEarlyExit", "imageSize", "imageDetail"].some(key => settings[key] !== next[key])) {
      for (const entry of [...subscriptions.values()]) cancelSubscription(entry);
      const retained = next.scoreRevision && next.scoreRevision === settings.scoreRevision && next.enabled === settings.enabled && next.aiEnabled === settings.aiEnabled &&
        JSON.stringify(classifiers.normalize(next.enabledClassifiers)) === JSON.stringify(settings.enabledClassifiers) && classifiers.imageProfile(next) === classifiers.imageProfile(settings)
        ? [...classifications].filter(([, entry]) => !entry.pending && !(entry.skippedIds?.length)) : [];
      classifications.clear();
      // Invalidate decisions, then recompute from complete compatible evidence.
      // Partial early exits must return to the worker for missing image scores.
      for (const [key, entry] of retained) { entry.revision = next.aiRevision; classifications.set(key, entry); }
      clearTimeout(retryTimer);
      retryTimer = null;
      retryDue = Infinity;
    }
    settings = { enabled: next.enabled !== false, keywords: Array.isArray(next.keywords) ? next.keywords : [],
      patternVersion: next.patternVersion || 0, patternTimeZone: next.patternTimeZone || "UTC",
      hideEarlyExit: next.hideEarlyExit !== false, imageSize: classifiers.cleanImageSize(next.imageSize), imageDetail: classifiers.cleanImageDetail(next.imageDetail),
      aiEnabled: next.aiEnabled === true, keyConfigured: next.keyConfigured === true, aiRevision: next.aiRevision || "", scoreRevision: next.scoreRevision || "", enabledClassifiers: classifiers.normalize(next.enabledClassifiers),
      keywordColor: cleanColor(next.keywordColor, "#ff0000"), aiColor: cleanColor(next.aiColor, "#8000ff"),
      minProbability: cleanThreshold(next.minProbability, 0.9),
      replacementStyle: cleanStyle(next.replacementStyle),
      keywordReplacementStyle: cleanStyle(next.keywordReplacementStyle, "blur") };
    matches = createMatcher(settings.keywords);
    if (settings.enabled) patternObserver?.start();
    else patternObserver?.stop();
    refreshPreviews([]);
    schedule();
  }

  function onImageLoad(event) {
    if (event.target instanceof HTMLImageElement) schedule(event.target.closest(CARD) ?? getScope(event.target));
  }

  function onStorage(changes, area) {
    if (area !== "session" || !changes.publicSettings?.newValue) return;
    initialVersion++;
    applySettings(changes.publicSettings.newValue);
  }

  function onVisibility() {
    visibleSince = new WeakMap();
    releaseObsolete();
    if (!document.hidden) schedule();
  }
  function start() {
    stopped = false;
    patternObserver?.start();
    guardHover();
    observer.observe(document.documentElement, {
      childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ["title", "aria-label", "alt", "href", "src", "srcset", "sizes", "data-thumb", "style"]
    });
    document.addEventListener("load", onImageLoad, true);
    document.addEventListener("visibilitychange", onVisibility);
    chrome.storage.onChanged.addListener(onStorage);
    const version = initialVersion;
    chrome.runtime.sendMessage({ type: "get-settings" }).then((response) => {
      if (!response?.ok) throw new Error("Settings unavailable");
      if (!stopped && version === initialVersion) applySettings(response.settings);
    }).catch(() => {
      // An extension reload invalidates old content scripts; a page refresh recovers them.
      if (!stopped) applySettings({ enabled: false, keywords: [] });
    });
  }

  function stop() {
    stopped = true;
    patternObserver?.stop();
    for (const type of hoverEvents) window.removeEventListener(type, suppressThumbnailHover, true);
    for (const type of ["play", "playing"]) window.removeEventListener(type, suppressPreviewPlayback, true);
    observer.disconnect();
    document.removeEventListener("load", onImageLoad, true);
    document.removeEventListener("visibilitychange", onVisibility);
    chrome.storage.onChanged.removeListener(onStorage);
    clearTimeout(timer);
    clearTimeout(retryTimer);
    retryTimer = null;
    retryDue = Infinity;
    for (const entry of [...subscriptions.values()]) cancelSubscription(entry);
    const port = classificationPort;
    classificationPort = null;
    try { port?.disconnect(); } catch { /* Extension context may already be gone. */ }
    classifications.clear();
    visibilityObserver?.disconnect();
    watched.clear();
    timer = null;
    pending.clear();
    [...marked].forEach(unmark);
    refreshPreviews([]);
  }

  document.addEventListener("yt-navigate-finish", () => schedule());
  document.addEventListener("yt-page-data-updated", () => schedule());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(); });
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", (event) => { if (event.persisted && stopped) start(); });
  if (document.documentElement) start();
  else document.addEventListener("DOMContentLoaded", start, { once: true });
})();
