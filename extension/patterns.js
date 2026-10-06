(() => {
  "use strict";
  const KEY = "filterPatterns", DAYS = 90, LIMIT = 6000, BYTE_LIMIT = 1500000;
  const ids = globalThis.ThumbnailClassifiers.ids;
  const allMask = (1 << ids.length) - 1;
  const normalize = text => text.normalize("NFKC").toLowerCase();
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const stamp = value => Number.isSafeInteger(value) && value >= 0 && value < 8640000000000000;
  const mask = value => Number.isInteger(value) && value >= 0 && value <= allMask;
  const dayAt = (time, zone) => globalThis.ThumbnailSpending.dayAt(time, zone);
  const shift = (day, delta) => new Date(Date.parse(`${day}T00:00:00Z`) + delta * 86400000).toISOString().slice(0, 10);
  const dayNumber = day => Date.parse(`${day}T00:00:00Z`) / 86400000;
  const dayValid = day => typeof day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(dayNumber(day)) && shift(day, 0) === day;
  function config(settings) {
    return { enabled: settings.enabled !== false, keywords: RedThumbnailKeywords.cleanKeywords(settings.keywords),
      aiEnabled: settings.aiEnabled === true, keyConfigured: Boolean(settings.openaiApiKey),
      categories: ThumbnailClassifiers.normalize(settings.enabledClassifiers),
      action: RedThumbnailKeywords.cleanStyle(settings.replacementStyle), hideEarlyExit: settings.hideEarlyExit !== false, imageProfile: ThumbnailClassifiers.imageProfile(settings),
      probability: RedThumbnailKeywords.cleanThreshold(settings.minProbability, .9), classificationVersion: ThumbnailClassifiers.schemaVersion };
  }
  const bits = values => values.reduce((result, id) => result | (1 << ids.indexOf(id)), 0);
  function range(period, today) {
    const weekday = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7;
    const start = period === "today" ? today : period === "month" ? `${today.slice(0, 7)}-01` : period === "30days" ? shift(today, -29) : shift(today, -weekday);
    let previous = period === "week" ? shift(start, -7) : period === "month" ? shift(start, -1).slice(0, 7) + "-01" : shift(start, -Math.max(1, dayNumber(today) - dayNumber(start)));
    const elapsed = Math.min(dayNumber(today) - dayNumber(start), dayNumber(start) - dayNumber(previous));
    return { start, end: shift(today, 1), compareEnd: shift(start, elapsed), previous, previousEnd: shift(previous, elapsed), elapsed };
  }
  function latest(records, start, end) {
    const videos = new Map();
    for (const [day, rows] of Object.entries(records)) if (day >= start && day < end) {
      for (const [hash, row] of Object.entries(rows)) {
        const old = videos.get(hash);
        if (!old || day > old.day || (day === old.day && row.u > old.row.u)) videos.set(hash, { day, row });
      }
    }
    return [...videos.values()].map(item => item.row);
  }
  function aggregate(rows) {
    const result = { encountered: rows.length, keyword: 0, ai: 0, clear: 0, pending: 0, unavailable: 0, unchecked: 0, keywords: Object.create(null), categories: {} };
    for (const id of ids) result.categories[id] = { evaluated: 0, qualified: 0, shown: 0 };
    for (const row of rows) {
      result[row.s]++;
      for (const keyword of row.k) result.keywords[keyword] = (result.keywords[keyword] || 0) + 1;
      ids.forEach((id, i) => {
        if (row.e & (1 << i)) result.categories[id].evaluated++;
        if (row.q & (1 << i)) result.categories[id].qualified++;
        if (row.w === i) result.categories[id].shown++;
      });
    }
    result.filtered = result.keyword + result.ai;
    return result;
  }
  function measure(totals, metric) {
    if (metric?.startsWith("keyword:")) return { count: totals.keywords[metric.slice(8)] || 0, denominator: totals.encountered };
    if (metric?.startsWith("category:") && totals.categories[metric.slice(9)]) {
      const category = totals.categories[metric.slice(9)];
      return { count: category.qualified, denominator: category.evaluated };
    }
    return { count: totals.filtered, denominator: totals.encountered };
  }
  function validRow(row) {
    return object(row) && stamp(row.t) && stamp(row.u) && Number.isSafeInteger(row.v) && row.v > 0 &&
      ["keyword", "ai", "clear", "pending", "unavailable", "unchecked"].includes(row.s) && Array.isArray(row.k) &&
      row.k.every(word => typeof word === "string" && word.length <= 1000) && mask(row.e) && mask(row.q) && !(row.q & ~row.e) &&
      Number.isInteger(row.w) && row.w >= -1 && row.w < ids.length && (row.w === -1 || Boolean(row.q & (1 << row.w)));
  }
  function valid(value) {
    try {
      return object(value) && value.format === 1 && stamp(value.startedAt) && typeof value.timeZone === "string" && Boolean(dayAt(value.startedAt, value.timeZone)) &&
        Number.isSafeInteger(value.version) && value.version > 0 && object(value.config) && Array.isArray(value.config.keywords) && Array.isArray(value.config.categories) &&
        object(value.days) && Object.entries(value.days).every(([day, rows]) => dayValid(day) && object(rows) &&
          Object.entries(rows).every(([hash, row]) => /^[a-f0-9]{64}$/.test(hash) && validRow(row))) &&
        Array.isArray(value.changes) && value.changes.every(change => stamp(change.at) && Array.isArray(change.fields) && change.fields.every(field => typeof field === "string")) &&
        (value.truncatedThrough === null || dayValid(value.truncatedThrough));
    } catch { return false; }
  }
  class PatternLedger {
    constructor(storage, { now = () => Date.now(), hash = globalThis.ThumbnailEvaluationCache.hash } = {}) {
      this.storage = storage; this.now = now; this.hash = hash; this.operations = Promise.resolve(); this.warning = ""; this.writable = true;
    }
    async initialize(settings, timeZone) {
      this.value = { format: 1, startedAt: this.now(), timeZone, version: 1, config: config(settings), days: {}, changes: [], truncatedThrough: null };
      try {
        const stored = (await this.storage.get({ [KEY]: null }))[KEY];
        if (stored !== null) {
          if (!valid(stored)) throw new Error("Invalid patterns");
          this.value = structuredClone(stored);
          for (const rows of Object.values(this.value.days)) for (const row of Object.values(rows)) if (row.s === "pending") row.s = "unavailable";
        }
      } catch {
        this.writable = false; this.warning = "Saved pattern history is unavailable. Showing session-only observations; existing data is preserved.";
      }
      await this.updateSettings(settings);
    }
    enqueue(operation) {
      this.operations = this.operations.catch(() => {}).then(operation);
      return this.operations;
    }
    updateSettings(settings) {
      const next = config(settings);
      return this.enqueue(async () => {
        const labels = { enabled: "Filtering", keywords: "Keywords", aiEnabled: "AI", keyConfigured: "AI connection", categories: "Categories", probability: "Probability threshold", classificationVersion: "AI classification method", action: "Classifier action", hideEarlyExit: "Hide early exit", imageProfile: "Image quality" };
        const fields = Object.keys(next).filter(key => JSON.stringify(next[key]) !== JSON.stringify(this.value.config[key]));
        if (fields.length) {
          this.value.version++;
          this.value.config = next;
          for (const rows of Object.values(this.value.days)) for (const row of Object.values(rows)) if (row.s === "pending") row.s = "unavailable";
          this.value.changes.push({ at: this.now(), fields: fields.map(key => labels[key]) });
        }
        await this.persist();
      });
    }
    async persist() {
      const cutoff = shift(dayAt(this.now(), this.value.timeZone), -(DAYS - 1));
      for (const day of Object.keys(this.value.days)) if (day < cutoff) delete this.value.days[day];
      this.value.changes = this.value.changes.filter(change => dayAt(change.at, this.value.timeZone) >= cutoff).slice(-500);
      const ordered = Object.entries(this.value.days).flatMap(([day, rows]) => Object.entries(rows).map(([hash, row]) => ({ day, hash, t: row.t }))).sort((a, b) => a.t - b.t);
      let remove = Math.max(0, ordered.length - LIMIT), index = 0;
      let bytes = new TextEncoder().encode(JSON.stringify(this.value)).length;
      while (index < ordered.length && (remove > 0 || bytes > BYTE_LIMIT - 256)) {
        const item = ordered[index++];
        bytes -= new TextEncoder().encode(JSON.stringify(this.value.days[item.day][item.hash])).length + item.hash.length + 4;
        delete this.value.days[item.day][item.hash];
        if (!Object.keys(this.value.days[item.day]).length) delete this.value.days[item.day];
        this.value.truncatedThrough = this.value.truncatedThrough && this.value.truncatedThrough > item.day ? this.value.truncatedThrough : item.day;
        remove--;
      }
      if (!this.writable) return;
      try { await this.storage.set({ [KEY]: structuredClone(this.value) }); this.warning = ""; }
      catch { this.warning = "Pattern history could not be saved. Observations remain in memory until the worker restarts."; }
    }
    record(events, version) {
      return this.enqueue(async () => {
        if (version !== this.value.version || !this.value.config.enabled || !Array.isArray(events) || events.length > 50) return false;
        const allowedKeywords = new Set(this.value.config.keywords.map(normalize));
        const enabled = bits(this.value.config.categories);
        let changed = false;
        for (const event of events) {
          if (!object(event) || typeof event.videoId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.videoId) ||
              !validRow({ ...event, t: event.at, u: this.now(), v: version }) || event.at > this.now() + 60000 || event.at < this.now() - 36 * 3600000 ||
              event.k.some(word => !allowedKeywords.has(normalize(word))) || (event.e !== 0 && event.e !== enabled) ||
              (event.e && (!this.value.config.aiEnabled || !this.value.config.keyConfigured)) ||
              (event.s === "keyword" ? !event.k.length || event.e !== 0 || event.q !== 0 || event.w !== -1 : event.k.length > 0) ||
              (["ai", "clear"].includes(event.s) ? !event.e : event.e !== 0 || event.q !== 0 || event.w !== -1) ||
              (event.s === "ai" && (!event.q || event.w === -1)) || (event.s === "clear" && (event.q || event.w !== -1))) continue;
          const day = dayAt(event.at, this.value.timeZone), key = await this.hash(event.videoId);
          const rows = this.value.days[day] ||= {};
          const old = rows[key];
          // A duplicate card awaiting its cache result must not undo a completed observation.
          if (old?.v === version && ["keyword", "ai", "clear"].includes(old.s) && ["pending", "unavailable", "unchecked"].includes(event.s)) continue;
          const row = { t: old?.t ?? event.at, u: this.now(), v: version, s: event.s, k: [...new Set(event.k.map(normalize))].sort(), e: event.e, q: event.q, w: event.w };
          if (old && ["v", "s", "k", "e", "q", "w"].every(field => JSON.stringify(old[field]) === JSON.stringify(row[field]))) continue;
          rows[key] = row; changed = true;
        }
        if (changed) await this.persist();
        return true;
      });
    }
    async summary(period = "week", metric = "overall") {
      await this.operations;
      if (!["today", "week", "month", "30days"].includes(period)) period = "week";
      const today = dayAt(this.now(), this.value.timeZone), window = range(period, today);
      const totals = aggregate(latest(this.value.days, window.start, window.end));
      const daily = [];
      for (let day = window.start; day < window.end; day = shift(day, 1)) {
        const stats = aggregate(Object.values(this.value.days[day] || {}));
        daily.push({ day, ...measure(stats, metric), changes: this.value.changes.filter(change => dayAt(change.at, this.value.timeZone) === day) });
      }
      const complete = measure(aggregate(latest(this.value.days, window.start, window.compareEnd)), metric);
      const previous = measure(aggregate(latest(this.value.days, window.previous, window.previousEnd)), metric);
      const comparisonAvailable = window.elapsed > 0 && dayAt(this.value.startedAt, this.value.timeZone) < window.previous &&
        (!this.value.truncatedThrough || this.value.truncatedThrough < window.previous);
      return { totals, daily, comparison: { current: complete, previous, days: window.elapsed, available: comparisonAvailable },
        keywords: [...new Set(Object.values(this.value.days).flatMap(rows => Object.values(rows).flatMap(row => row.k)))].sort(),
        startedAt: this.value.startedAt, timeZone: this.value.timeZone, period, start: window.start,
        warning: this.warning, truncated: Boolean(this.value.truncatedThrough && this.value.truncatedThrough >= window.start), retentionDays: DAYS };
    }
  }
  globalThis.ThumbnailPatterns = Object.freeze({ PatternLedger, KEY, bits, range, aggregate, measure });
})();
