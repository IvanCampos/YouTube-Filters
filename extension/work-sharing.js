(() => {
  "use strict";
  // Limit executing operations, never callers waiting on shared work.
  class Pool {
    constructor(limit = 2) { this.limit = limit; this.active = 0; this.queue = []; }
    run(operation) {
      return new Promise((resolve, reject) => { this.queue.push({ operation, resolve, reject }); this.pump(); });
    }
    pump() {
      while (this.active < this.limit && this.queue.length) {
        const task = this.queue.shift(); this.active++;
        Promise.resolve().then(task.operation).then(task.resolve, task.reject).finally(() => { this.active--; this.pump(); });
      }
    }
  }
  class Questions {
    constructor() { this.pending = new Map(); }
    async run(items, needed, dispatch) {
      const owned = [], waiting = [];
      for (const item of items) {
        let reservation = this.pending.get(item.key);
        if (!reservation) {
          let resolve;
          const promise = new Promise(done => { resolve = done; });
          reservation = { promise, resolve, interests: new Set() };
          this.pending.set(item.key, reservation); owned.push({ ...item, reservation });
        }
        reservation.interests.add(needed);
        waiting.push({ item, reservation });
      }
      if (owned.length) {
        // A second caller can keep a reservation relevant after its owner leaves.
        const relevant = () => owned.some(item => [...item.reservation.interests].some(check => check()));
        relevant.verify = async () => {
          const interests = new Set(owned.flatMap(item => [...item.reservation.interests]));
          const checks = await Promise.all([...interests].map(check => check() && (check.verify?.() ?? true)));
          return relevant() && checks.some(Boolean);
        };
        Promise.resolve().then(() => dispatch(owned, relevant)).then(result => {
          for (const item of owned) item.reservation.resolve(result[item.id]);
        }, () => {
          for (const item of owned) item.reservation.resolve({ ok: false, code: "unavailable", retryAt: Date.now() + 1000 });
        }).finally(() => {
          for (const item of owned) if (this.pending.get(item.key) === item.reservation) this.pending.delete(item.key);
        });
      }
      try { return Object.fromEntries(await Promise.all(waiting.map(async ({ item, reservation }) => [item.id, await reservation.promise]))); }
      finally { for (const { reservation } of waiting) reservation.interests.delete(needed); }
    }
  }
  globalThis.ThumbnailWork = Object.freeze({ Pool, Questions });
})();
