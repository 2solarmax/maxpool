// Opt-in background quota probe.
//
// DISABLED BY DEFAULT. When enabled (config.quotaProbeSeconds > 0), periodically
// reads each OAuth account's quota from the zero-spend /api/oauth/usage endpoint
// so idle accounts' utilization/reset stay fresh without waiting to be rotated
// to — and without consuming any message quota. This is the one sanctioned
// active-upstream feature; the proxy is otherwise passive.

import { fetchUsage } from './oauth.js';

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, timeoutMs = 10_000, log = console.log } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.probeFn = probeFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
  }

  start() {
    if (this.intervalMs > 0) this.reschedule(this.intervalMs);
  }

  /** Change the interval at runtime (0 = off). Probes once immediately when on. */
  reschedule(intervalMs) {
    const wasOn = this.intervalMs > 0 && this.timer;
    this.intervalMs = intervalMs;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }

    if (intervalMs > 0) {
      // Probe right away so quota populates without waiting a full cycle.
      this.probeAll().catch(() => {});
      this.timer = setInterval(() => this.probeAll().catch(() => {}), intervalMs);
      this.timer.unref?.();
      this.log(`[Maxpool] Quota probe enabled (every ${Math.round(intervalMs / 1000)}s)`);
    } else if (wasOn) {
      this.log('[Maxpool] Quota probe disabled');
    }
  }

  /** Stop scheduling AND await any probe cycle already in flight, so a caller
   *  (the baton release) can be sure no probe-driven token rotation is pending
   *  before it hands the writer lease to another worker. */
  async stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._inflight) { try { await this._inflight; } catch { /* swallow */ } }
  }

  /** Probe every OAuth account once. Overlapping cycles are skipped. The active
   *  cycle is tracked on `_inflight` so stop() can await it. */
  probeAll() {
    if (this._running) return this._inflight || Promise.resolve();
    this._running = true;
    this._inflight = (async () => {
      try {
        const accounts = this.am.accounts.filter(a => a.type === 'oauth' && a.credential);
        await Promise.all(accounts.map(a => this.probeOne(a)));
      } finally {
        this._running = false;
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  async probeOne(account) {
    try {
      await this.am.ensureTokenFresh(account.index);
      let usage = await this._withTimeout(this.probeFn(account.credential));
      if (usage?.status === 401) {
        // Token rejected — force a refresh and retry once.
        await this.am.ensureTokenFresh(account.index, true);
        usage = await this._withTimeout(this.probeFn(account.credential));
      }
      if (!usage || usage.error) return; // transient — try again next cycle
      this.am.applyUsageData(account.index, usage);
    } catch { /* best-effort; never let a probe throw */ }
  }

  _withTimeout(promise) {
    return Promise.race([
      promise,
      new Promise(resolve => {
        const t = setTimeout(() => resolve(null), this.timeoutMs);
        t.unref?.();
      }),
    ]);
  }
}
