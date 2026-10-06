(() => {
  "use strict";
  const STORAGE_KEY = "spendingLedger";
  const FORMAT = 1;
  // USD nanodollars per token. Keep old rate definitions when adding new prices.
  const PRICES = Object.freeze({
    // Decisions has its own input-only price, distinct from Responses pricing.
    "gpt-6-luna": Object.freeze({ id: "gpt-6-luna-decisions@2026-10-06", model: "gpt-6-luna", input: 100, output: 0, longInput: 200, longThreshold: 272000 })
  });
  const fields = ["attempts", "tests", "inputTokens", "outputTokens", "costNanodollars", "unresolved", "unpriced"];
  const empty = () => Object.fromEntries(fields.map(key => [key, 0]));
  const integer = value => Number.isSafeInteger(value) && value >= 0;
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const validTotals = value => object(value) && fields.every(key => integer(value[key]));
  function add(a, b) {
    const result = Object.fromEntries(fields.map(key => [key, a[key] + b[key]]));
    if (!validTotals(result)) throw new Error("Spending totals exceed the supported range.");
    return result;
  }
  function validZone(zone) {
    try { return typeof zone === "string" && Boolean(new Intl.DateTimeFormat("en", { timeZone: zone })); }
    catch { return false; }
  }
  function dayAt(time, timeZone) {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(time);
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return `${value.year}-${value.month}-${value.day}`;
  }
  const validDay = day => /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(`${day}T00:00:00Z`)) &&
    new Date(`${day}T00:00:00Z`).toISOString().slice(0, 10) === day;
  function boundaries(now, zone) {
    const today = dayAt(now, zone);
    // Calendar arithmetic on date keys, never elapsed 24-hour periods across DST.
    const date = new Date(`${today}T00:00:00Z`);
    const weekday = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - weekday);
    const week = date.toISOString().slice(0, 10);
    const previous = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    return { today, week, month: `${today.slice(0, 7)}-01`, retainFrom: previous.toISOString().slice(0, 10) };
  }
  function create(now = Date.now(), zone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
    return { format: FORMAT, startedAt: now, timeZone: validZone(zone) ? zone : "UTC", totals: empty(), days: {}, pending: {}, rates: {}, incomplete: false };
  }
  function validLedger(value) {
    return object(value) && value.format === FORMAT && integer(value.startedAt) && value.startedAt <= 8640000000000000 &&
      validZone(value.timeZone) && validTotals(value.totals) && typeof value.incomplete === "boolean" &&
      object(value.days) && Object.entries(value.days).every(([day, totals]) => validDay(day) && validTotals(totals)) &&
      object(value.pending) && Object.entries(value.pending).every(([id, item]) => /^[a-zA-Z0-9-]{1,100}$/.test(id) && object(item) &&
        integer(item.startedAt) && item.startedAt <= 8640000000000000 && ["automatic", "test"].includes(item.kind)) &&
      object(value.rates) && Object.entries(value.rates).every(([id, rate]) => /^[a-zA-Z0-9.@_-]{1,100}$/.test(id) && object(rate) &&
        typeof rate.model === "string" && rate.model.length <= 100 && integer(rate.input) && integer(rate.output) && validTotals(rate.totals));
  }
  function summarize(value, now = Date.now()) {
    if (!validLedger(value)) return null;
    const range = boundaries(now, value.timeZone);
    const periods = { today: { ...empty(), pending: 0 }, week: { ...empty(), pending: 0 }, month: { ...empty(), pending: 0 }, all: { ...value.totals, pending: 0 } };
    for (const [day, totals] of Object.entries(value.days)) {
      for (const key of ["today", "week", "month"]) {
        if (day >= range[key] && day <= range.today) periods[key] = { ...add(periods[key], totals), pending: periods[key].pending };
      }
    }
    for (const item of Object.values(value.pending)) {
      const day = dayAt(item.startedAt, value.timeZone);
      for (const key of ["today", "week", "month", "all"]) {
        if (key === "all" || (day >= range[key] && day <= range.today)) {
          periods[key].pending++;
          periods[key].attempts++;
          if (item.kind === "test") periods[key].tests++;
        }
      }
    }
    return { periods, startedAt: value.startedAt, timeZone: value.timeZone, incomplete: value.incomplete, rates: value.rates };
  }
  function formatCost(nanodollars) {
    if (nanodollars > 0 && nanodollars < 1000) return "<$0.000001";
    // Format from the integer amount rather than accumulating rounded dollars.
    return `$${(nanodollars / 1e9).toFixed(6)}`;
  }

  class SpendingLedger {
    constructor(storage, { now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone, prices = PRICES } = {}) {
      this.storage = storage;
      this.now = now;
      this.prices = prices;
      this.value = create(now(), timeZone);
      this.writes = Promise.resolve();
      this.warning = "";
      this.writable = true;
    }
    async initialize() {
      try {
        const stored = (await this.storage.get({ [STORAGE_KEY]: null }))[STORAGE_KEY];
        if (stored !== null) {
          if (!validLedger(stored)) throw new Error("Invalid history");
          this.value = structuredClone(stored);
        }
      } catch {
        // Never overwrite existing history when it could not be loaded safely.
        this.writable = false;
        this.warning = "Saved spending history could not be loaded. These are session-only totals; reload the extension to retry.";
        return;
      }
      for (const id of Object.keys(this.value.pending)) this.settle(id);
      await this.persist();
    }
    prune() {
      const { retainFrom } = boundaries(this.now(), this.value.timeZone);
      for (const day of Object.keys(this.value.days)) if (day < retainFrom) delete this.value.days[day];
    }
    persist() {
      this.writes = this.writes.catch(() => {}).then(async () => {
        if (!this.writable) return false;
        this.prune();
        try {
          await this.storage.set({ [STORAGE_KEY]: structuredClone(this.value) });
          this.warning = "";
          return true;
        } catch {
          this.warning = "Spending history could not be saved. Totals include unsaved activity that may be lost when the worker restarts.";
          return false;
        }
      });
      return this.writes;
    }
    async begin(id, kind = "automatic") {
      if (Object.hasOwn(this.value.pending, id)) return;
      this.value.pending[id] = { startedAt: this.now(), kind };
      await this.persist();
    }
    async cancel(id) {
      if (!Object.hasOwn(this.value.pending, id)) return;
      delete this.value.pending[id];
      await this.persist();
    }
    settle(id, metadata) {
      if (!Object.hasOwn(this.value.pending, id)) return false;
      const item = this.value.pending[id];
      const input = metadata?.usage?.input_tokens, output = metadata?.usage?.output_tokens;
      const basePrice = typeof metadata?.model === "string" && Object.hasOwn(this.prices, metadata.model) ? this.prices[metadata.model] : null;
      const price = basePrice && integer(input) && input > basePrice.longThreshold && basePrice.longInput
        ? { ...basePrice, id: `${basePrice.id}-long`, input: basePrice.longInput } : basePrice;
      const delta = { ...empty(), attempts: 1, tests: item.kind === "test" ? 1 : 0 };
      if (integer(input)) delta.inputTokens = input;
      if (integer(output)) delta.outputTokens = output;
      if (!integer(input) || !integer(output)) delta.unresolved = 1;
      else if (!price) delta.unpriced = 1;
      else {
        const cost = input * price.input + output * price.output;
        if (integer(cost)) delta.costNanodollars = cost;
        else delta.unpriced = 1;
      }
      const day = dayAt(item.startedAt, this.value.timeZone);
      try {
        const totals = add(this.value.totals, delta);
        const daily = add(this.value.days[day] || empty(), delta);
        const priced = price && !delta.unresolved && !delta.unpriced ? {
          model: price.model, input: price.input, output: price.output,
          totals: add(this.value.rates[price.id]?.totals || empty(), delta)
        } : null;
        this.value.totals = totals;
        this.value.days[day] = daily;
        if (priced) this.value.rates[price.id] = priced;
      } catch {
        // Do not publish imprecise arithmetic or break thumbnail classification.
        this.value.incomplete = true;
      }
      delete this.value.pending[id];
      return true;
    }
    async complete(id, metadata) {
      if (this.settle(id, metadata)) await this.persist();
    }
    snapshot() {
      return { ledger: structuredClone(this.value), warning: this.warning };
    }
  }
  globalThis.ThumbnailSpending = Object.freeze({ SpendingLedger, STORAGE_KEY, PRICES, create, summarize, formatCost, dayAt });
})();
