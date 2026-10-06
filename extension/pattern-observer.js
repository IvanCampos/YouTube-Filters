(() => {
  "use strict";
  class PatternObserver {
    constructor(onVisible) {
      this.onVisible = onVisible;
      this.watched = new Set(); this.seen = new WeakMap(); this.intersecting = new WeakSet();
      this.pending = new Map(); this.timer = null; this.observer = null; this.closed = false;
    }
    observe(element, { settings, videoId, title, scope, outcome }) {
      if (this.closed || !settings.enabled || !settings.patternVersion || !videoId || !title || document.hidden) return;
      if (!this.observer && typeof IntersectionObserver === "function") {
        this.observer = new IntersectionObserver(entries => {
          for (const entry of entries) {
            if (entry.isIntersecting) { this.intersecting.add(entry.target); this.onVisible(entry.target); }
            else {
              this.intersecting.delete(entry.target);
              // Hiding a matched card also removes its intersection; its final result stays recorded.
              this.finishPending(entry.target);
            }
          }
        }, { rootMargin: "0px" });
      }
      if (!this.watched.has(element)) { this.watched.add(element); this.observer?.observe(element); }
      const old = this.seen.get(element);
      const same = old?.videoId === videoId && old?.title === title;
      const rect = element.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth &&
        (window.top === window || this.intersecting.has(element));
      const knownHidden = same && scope.hasAttribute("data-yt-hide-card");
      if (!visible && !knownHidden) return;
      const day = new Intl.DateTimeFormat("en-US", { timeZone: settings.patternTimeZone }).format(Date.now());
      const at = same && old.day === day ? old.at : Date.now();
      const event = { videoId, at, ...outcome() };
      const signature = JSON.stringify([settings.patternVersion, day, event.s, event.k, event.e, event.q, event.w]);
      if (same && old.signature === signature) return;
      this.seen.set(element, { videoId, title, day, at, signature, event, version: settings.patternVersion });
      this.queue(event, settings.patternVersion);
    }
    queue(event, version) {
      this.pending.set(`${version}:${event.videoId}:${event.at}`, { event, version });
      if (this.timer === null) this.timer = setTimeout(() => this.flush(), 100);
    }
    finishPending(element) {
      const old = this.seen.get(element);
      if (old?.event.s !== "pending") return;
      old.event = { ...old.event, s: "unavailable" };
      old.signature = "";
      this.queue(old.event, old.version);
    }
    flush() {
      clearTimeout(this.timer); this.timer = null;
      const queued = [...this.pending.values()]; this.pending.clear();
      const versions = new Set(queued.map(item => item.version));
      for (const version of versions) {
        const events = queued.filter(item => item.version === version).map(item => item.event);
        for (let i = 0; i < events.length; i += 50) {
          // Observations are best-effort, local-only messages; never trigger classifications.
          chrome.runtime.sendMessage({ type: "record-patterns", version, events: events.slice(i, i + 50) }).catch(() => {});
        }
      }
    }
    prune() {
      for (const element of this.watched) if (!element.isConnected) {
        this.finishPending(element); this.observer?.unobserve(element); this.watched.delete(element);
      }
    }
    stop() {
      for (const element of this.watched) this.finishPending(element);
      this.flush(); this.closed = true; this.observer?.disconnect(); this.observer = null; this.watched.clear();
    }
    start() { this.closed = false; }
  }
  globalThis.ThumbnailPatternObserver = PatternObserver;
})();
