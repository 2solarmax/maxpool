// Background quota probe.
//
// ON BY DEFAULT (config.quotaProbeSeconds, default 60s; 0 = off). Periodically
// reads each OAuth account's quota from the zero-spend /api/oauth/usage endpoint
// so idle / out-of-band-used accounts' utilization/reset stay fresh without waiting
// to be rotated to — and without consuming any message quota. Without it the scorer
// is blind to an account it isn't actively routing to and will pile traffic onto it.
// This is the one sanctioned active-upstream feature; the proxy is otherwise passive.

import { fetchUsage, fetchProviderUsage } from './oauth.js';

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, providerProbeFn = fetchProviderUsage, timeoutMs = 10_000, log = console.log, usageGapMs = null } = {}) {
    this.am = accountManager;
    this.intervalMs = intervalMs;
    this.probeFn = probeFn;
    this.providerProbeFn = providerProbeFn;
    this.timeoutMs = timeoutMs;
    this.log = log;
    this.timer = null;
    this._running = false;
    // De-burst pacing for the shared, per-IP-rate-limited /api/oauth/usage
    // endpoint (see probeAll). null gap → derive from intervalMs; 0 → no pacing.
    this._configuredUsageGapMs = usageGapMs;
    this._usageGapMs = null;      // current adaptive gap (grows on 429, eases on OK)
    this._lastUsageProbeAt = 0;   // ms of the last usage request across ALL accounts
    this._stopping = false;
    this._pendingSleep = null;    // canceller for an in-flight pacing sleep
    this._sweepStart = 0;         // rotates the per-sweep start account (fairness)
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
    this._stopping = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (this._pendingSleep) this._pendingSleep(); // abort an in-flight pacing wait
    if (this._inflight) { try { await this._inflight; } catch { /* swallow */ } }
  }

  /** Probe every OAuth account (usage endpoint) and every provider account with a
   *  pollable/known quota source (z.ai monitor; Kimi → console-only marker) once.
   *  Overlapping cycles are skipped. The active cycle is tracked on `_inflight` so
   *  stop() can await it. */
  probeAll() {
    if (this._running) return this._inflight || Promise.resolve();
    this._running = true;
    this._stopping = false;
    this._inflight = (async () => {
      try {
        // CAPACITY LEDGER: close any open cycle whose window's reset stamp has
        // passed. Runs at the top of every sweep (lease-holder only — probeAll
        // fires from the prober, which start/stop with the lease) so a window that
        // rolled over between requests still closes promptly, not only on the next
        // accrual or stamp-advance.
        try { this.am.closeExpiredCapacityCycles?.(); } catch { /* never block probing */ }
        // DISABLED accounts are INTENTIONALLY still probed (no `a.enabled` filter):
        // a user often disables an account precisely BECAUSE it's exhausted, and still
        // wants to see its quota recover — so keep refreshing its usage for visibility
        // even though routing skips it. Do NOT add an enabled gate here.
        // Skip only auth-dead accounts (dead refresh token): probing them just re-POSTs
        // the rejected token every cycle — a 400 storm. They recover only on re-auth.
        const oauth = this.am.accounts.filter(a => a.type === 'oauth' && a.credential && !a.refreshDead);
        const providers = this.am.accounts.filter(a => a.type === 'provider' && a.credential);

        // Providers read DISTINCT hosts (z.ai monitor / Kimi) — no collision — so
        // they run concurrently. Every OAuth account, though, reads the SAME
        // /api/oauth/usage, which is tightly rate-limited PER SOURCE IP: firing them
        // all at once (the old Promise.all) 429'd all but ~one per cycle, so only a
        // single account's 5h/7d refreshed each tick and the weekly looked frozen.
        // Probe the OAuth accounts ONE AT A TIME, paced across the interval, and back
        // off on a 429 — so the whole fleet refreshes instead of self-throttling.
        const providerWork = Promise.all(providers.map(a => this.probeProvider(a)));
        // Rotate the start account each sweep so no account is systematically the
        // oldest-refreshed (the serialized sweep would otherwise always probe the
        // last account last).
        const start = oauth.length ? (this._sweepStart++ % oauth.length) : 0;
        for (let i = 0; i < oauth.length; i++) {
          if (this._stopping) break;
          await this._paceUsage();
          if (this._stopping) break;
          const r = await this.probeOne(oauth[(start + i) % oauth.length]);
          this._lastUsageProbeAt = Date.now();
          if (r && r.status === 429) this._bumpUsageGap();
          else if (r && r.ok) this._relaxUsageGap();
        }
        await providerWork.catch(() => {});
      } finally {
        this._running = false;
        this._inflight = null;
      }
    })();
    return this._inflight;
  }

  /** Wait until the current usage-probe gap has elapsed since the last usage
   *  request, so consecutive OAuth probes don't collide on the shared endpoint.
   *  No-op when pacing is disabled (gap 0 — manual/tests). Abortable via stop(). */
  async _paceUsage() {
    const gap = this._usageGapMs != null ? this._usageGapMs : this._baseUsageGap();
    if (!gap || gap <= 0) return;
    const wait = gap - (Date.now() - (this._lastUsageProbeAt || 0));
    if (wait > 0) await this._sleep(wait);
  }

  /** Base spacing between usage probes. Spread ~all accounts across the interval
   *  (interval/6, clamped 6-20s) unless explicitly configured. 0 when the probe is
   *  off / driven manually so a direct probeAll() runs with no delay. */
  _baseUsageGap() {
    if (this._configuredUsageGapMs != null) return this._configuredUsageGapMs;
    if (this.intervalMs > 0) return Math.max(6000, Math.min(20_000, Math.floor(this.intervalMs / 6)));
    return 0;
  }

  /** A usage 429 means we're probing the shared endpoint too fast — widen the gap
   *  (×1.5, cap 120s) so the fleet stops self-throttling. */
  _bumpUsageGap() {
    const base = this._baseUsageGap();
    if (base <= 0) return; // pacing disabled — nothing to back off
    const cur = this._usageGapMs != null ? this._usageGapMs : base;
    this._usageGapMs = Math.min(120_000, Math.round(cur * 1.5));
  }

  /** A clean probe — ease the gap back toward the base (never below it). */
  _relaxUsageGap() {
    const base = this._baseUsageGap();
    if (base <= 0) { this._usageGapMs = null; return; }
    const cur = this._usageGapMs != null ? this._usageGapMs : base;
    this._usageGapMs = Math.max(base, Math.round(cur * 0.9));
  }

  /** Abortable sleep — stop() cancels an in-flight pacing wait so a baton release
   *  never blocks on it. NOT unref'd: the wait is short (≤ gap), it only runs during
   *  an active sweep, and graceful shutdown always goes through stop() which clears
   *  it — so it can't delay exit, while staying ref'd keeps the awaited sweep alive. */
  _sleep(ms) {
    return new Promise(resolve => {
      if (this._stopping) return resolve();
      const t = setTimeout(() => { this._pendingSleep = null; resolve(); }, ms);
      this._pendingSleep = () => { clearTimeout(t); this._pendingSleep = null; resolve(); };
    });
  }

  /** Probe one PROVIDER account. Provider tokens are static API keys (no OAuth
   *  refresh). Best-effort; never throws. */
  async probeProvider(account) {
    try {
      const usage = await this._withTimeout(this.providerProbeFn(account));
      if (!usage) return; // timed out — try again next cycle
      this.am.applyProviderUsage(account.index, usage);
    } catch { /* best-effort; never let a probe throw */ }
  }

  /** Probe one OAUTH account. Returns {ok, status} so probeAll can pace/back-off
   *  and so a persistent failure is RECORDED (surfaced in the TUI/status) rather
   *  than silently swallowed — a swallowed failing probe is what let a stale
   *  weekly look fresh. Never throws. */
  async probeOne(account) {
    try {
      await this.am.ensureTokenFresh(account.index);
      let usage = await this._withTimeout(this.probeFn(account.credential));
      if (usage?.status === 401) {
        // Token rejected — force a refresh and retry once. NOT for a DISABLED account:
        // `force` deliberately overrides the no-rotate guard in ensureTokenFresh (it
        // exists for user-initiated re-auth), so forcing here would rotate the very
        // single-use token that guard protects. Worse, it is GUARANTEED to fire for a
        // disabled account: blocking the proactive refresh means the token always
        // expires, which always 401s — moving the rotation from the controlled
        // pre-expiry path into this error path. Accept the 401 and record it; the
        // account refreshes normally the moment it is re-enabled.
        if (account.enabled !== false) {
          await this.am.ensureTokenFresh(account.index, true);
          usage = await this._withTimeout(this.probeFn(account.credential));
        }
      }
      if (usage == null) { // timed out
        this.am.recordProbeError?.(account.index, 'probe timed out', null);
        return { ok: false, status: null };
      }
      if (usage.error) { // HTTP error (e.g. 429) or fetch failure
        this.am.recordProbeError?.(account.index, usage.error, usage.status ?? null);
        return { ok: false, status: usage.status ?? null };
      }
      this.am.applyUsageData(account.index, usage); // clears the error + stamps freshness
      return { ok: true, status: 200 };
    } catch (e) { // best-effort; never let a probe throw
      this.am.recordProbeError?.(account.index, e?.message || String(e), null);
      return { ok: false, status: null };
    }
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
