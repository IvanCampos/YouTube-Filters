(() => {
  "use strict";
  const STORAGE_KEY = "evaluationCache", FORMAT = 2;
  const TTL = 30 * 86400000, IMAGE_TTL = 7 * 86400000, ALIAS_TTL = 3600000;
  const LIMIT = 5000, BYTE_LIMIT = 4 * 1024 * 1024;
  const catalog = globalThis.ThumbnailClassifiers;
  const digest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
  const hash = text => digest(new TextEncoder().encode(text));
  const validKey = key => typeof key === "string" && /^[a-f0-9]{64}$/.test(key);
  const ttl = id => catalog.isImage(id) ? IMAGE_TTL : TTL;
  const validScore = (id, score) => score && Object.keys(score).every(key => ["probability", "expires"].includes(key)) && catalog.validResult({ schemaVersion: catalog.schemaVersion, results: { [id]: score } }, [id]);
  const touch = (map, key, value) => { map.delete(key); map.set(key, value); };
  class EvaluationCache {
    constructor(storage, model, onError) {
      Object.assign(this, { storage, model, onError, entries: new Map(), aliases: new Map(), failures: new Map(), fingerprints: {}, writes: Promise.resolve(), epoch: 0, owner: "" });
    }
    async initialize(key) {
      this.owner = key ? await hash(key) : "";
      for (const id of catalog.ids) this.fingerprints[id] = await hash(catalog.instructions(id));
      let stored;
      try { stored = (await this.storage.get({ [STORAGE_KEY]: null }))[STORAGE_KEY]; } catch { this.onError(); }
      if (this.owner && stored?.format === FORMAT && stored.classificationVersion === catalog.schemaVersion && stored.model === this.model && stored.owner === this.owner) {
        for (const [key, scores] of Array.isArray(stored.entries) ? stored.entries.filter(e => Array.isArray(e) && e.length === 2) : []) {
          if (!validKey(key) || !scores || typeof scores !== "object") continue;
          const valid = {};
          for (const id of catalog.ids) {
            const score = scores[id];
            if (stored.fingerprints?.[id] === this.fingerprints[id] && validScore(id, score) && Number.isFinite(score.expires) && score.expires > Date.now() && score.expires <= Date.now() + ttl(id)) valid[id] = { probability: score.probability, expires: score.expires };
          }
          if (Object.keys(valid).length) this.entries.set(key, valid);
        }
        for (const entry of Array.isArray(stored.aliases) ? stored.aliases : []) {
          if (!Array.isArray(entry)) continue;
          const [key, value] = entry;
          if (validKey(key) && validKey(value?.key) && Number.isFinite(value.expires) && value.expires > Date.now() && value.expires <= Date.now() + ALIAS_TTL) this.aliases.set(key, { key: value.key, expires: value.expires });
        }
        for (const entry of Array.isArray(stored.failures) ? stored.failures : []) {
          if (!Array.isArray(entry)) continue;
          const [key, value] = entry;
          if (validKey(key) && ["response", "refusal"].includes(value?.code) && [1, 2].includes(value.attempts) && Number.isFinite(value.retryAt) && Number.isFinite(value.expires) && value.expires > Date.now() && value.expires <= Date.now() + ALIAS_TTL && value.retryAt <= value.expires) this.failures.set(key, { code: value.code, attempts: value.attempts, retryAt: value.retryAt, expires: value.expires });
        }
      }
      this.prune();
    }
    value() {
      return { format: FORMAT, classificationVersion: catalog.schemaVersion, model: this.model, owner: this.owner, fingerprints: this.fingerprints,
        entries: [...this.entries], aliases: [...this.aliases], failures: [...this.failures] };
    }
    prune() {
      const now = Date.now();
      for (const [key, scores] of this.entries) {
        for (const id of Object.keys(scores)) if (scores[id].expires <= now) delete scores[id];
        if (!Object.keys(scores).length) this.entries.delete(key);
      }
      for (const map of [this.aliases, this.failures]) {
        for (const [key, value] of map) if (value.expires <= now) map.delete(key);
        while (map.size > LIMIT) map.delete(map.keys().next().value);
      }
      for (const image of [false, true]) {
        const keys = [...this.entries].filter(([, scores]) => Object.keys(scores).some(catalog.isImage) === image).map(([key]) => key);
        for (const key of keys.slice(0, Math.max(0, keys.length - LIMIT))) this.entries.delete(key);
      }
      // JSON is also the persisted representation. Everything here is ASCII;
      // budget includes aliases, failures, and the compatibility metadata.
      let bytes = JSON.stringify(this.value()).length;
      for (const map of [this.aliases, this.failures, this.entries]) {
        while (bytes > BYTE_LIMIT - 256 && map.size) {
          const key = map.keys().next().value, value = map.get(key);
          map.delete(key); bytes -= JSON.stringify([key, value]).length + 1;
        }
      }
    }
    read(key, ids) {
      const scores = this.entries.get(key) || {}, results = {}, missing = [];
      for (const id of ids) {
        const score = scores[id];
        if (score?.expires > Date.now()) results[id] = { probability: score.probability };
        else missing.push(id);
      }
      if (Object.keys(results).length) touch(this.entries, key, scores);
      return { results, missing, expires: ids.length && !missing.length ? Math.min(...ids.map(id => scores[id].expires)) : 0 };
    }
    merge(key, value, ids, expires) {
      if (!validKey(key) || !catalog.validResult(value, ids) || (expires != null && (!Number.isFinite(expires) || expires <= Date.now() || ids.some(id => expires > Date.now() + ttl(id))))) return false;
      const scores = this.entries.get(key) || {};
      for (const id of ids) scores[id] = { probability: value.results[id].probability, expires: expires ?? Date.now() + ttl(id) };
      touch(this.entries, key, scores);
      return true;
    }
    alias(key) {
      const value = this.aliases.get(key);
      if (value?.expires > Date.now()) { touch(this.aliases, key, value); return value; }
      this.aliases.delete(key); return null;
    }
    setAlias(urlKey, key) {
      if (validKey(urlKey) && validKey(key)) touch(this.aliases, urlKey, { key, expires: Date.now() + ALIAS_TTL });
    }
    failure(key) {
      const value = this.failures.get(key);
      if (value?.expires > Date.now()) return value;
      this.failures.delete(key); return null;
    }
    fail(key, code) {
      const attempts = Math.min(2, (this.failure(key)?.attempts || 0) + 1);
      const expires = Date.now() + ALIAS_TTL;
      const value = { code, attempts, retryAt: code === "refusal" || attempts === 2 ? expires : Date.now() + 60000, expires };
      touch(this.failures, key, value); return value;
    }
    persist() {
      const epoch = this.epoch;
      this.writes = this.writes.catch(() => false).then(async () => {
        if (epoch !== this.epoch) return false;
        this.prune();
        try { await this.storage.set({ [STORAGE_KEY]: structuredClone(this.value()) }); return epoch === this.epoch; }
        catch { this.onError(); return false; }
      });
      return this.writes;
    }
    async clear(key) {
      this.epoch++; this.entries.clear(); this.aliases.clear(); this.failures.clear();
      this.owner = key ? await hash(key) : "";
      return this.persist();
    }
  }
  globalThis.ThumbnailEvaluationCache = Object.freeze({ EvaluationCache, hash, digest, STORAGE_KEY, TTL, IMAGE_TTL, ALIAS_TTL, LIMIT, BYTE_LIMIT });
})();
