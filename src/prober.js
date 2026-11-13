// Background quota probe.
//
// ON BY DEFAULT (config.quotaProbeSeconds, default 60s; 0 = off). Periodically
// reads each OAuth account's quota from the zero-spend /api/oauth/usage endpoint
// so idle / out-of-band-used accounts' utilization/reset stay fresh without waiting
// to be rotated to — and without consuming any message quota. Without it the scorer
// is blind to an account it isn't actively routing to and will pile traffic onto it.
// This is the one sanctioned active-upstream feature; the proxy is otherwise passive.

import { fetchUsage, fetchProviderUsage } from './oauth.js';
import { listResetCards, redeemResetCard, fetchZaiModelUsage } from './zai-reset-cards.js';
import { listSubscriptions, monthlyPriceUSD } from './zai-subs.js';
import { listResetGrants, claimResetGrant } from './claude-reset-grants.js';
import { decideZai, decideClaudeWithReason, CLAUDE_WALL_WEEKLY } from './reset-policy.js';
import { zaiHourlyCalls, compareOutsideUsage, isUsableZaiUsage, OUTSIDE_CHECK_MS } from './outside-usage.js';
// Reset-machinery timing lives in ONE leaf module (re-exported for callers that
// imported these from the prober).
import { GRANTS_EVERY_MS, GRANTS_RETRY_MS, CLAIM_BACKOFF_STEPS_MS, CLAIM_BACKOFF_CAP_MS, LIFT_GRACE_MS } from './reset-timing.js';
export { GRANTS_EVERY_MS, GRANTS_RETRY_MS, CLAIM_BACKOFF_STEPS_MS, CLAIM_BACKOFF_CAP_MS, LIFT_GRACE_MS };

// How often a subscription-latched account is rechecked (one probe + at most one
// token refresh per window — cheap, and bounded so a truly canceled plan isn't hammered).
export const SUB_RECHECK_MS = 30 * 60_000;

export class Prober {
  constructor(accountManager, { intervalMs = 0, probeFn = fetchUsage, providerProbeFn = fetchProviderUsage, grantsFn = listResetGrants, timeoutMs = 10_000, log = console.log, usageGapMs = null, zaiUsageFn = fetchZaiModelUsage, cardsFn = listResetCards, now = Date.now } = {}) {
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
    this.zaiUsageFn = zaiUsageFn; // z.ai hourly model-usage fetch (outside-usage detector)
    this.cardsFn = cardsFn;       // reset-card listing, injectable like the others
    this._now = now;              // clock (tests inject; defaults to the real one)
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
        // Pool links are probed by their own PoolLink status poll, not here.
        const providers = this.am.accounts.filter(a => a.type === 'provider' && a.credential);  // 'pool' rows are excluded by type

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
      await this._checkOutsideUsage(account);
      // Reset cards piggyback on the same poll cycle (z.ai only; zero-spend read).
      // Failures are swallowed on purpose: cards are an enhancement, never a probe
      // health signal — a card-list 401 must not turn the quota bars stale.
      // OWNER GATE (2026-09-30): disabled accounts are excluded from listing AND
      // redemption entirely — a readable key on a disabled account (someone else
      // uses it) is not authority to act.
      // A duplicate-guard-benched copy never redeems: the team pool owns that key now,
      // and two pools redeeming one key would burn two cards for one reset.
      if (account.enabled !== false && account.credential && !account.poolBenchedBy) {
        // Subscription (price-per-token column): same cadence, same key, best-effort.
        if (account.provider === 'zai' && this.am.applyMonthlyPrice) {
          try {
            if (!account._subsCheckedAt || Date.now() - account._subsCheckedAt > 24 * 3600_000) {
              const subs = await this._withTimeout(listSubscriptions(account.credential));
              account._subsCheckedAt = Date.now();
              if (subs && !subs.error) this.am.applyMonthlyPrice(account.index, monthlyPriceUSD(subs.subscriptions));
            }
          } catch { /* price is display-only */ }
        }
        if (account.provider === 'zai' && this.am.applyResetCards) {
          try {
            const cards = await this._withTimeout(this.cardsFn(account.credential));
            if (cards) {
              this.am.applyResetCards(account.index, cards);
              this._logCardListingTransition(account, cards);
              const act = decideZai(account, cards);
              if (act) await this._redeemZaiCard(account, act);
            }
          } catch { /* cards are best-effort */ }
        }
      }
    } catch { /* best-effort; never let a probe throw */ }
  }

  /** OUTSIDE-USAGE DETECTOR (2026-10-27), hourly per account: fetch z.ai's own
   *  hourly model-call counts for the account and compare with what the pool sent
   *  in the same complete hours. A divergent account (key used by someone else —
   *  measured 2026-08-10→10-26: 45,155 outside calls on max+1) is recorded on the
   *  account (reset-card policy R7 refuses to feed it) and logged ONCE per
   *  transition, never per sweep. Disabled accounts are never checked: someone
   *  else legitimately using the key is WHY the account is benched. */
  async _checkOutsideUsage(account, now = this._now()) {
    try {
      // Benched duplicate: the team pool's traffic on this key is NOT outside usage.
      if (account.provider !== 'zai' || !account.credential || account.enabled === false || account.poolBenchedBy) return;
      const last = account._outsideCheckedAt || 0;
      if (now - last < OUTSIDE_CHECK_MS) return;
      const data = await this._withTimeout(this.zaiUsageFn(account.credential, { now }));
      if (!isUsableZaiUsage(data)) {
        // FAILED or malformed read. Never downgrade a true flag on missing data (red-team R1.1:
        // one 5xx un-protected a known leak and the SAME sweep redeemed a card into
        // it). Keep the reading, mark it stale (R7 still holds), and RETRY next
        // sweep — the hourly slot is only consumed by a successful read.
        const prev = account.outsideUsage;
        if (prev) account.outsideUsage = { ...prev, stale: true, checkedAt: now };
        return;
      }
      account._outsideCheckedAt = now;          // stamp AFTER success (R1.5)
      const zai = zaiHourlyCalls(data);
      const res = compareOutsideUsage(zai, account.poolHourly, { now, poolUpSince: this.am.poolUpSince, sinceMs: account.addedAt ?? null });
      const prev = account.outsideUsage;
      const wasOutside = Boolean(prev?.outside);
      account.outsideUsage = { ...res, checkedAt: now };
      if (res.outside && !wasOutside) {
        this.log(`[outside-usage] ${account.name}: z.ai counted ${res.zaiCalls} calls in the last ${res.hours}h but the pool sent ${res.poolCalls} — someone else holds this key; reset cards held`);
      }
    } catch { /* detector is best-effort; never block the probe */ }
  }

  /** Execute a z.ai card redeem decided by the policy. Logs before/after.
   *  A FAILED redeem backs off exponentially per card (15m, 30m, 1h, cap 6h):
   *  2026-10-22/23, a z.ai API change made every redeem fail "unavailable" and the
   *  2-minute poll retried the same card 519 times over 16h — the exact
   *  rapid-retry shape z.ai's usage-risk notice flagged before. A success resets
   *  the backoff; the idempotent requestId keeps any overlapping attempt single-spend. */
  async _redeemZaiCard(account, act) {
    try {
      const key = `${account.name}:${act.card.recordId}`;  // name, not index: index shifts on account removal
      const now = Date.now();
      const until = this._cardRetryUntil?.get(key);
      if (until && until > now) return;                 // still backing off
      const q = account.quota || {};
      this.log(`[reset-card] ${account.name}: redeeming ${act.resetType} card ${act.card.recordId} (${act.reason}; ses=${q.providerSes ?? '?'} wk=${q.providerWk ?? '?'})`);
      let r = await this._withTimeout(redeemResetCard(account.credential, act.card.recordId, act.resetType, { grantType: act.card.grantType, accountKey: account.name }));
      // grantType-less listing + "unavailable" is the exact 2026-10-22 outage shape; GLOBAL
      // is the only grantType z.ai has ever issued and a wrong one answers 400 no-spend
      // (measured, src/zai-reset-cards.js header) — so one fallback retry is safe.
      if (!r?.ok && !act.card.grantType && /unavailable/i.test(r?.error || '')) {
        r = await this._withTimeout(redeemResetCard(account.credential, act.card.recordId, act.resetType, { grantType: 'GLOBAL', accountKey: account.name }));
      }
      if (r?.ok) {
        if (!this._cardRetryUntil) this._cardRetryUntil = new Map();
        this._cardRetryUntil.set(key, 0);               // success clears any backoff
        this._cardTries?.set(key, 0);                   // ...and the failure count (red-team 2026-10-23)
        this.log(`[reset-card] ${account.name}: card ${act.card.recordId} redeemed`);
        // A4: remove the redeemed card from the stored list BEFORE the follow-up
        // read — if that read fails (or is drifted), the stale-kept list must not
        // keep counting a card that no longer exists (pre-mortem #17).
        this.am.removeResetCard?.(account.index, act.card.recordId);
        if (this.am.applyResetCards) {
          const fresh = await this._withTimeout(listResetCards(account.credential));
          if (fresh && !fresh.error) this.am.applyResetCards(account.index, fresh);
        }
      } else {
        const tries = (this._cardTries?.get(key) || 0) + 1;
        if (!this._cardTries) this._cardTries = new Map();
        this._cardTries.set(key, tries);
        const waitMs = Math.min(6 * 3600_000, 900_000 * 2 ** (tries - 1));
        if (!this._cardRetryUntil) this._cardRetryUntil = new Map();
        this._cardRetryUntil.set(key, now + waitMs);
        this.log(`[reset-card] ${account.name}: redeem FAILED card ${act.card.recordId} (try ${tries}, next attempt in ${Math.round(waitMs / 60000)}min): ${r?.error}`);
      }
    } catch (e) { this.log(`[reset-card] ${account.name}: redeem error ${e.message}`); }
  }

  /** One log line per ok<->failing transition of the grant listing (no per-poll spam). */
  _logGrantListingTransition(account, listing) {
    const failing = Boolean(listing.error);
    if (failing && !account._grantListFailing) {
      account._grantListFailing = true;
      this.log(`[reset-grant] ${account.name}: listing FAILED (${listing.error}) — keeping last known reset count, marked stale`);
    } else if (!failing && account._grantListFailing) {
      account._grantListFailing = false;
      this.log(`[reset-grant] ${account.name}: listing recovered`);
    }
  }

  /** A4: one log line per ok<->failing transition of the z.ai CARD listing. */
  _logCardListingTransition(account, cards) {
    const failing = Boolean(cards.error);
    if (failing && !account._cardListFailing) {
      account._cardListFailing = true;
      this.log(`[reset-card] ${account.name}: listing FAILED (${cards.error}) — keeping last known cards, marked stale`);
    } else if (!failing && account._cardListFailing) {
      account._cardListFailing = false;
      this.log(`[reset-card] ${account.name}: listing recovered`);
    }
  }

  /** Execute a Claude cedar_ember claim decided by the policy.
   *  C6: the ONE claim lock per account lives on the account-manager (shared with
   *  the reactive path); a FAILED claim backs off per (account, grantId)
   *  15m/30m/1h cap 6h; a SUCCESSFUL claim sets lastClaimAt (decideClaude then
   *  waits for a newer probe before claiming again) and clears any reactive
   *  scoped entry / weekly throttle so the account can serve again immediately. */
  async _claimClaudeGrant(account, act) {
    if (!act?.grant) return false;
    const now = Date.now();
    const key = `${account.name}:${act.grant.id}`;
    const until = this.am._claimRetryUntil?.get?.(key);
    if (until && until > now) return false;
    if (!this.am.acquireClaimLock?.(account.name)) return false;
    try {
      const q = account.quota || {};
      this.log(`[reset-grant] ${account.name}: claiming grant ${act.grant.id} (${act.reason}; ses=${q.unified5h ?? '?'} wk=${q.unified7d ?? '?'})`);
      const r = await this._withTimeout(claimResetGrant(account.credential, act.grant.id, { accountKey: account.name }));
      if (r?.ok) {
        this.am.noteClaimSuccess?.(account.name, act.grant.id);
        account.lastClaimAt = Date.now();
        // Spend it in the STORED listing too: until the next listing (≤5 min) the
        // held count, the lift and the reactive path must not see it as unspent.
        this.am.noteGrantClaimed?.(account, act.grant.id);
        // C3 give-back: snapshot unified7d BEFORE the claim so the next probe can
        // measure the drop a give-back grant actually returned (cap+drop ceiling).
        if (act.giveBack) {
          account.giveBack = { pendingAt: account.lastClaimAt, utilBefore: Number(q.unified7d) || 0 };
        }
        // C3: a claim (success or failure) ends the cap lift.
        this.am.endCapLift?.(account.index, 'claim succeeded');
        // C2/C6: the wall this claim refills is gone — clear the reactive scoped
        // entry (a Fable bench stuck at 1.0 was the double-claim shape) and end
        // the bench so the account serves again.
        if (act.scope && act.scope !== 'general' && account.quota?.scopedWeekly?.[act.scope]) {
          delete account.quota.scopedWeekly[act.scope];
        }
        if (account.status === 'throttled') {
          account.status = 'active';
          account.rateLimitedUntil = null;
          if (account.lastError === 'rate_limited') { account.lastError = null; account.lastErrorAt = null; }
        }
        this.log(`[reset-grant] ${account.name}: grant ${act.grant.id} claimed${r.alreadyUsed ? ' (already used — idempotent)' : ''}`);
        return true;
      }
      const { tries, waitMs } = this.am.noteClaimFailure?.(account.name, act.grant.id, now)
        || { tries: 1, waitMs: CLAIM_BACKOFF_STEPS_MS[0] };
      this.log(`[reset-grant] ${account.name}: claim FAILED ${act.grant.id} (try ${tries}, next attempt in ${Math.round(waitMs / 60000)}min): ${r?.error}`);
      // A failed claim ENDS any cap lift (C3: "ends at once on a claim (success or failure)").
      this.am.endCapLift?.(account.index, 'claim failed');
      return false;
    } catch (e) {
      this.log(`[reset-grant] ${account.name}: claim error ${e.message}`);
      return false;
    } finally {
      this.am.releaseClaimLock?.(account.name);
    }
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
    // SELF-CLEAR RECHECK (2026-10-08): the latch used to be terminal — the account was
    // skipped here AND by ensureTokenFresh, so a single transient org-403 benched a live
    // subscription until manual re-auth. Recheck it at a low cadence: a 200 clears the
    // latch (applyUsageData), another org-403 keeps it benched.
    if (account.subscriptionGone) {
      // A latch set outside recordProbeError (state restore, tests, older builds) has no
      // stamp: treat NOW as the latch moment so the first recheck waits a full window.
      if (!account._subRecheckAt) account._subRecheckAt = Date.now();
      const since = Date.now() - account._subRecheckAt;
      if (since < SUB_RECHECK_MS) return { ok: false, status: 403 };
      account._subRecheckAt = Date.now();
      account._subRecheck = true;
    }
    try {
      // A3: refresh the token BEFORE the grants listing — a near-expired token
      // otherwise 401s the listing and blanks the count every refresh cycle.
      await this.am.ensureTokenFresh(account.index);
      // Claude banked resets (cedar_ember) piggyback on the oauth poll — same
      // OWNER GATE as z.ai cards: a DISABLED account is never listed or claimed.
      try {
        // A pool-benched duplicate never claims a grant: the cloud owns this account
        // (mirror of the z.ai card guard above; red-team 2026-10-31).
        if (account.enabled !== false && account.credential && !account.poolBenchedBy && this.am.applyResetGrants) {
          // A2 (pre-mortem #12, 2026-11-10): the grants call hits the SAME per-IP
          // rate-limited /api/oauth/usage endpoint as the usage probe — listing it
          // on EVERY sweep is half the 429 pressure that blanks the count. List at
          // most once per GRANTS_EVERY_MS (5 min) per account. The usage probe
          // below still runs every sweep, so /api/oauth/usage calls per sweep never
          // exceed the pre-change count (2 per account on the grants tick, 1 otherwise).
          const nowMs = this._now();
          const last = account._grantsListedAt || 0;
          const staleOrErrored = account.resetGrants == null
            || account.resetGrants.stale === true
            || account.resetGrants.eligible === false;
          if (nowMs - last >= GRANTS_EVERY_MS || (last > 0 && staleOrErrored && nowMs - last >= GRANTS_RETRY_MS)) {
            // A timeout or throw is a failed listing too (stale, logged once), not silence.
            let listing;
            try { listing = await this._withTimeout(this.grantsFn(account.credential)); }
            catch (e) { listing = { error: e?.message || String(e) }; }
            if (listing == null) listing = { error: 'timed out' };
            if (listing) {
              account._grantsListedAt = nowMs;
              this.am.applyResetGrants(account.index, listing);
              this._logGrantListingTransition(account, listing);
            }
          }
          // C1: decide AFTER this sweep's usage probe (below), never before it —
          // a decision on the pre-probe reading (up to ~36 min old) is what spent
          // resets right after a free refill. The decision runs at the END of
          // probeOne via _decideClaimAfterProbe, once applyUsageData has stamped
          // lastProbeOkAt.
        }
      } catch { /* grants are best-effort; never break the quota probe */ }
      // C1/finding 1: the SEND time of the probe whose reading a claim decides on.
      // A probe sent before a claim and applied after it carries the PRE-claim
      // reading; comparing the send time (not the apply time) with lastClaimAt
      // keeps it from licensing a second claim for the same wall.
      let probeSentAt = Date.now();
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
          probeSentAt = Date.now();
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
      this.am.applyUsageData(account.index, usage, { sentAt: probeSentAt }); // clears the error + stamps freshness
      // C1: decide the claim on the reading JUST stored (this sweep's probe), on
      // the listing stored this same sweep — never on a pre-probe reading.
      await this._decideClaimAfterProbe(account);
      return { ok: true, status: 200 };
    } catch (e) { // best-effort; never let a probe throw
      this.am.recordProbeError?.(account.index, e?.message || String(e), null);
      return { ok: false, status: null };
    } finally {
      account._subRecheck = false;
    }
  }

  /** C1 + C5: the claim decision proper, run AFTER applyUsageData. A skip at a
   *  reached limit logs ONCE per change of (account, reason), never per sweep. */
  async _decideClaimAfterProbe(account) {
    if (account.enabled === false || !account.credential || account.poolBenchedBy) return;
    if (!this.am.applyResetGrants) return;
    const listing = account.resetGrants;
    if (!listing) return;
    // R7 (2026-11-13): the wall claim waits for an imminent free refill only while
    // other accounts in THIS pool have room. Counted LIVE per sweep, so the hold
    // ends the moment capacity disappears; unknown capacity claims (never hold).
    const peersWithRoom = this.am.countPeersWithRoom ? scope => this.am.countPeersWithRoom(account, scope) : null;
    const { action, reason } = decideClaudeWithReason(account, listing, Date.now(), { peersWithRoom });
    if (action) {
      account._claimSkipKey = null;
      await this._claimClaudeGrant(account, action);
      return;
    }
    // C5: at a reached limit with a held-but-unspent grant, say WHY once per
    // (account, reason) change — the owner's live check reads exactly these lines.
    // The reason is the POLICY's own rejection (stale listing, cooldown, already
    // claimed, window elapsed, …), never a guess reconstructed here.
    const q = account.quota || {};
    const wk = q.unified7d ?? null;
    const scopedAtWall = Object.values(q.scopedWeekly || {}).some(e =>
      e && e.reactive !== true && e.utilization != null && e.utilization >= CLAUDE_WALL_WEEKLY);
    const atWall = (wk != null && wk >= CLAUDE_WALL_WEEKLY) || scopedAtWall;
    const held = (listing.grants || []).some(g => g && !g.paused && !g.expired);
    if (!atWall || !held) {
      // Left the wall (or holds nothing): the next wall logs its reason afresh.
      account._claimSkipKey = null;
      return;
    }
    if (reason == null) return;
    if (account._claimSkipKey !== reason) {
      account._claimSkipKey = reason;
      this.log(`[reset-grant] ${account.name}: at wall, claim held (${reason})`);
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
