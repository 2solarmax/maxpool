// Background quota probe.
//
// ON BY DEFAULT (config.quotaProbeSeconds, default 60s; 0 = off). Periodically
// reads each OAuth account's quota from the zero-spend /api/oauth/usage endpoint
// so idle / out-of-band-used accounts' utilization/reset stay fresh without waiting
// to be rotated to — and without consuming any message quota. Without it the scorer
// is blind to an account it isn't actively routing to and will pile traffic onto it.
// This is the one sanctioned active-upstream feature; the proxy is otherwise passive.

import { fetchUsage, fetchProviderUsage } from './oauth.js';
import { listResetCards, redeemResetCard } from './zai-reset-cards.js';
import { listResetGrants, claimResetGrant } from './claude-reset-grants.js';
import { decideZai, decideClaude } from './reset-policy.js';

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, providerProbeFn = fetchProviderUsage, grantsFn = listResetGrants, timeoutMs = 10_000, log = console.log, usageGapMs = null } = {}) {
    this.am = accountManager;
    // Injectable like probeFn: the default hits api.anthropic.com, so a harness that
    // doesn't stub it makes a REAL network call per oauth sweep (a test then passes
    // or fails on internet latency — prober-sweep-liveness, 2026-10-06).
    this.grantsFn = grantsFn;
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
    // Publish the sweep's liveness so the UI can answer "what happens next?"
    // rather than printing a bare "stale". Reported 2026-08-27: a stale marker with
    // no next step reads as a problem the user must fix, when the prober is already
    // retrying on its own.
    this.am.quotaProbeSweeping = true;
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
        this.am.quotaProbeSweeping = false;
        // When the NEXT sweep starts. setInterval fires every intervalMs from the
        // last tick, so "now + interval" is the honest estimate for the UI.
        this.am.quotaProbeNextSweepAt = this.intervalMs > 0 ? Date.now() + this.intervalMs : null;
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
      // Reset cards piggyback on the same poll cycle (z.ai only; zero-spend read).
      // Failures are swallowed on purpose: cards are an enhancement, never a probe
      // health signal — a card-list 401 must not turn the quota bars stale.
      // OWNER GATE (2026-09-30): disabled accounts are excluded from listing AND
      // redemption entirely — a readable key on a disabled account (someone else
      // uses it) is not authority to act.
      if (account.enabled !== false && account.credential) {
        if (account.provider === 'zai' && this.am.applyResetCards) {
          try {
            const cards = await this._withTimeout(listResetCards(account.credential));
            if (cards) {
              this.am.applyResetCards(account.index, cards);
              const act = decideZai(account, cards);
              if (act) await this._redeemZaiCard(account, act);
            }
          } catch { /* cards are best-effort */ }
        }
      }
    } catch { /* best-effort; never let a probe throw */ }
  }

  /** Execute a z.ai card redeem decided by the policy. Logs before/after. */
  async _redeemZaiCard(account, act) {
    try {
      const q = account.quota || {};
      this.log(`[reset-card] ${account.name}: redeeming ${act.resetType} card ${act.card.recordId} (${act.reason}; ses=${q.providerSes ?? '?'} wk=${q.providerWk ?? '?'})`);
      const r = await this._withTimeout(redeemResetCard(account.credential, act.card.recordId, act.resetType));
      if (r?.ok) {
        this.log(`[reset-card] ${account.name}: card ${act.card.recordId} redeemed`);
        if (this.am.applyResetCards) {
          const fresh = await this._withTimeout(listResetCards(account.credential));
          if (fresh) this.am.applyResetCards(account.index, fresh);
        }
      } else {
        this.log(`[reset-card] ${account.name}: redeem FAILED card ${act.card.recordId}: ${r?.error}`);
      }
    } catch (e) { this.log(`[reset-card] ${account.name}: redeem error ${e.message}`); }
  }

  /** Execute a Claude cedar_ember claim decided by the policy. */
  async _claimClaudeGrant(account, act) {
    try {
      const q = account.quota || {};
      this.log(`[reset-grant] ${account.name}: claiming grant ${act.grant.id} (${act.reason}; ses=${q.unified5h ?? '?'} wk=${q.unified7d ?? '?'})`);
      const r = await this._withTimeout(claimResetGrant(account.credential, act.grant.id));
      if (r?.ok) this.log(`[reset-grant] ${account.name}: grant ${act.grant.id} claimed${r.alreadyUsed ? ' (already used — idempotent)' : ''}`);
      else this.log(`[reset-grant] ${account.name}: claim FAILED ${act.grant.id}: ${r?.error}`);
    } catch (e) { this.log(`[reset-grant] ${account.name}: claim error ${e.message}`); }
  }

  /** Probe one OAUTH account. Returns {ok, status} so probeAll can pace/back-off
   *  and so a persistent failure is RECORDED (surfaced in the TUI/status) rather
   *  than silently swallowed — a swallowed failing probe is what let a stale
   *  weekly look fresh. Never throws. */
  async probeOne(account) {
    // Subscription latched org-disabled (account-manager recordProbeError): the quota
    // endpoint 403s before answering anything, so probing is pure waste until the org
    // accepts OAuth again. Skipping also stops the every-60s hammer that ran 700+ times
    // on 2solarmax@ between 2026-09-18 and 09-20.
    if (account.subscriptionGone) return { ok: false, status: 403 };
    try {
      // Claude banked resets (cedar_ember) piggyback on the oauth poll — same
      // OWNER GATE as z.ai cards: a DISABLED account is never listed or claimed.
      try {
        if (account.enabled !== false && account.credential && this.am.applyResetGrants) {
          const listing = await this._withTimeout(this.grantsFn(account.credential));
          if (listing) {
            this.am.applyResetGrants(account.index, listing);
            const act = decideClaude(account, listing);
            if (act) await this._claimClaudeGrant(account, act);
          }
        }
      } catch { /* grants are best-effort; never break the quota probe */ }
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
