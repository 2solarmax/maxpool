import { refreshAccessToken, isTokenExpiringSoon, modelFamily, tokenFingerprint } from './oauth.js';

// Bounded re-poll hold for an account blocked ONLY by a transient, self-clearing
// condition whose exact recovery time is unknown: (a) a weekly-critical account
// (last-resort usable, no learned reset), or (b) an otherwise-healthy account at
// its in-flight / global concurrency cap (a sibling completing frees a slot in
// seconds). Both are recoverable by definition, so they must HOLD finite and let
// waitForAvailableRoute's poll loop re-check real availability — never collapse to
// an Infinity session-kill / error-fast.
const BOUNDED_REPOLL_HOLD_MS = 60_000;

// Session rebalancing (issue #1): a bound session may migrate OFF a hot account
// onto a much-healthier one, but ONLY on a thinking-safe request (see
// _migrationSafeForRequest). These margins force a CLEAR, flap-stable win so a
// session can never ping-pong between two similarly-loaded accounts.
const REBALANCE_SCORE_MARGIN = 0.5;   // candidate score must be ≤ 50% of the bound account's
const REBALANCE_MIN_ABS_GAP = 0.5;    // …with a small absolute floor so near-zero scores don't micro-churn
// Weekly-pressure tiers, healthiest first. A fresh (unknown) account is the best
// migration target; migration requires the candidate be a STRICTLY healthier tier.
const WEEKLY_TIER = { unknown: 0, normal: 0, soft: 1, reserve: 2, critical: 3, exhausted: 4 };

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    genericLimit: null,
    genericRemaining: null,
    genericReset: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
    unified5hRaw: null,    // upstream-reported utilization before display clamp
    unified7dRaw: null,    // upstream-reported utilization before display clamp
    unified5hReset: null,  // ms timestamp
    unified7dReset: null,  // ms timestamp
    // Per-model weekly sub-limits Anthropic enforces SEPARATELY from the unified
    // weekly (e.g. Fable can be 100% while unified is 56%). Keyed by model family:
    // { fable:{utilization,resetAt,severity,isActive}, opus:{...}, sonnet:{...} }.
    scopedWeekly: {},
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
    // Provider (z.ai / Kimi) quota — kept SEPARATE from unified* so a provider
    // reading never leaks into the OAuth quota gates (_isAvailable / _weeklyRawState
    // / _accountScarcity read unified* only). z.ai is pollable; Kimi is not.
    providerSes: null,          // utilization 0-1 (z.ai 5h token window)
    providerSesReset: null,     // ms
    providerWk: null,           // utilization 0-1 (z.ai weekly), null if plan has none
    providerWkReset: null,      // ms
    providerQuotaSource: null,  // 'zai' (pollable) | 'console-only' (kimi) | null
    // Freshness: last time a background usage PROBE succeeded for this account
    // (oauth fetchUsage OR provider fetchProviderUsage). Drives the TUI staleness
    // marker — a swallowed failing probe no longer silently freezes a stale tag.
    // Header-driven updates do NOT stamp this (headers can't refresh scoped/provider).
    lastProbeOkAt: null,        // ms
    // Last background probe FAILURE — surfaced in the TUI/status so a persistently
    // failing probe (e.g. the usage endpoint rate-limiting us) is VISIBLE instead of
    // silently swallowed (which let a stale weekly keep looking fresh). Cleared on
    // the next successful probe. Not persisted (transient).
    lastProbeError: null,       // string
    lastProbeErrorAt: null,     // ms
    lastProbeErrorStatus: null, // http status (429, 500, …) or null
    // Last time the DISPLAYED bars (unified5h/7d for OAuth, tokens/requests for
    // API-key) were refreshed from a RESPONSE HEADER (updateQuota). Lets the TUI
    // staleness marker tell "probe stale but bars fresh from live traffic" (a busy
    // account — NOT stale) from "genuinely nothing refreshed it" (idle — stale).
    lastHeaderQuotaAt: null,    // ms
  };
}

const DEFAULT_SCHEDULER = {
  safetyMaxActivePerAccount: 50,
  safetyMaxGlobalActive: 150,
  cooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  // Fixed cooldown for NETWORK-class failures (lost connectivity / token-refresh
  // fetch-failed). Short + non-escalating so the fleet auto-recovers seconds after
  // connectivity returns, instead of the exponential maxCooldownMs bench.
  networkCooldownMs: 5_000,
  weeklySoftThreshold: 0.65,
  weeklyReserveThreshold: 0.85,
  weeklyCriticalThreshold: 0.95,
  weeklyExhaustedThreshold: 0.985,
  weeklyBurnDebtWeight: 0.6,
  // Routing-cost tuning (lower cost = preferred). The goal is to AVOID
  // short-term (rate/concurrency) throttling by spreading load across healthy
  // accounts. So in-flight concurrency is the DOMINANT term, with a steep
  // per-account soft cap; burn-pace is only a soft de-preference (never a
  // bench); quota "use-it-or-lose-it" is intentionally a minor signal here.
  concurrencyWeight: 2,            // multiplies in-flight load (activeWeight+reqWeight) — dominant
  perAccountConcurrencyTarget: 3,  // D: soft per-account in-flight target; past it, capPenalty bites
  capPenaltyWeight: 10,            // steep penalty per unit of in-flight depth past D (throttle safety floor)
  paceCostWeight: 1.5,            // soft de-preference of accounts burning ahead of pace (was the ×6 term)
  scarcityWeight: 6,              // legacy; superseded by paceCostWeight (kept so old configs don't error)
  spreadShareWeight: 3,           // multiplies an account's share of recent fleet load (0..1)
  recoveryRampWeight: 4,          // decaying penalty applied to a just-recovered account
  recoveryRampMs: 5 * 60_000,     // how long the post-recovery ramp lasts
  spreadWindowMs: 15 * 60_000,    // rolling window used to measure recent per-account load
  // Allow a signed-thinking session to rebalance onto a DIFFERENT Claude account
  // (never a provider — GLM/Kimi can't validate an Anthropic signature). Anthropic
  // thinking-block signatures are content/model integrity, NOT account-bound —
  // verified empirically 2026-07-02 (a `partnerships`-signed block replayed under
  // `personal` returned 200). ON by default: a heavy thinking session can now spread
  // its later load onto fresh accounts instead of stranding one. The revert-to-issuer
  // fail-safe (server.js, on `invalid_thinking_signature` for a migrated request)
  // makes this safe even if Anthropic ever account-binds signatures — a rejected
  // replay self-heals to the issuer instead of poisoning the session.
  crossAccountThinkingMigration: true,
  // Cross-PROVIDER fallback policy for 'cc all' (profile=all), i.e. whether a session
  // may be served by a provider FAMILY other than its home (Claude ↔ GLM ↔ Kimi).
  //   'never'         — strict pin: a Claude session uses Claude only; a GLM session
  //                     uses GLM only; a Kimi session uses Kimi only.
  //   'when-exhausted'— (default) home family preferred; a Claude session falls back
  //                     to GLM/Kimi only once all Claude accounts are unavailable
  //                     (providers are already lower-priority fallback), and a GLM
  //                     session may fall to Kimi once GLM is exhausted.
  //   'always'        — providers peer with Claude for a Claude/unknown session
  //                     (load-balanced, not last-resort).
  // INVARIANT (all policies): a GLM/Kimi-origin session NEVER routes to an Anthropic
  // account — Anthropic 400s on a non-`srvtoolu_` server_tool_use id; that direction
  // is unfixable, not policy-tunable.
  crossProviderFallbackPolicy: 'when-exhausted',
};
const LOAD_EVENT_MAX_AGE_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

// Quota fields that survive a restart: utilization levels and their reset
// windows, learned passively from upstream responses. Transient/derived state
// (probing, requalify, rateLimitedUntil) and credentials are intentionally
// excluded. A stale restored window is wiped on first use by _clearExpiredQuotas.
const PERSISTED_QUOTA_FIELDS = [
  'unified5h', 'unified7d', 'unified5hReset', 'unified7dReset', 'unifiedStatus', 'scopedWeekly',
  'tokensLimit', 'tokensRemaining', 'requestsLimit', 'requestsRemaining', 'resetsAt',
];

function clampRetryAfterSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.min(Math.max(Math.ceil(n), 1), 24 * 60 * 60);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function firstHeader(headers, names) {
  for (const name of names) {
    if (headers[name] != null) return headers[name];
  }
  return null;
}

function parseFirstInt(headers, names) {
  const value = firstHeader(headers, names);
  if (value == null) return null;
  const first = String(value).split(',')[0].trim();
  const n = parseInt(first, 10);
  return Number.isNaN(n) ? null : n;
}

function parseResetHeader(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const first = raw.split(',')[0].trim();
  const asNumber = Number(first);
  if (Number.isFinite(asNumber)) {
    // Most reset headers are epoch seconds or delay seconds. Treat small
    // values as delay seconds; large values as epoch seconds.
    return asNumber > 10_000_000_000
      ? asNumber
      : asNumber > 1_000_000_000
        ? asNumber * 1000
        : Date.now() + asNumber * 1000;
  }
  const asDate = Date.parse(raw);
  return Number.isNaN(asDate) ? null : asDate;
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.90, schedulerOptions = {}, dependencies = {}) {
    this.scheduler = { ...DEFAULT_SCHEDULER, ...schedulerOptions };
    this._refreshAccessToken = dependencies.refreshAccessToken || refreshAccessToken;
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      provider: acct.provider || (acct.type === 'provider' ? 'provider' : 'anthropic'),
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.authToken || acct.apiKey,
      upstream: acct.upstream || null,
      authHeader: acct.authHeader || null,
      profiles: acct.profiles || (acct.type === 'provider' ? ['all'] : ['claude', 'all']),
      priority: Number.isFinite(acct.priority) ? acct.priority : 0,
      model: acct.model || null,
      modelMap: acct.modelMap || null,
      stripBetaHeaders: Boolean(acct.stripBetaHeaders),
      runtime: Boolean(acct.runtime),
      enabled: acct.enabled !== false,
      refreshToken: acct.refreshToken || null,
      expiresAt: acct.expiresAt || null,
      status: 'active',
      // No quota is known at startup, so start probing: the first response for
      // an account reveals its weekly limit and triggers re-evaluation.
      probing: true,
      quota: emptyQuota(),
      usage: {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalRequests: 0,
        lastUsed: null,
      },
      inFlight: 0,
      activeWeight: 0,
      completedRequests: 0,
      failedRequests: 0,
      loadEvents: [],
      consecutiveFailures: 0,
      lastStatus: null,
      lastResponseMs: null,
      lastAcceptedAt: null,
      lastError: null,
      lastErrorAt: null,
      cooldownUntil: null,
      provisionalUpstreamFingerprint: null,
      provisionalUpstreamUntil: null,
      rateLimitedUntil: null,
      provisionalRateLimitFingerprint: null,
      recoveredAt: null,
      lastQuotaLogKey: null,
    }));
    this.currentIndex = 0;
    this.nextIndex = 0;
    this.switchThreshold = switchThreshold;
    this.routingMode = 'automatic';
    this.preferredAccountName = null;
    this.sessionBindings = new Map();
    this.sessionPolicies = new Map();
    this.upstreamThrottle = {
      until: null,
      reason: null,
      probeInFlight: false,
      count: 0,
      lastAt: null,
    };
    this.ambiguousRateLimits = new Map();
    this.queueState = {
      nextId: 1,
      waiting: [],
      lastAdmissionAt: 0,
      rampUntil: 0,
      bytes: 0, // aggregate buffered body bytes across all held requests
    };
    this.admissionPaused = false;
    // Single-writer baton: only the lease holder may rotate OAuth refresh tokens
    // (refresh tokens are single-use; two refreshers brick the account). A worker
    // booted headless during a reload starts WITHOUT the lease and refreshes
    // nothing until it acquires the baton. Default true so the standalone /
    // direct-listen (non-supervised, headless service) path is unchanged.
    this.writerLease = true;
  }

  /**
   * Acquire/release the single-writer baton. While released, ensureTokenFresh is
   * a no-op (the worker serves on its existing access tokens but never rotates a
   * single-use refresh token — that's the lease holder's job).
   */
  setWriterLease(held) {
    this.writerLease = Boolean(held);
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount(requestInfo = {}, excludedIndexes = new Set()) {
    this.refreshExpiredQuotas();
    return this._selectNext(requestInfo, excludedIndexes);
  }

  nextRetryForRequest(requestInfo = {}, excludedIndexes = new Set()) {
    this.refreshExpiredQuotas();
    const upstreamRetry = this._upstreamThrottleRetry();
    if (upstreamRetry && !this._hasAvailableProvider(requestInfo, excludedIndexes)) {
      return upstreamRetry;
    }

    const profile = requestInfo.profile || 'claude';
    let soonestTemporary = Infinity;
    let temporaryCause = null;
    let soonestWeekly = Infinity;
    let soonestBoundedHold = Infinity;    // recoverable-transient accounts (weekly-critical last-resort, or concurrency-capped): always a bounded re-poll (known short-term resets route through soonestTemporary instead)
    let boundedHoldCause = null;
    let weeklyUnknownReset = 0; // weekly-exhausted accounts whose reset time we don't know yet
    let matchingRoutes = 0;
    const reasons = {};

    const note = reason => {
      reasons[reason] = (reasons[reason] || 0) + 1;
    };

    for (const account of this.accounts) {
      if (excludedIndexes.has(account.index)) continue;
      const matches = this._matchesRequest(account, profile, requestInfo);

      // A signed-thinking request behind the TRANSIENT FIFO queue-fairness gate
      // (a queue already exists and this newcomer hasn't registered a ticket yet
      // — the `!requestInfo.queueTicket` clause in _matchesRequest) must still be
      // CONSIDERED for retry timing, not skipped. Such a request has NO fallback:
      // providers are barred (signed thinking), so dropping the account here — and
      // losing its REAL cooldown / rate-limit / 5h reset — collapses the oracle to
      // Infinity and KILLS the session. Two reproduced kills (2026-06-27): a queue
      // forms, then either (a) healthy accounts sit idle behind it, or (b) a
      // network blip has cooled EVERY account, and the thinking newcomer dies with
      // the false "all N are at their 5h or weekly limit". The gate lifts the
      // instant the request registers a ticket, so bypass it for retry timing here.
      // Still respected: admissionPaused (restart/shutdown shed → stays terminal),
      // upstream-throttle (handled by the early return above), and structural
      // profile / provider-thinking compatibility. Scoped to THINKING on purpose: a
      // non-thinking newcomer can fall back to a provider or be cheaply retried, so
      // the gate keeps shedding it as backpressure (never grow the queue past its
      // cap under a pure-concurrency burst).
      const fairnessOnlyBlock = !matches
        && this._requiresAnthropicThinkingIntegrity(requestInfo)
        && account.type !== 'provider'
        && this._isRequestCompatible(account, profile, requestInfo)
        && !this.admissionPaused
        && !this._isUpstreamThrottleBlocking()
        && this.queueState.waiting.length > 0
        && !requestInfo.queueTicket
        && !requestInfo.queueAdmitted;

      if (!matches && !fairnessOnlyBlock) {
        if (account.type === 'provider' && this._requiresAnthropicThinkingIntegrity(requestInfo)) {
          note('provider_fallback_disabled_signed_thinking');
        }
        continue;
      }

      matchingRoutes++;

      // NEVER claim available:0 for a fairness-gated account — _selectNext still
      // refuses it (the gate), so an available verdict would desync the oracle from
      // selection and spin the caller. A healthy gated account holds a bounded
      // re-poll (queued_behind_fairness); a transiently-blocked one (cooldown /
      // rate-limit / 5h cap) falls through so its REAL short-term reset drives a
      // finite hold. It must NEVER contribute the WEEKLY reset (days) — that is the
      // multi-day-hang the bounded path fences off; see the !fairnessOnlyBlock
      // guards on the weekly branches below.
      if (!fairnessOnlyBlock && this._isAvailable(account, { allowWeeklyReserve: true, model: requestInfo.model })) {
        return {
          available: true,
          retryAfterMs: 0,
          cause: 'available',
          reasons,
          matchingRoutes,
        };
      }
      if (fairnessOnlyBlock && this._isAvailable(account, { allowWeeklyReserve: true, allowWeeklyCritical: true, model: requestInfo.model })) {
        soonestBoundedHold = Math.min(soonestBoundedHold, BOUNDED_REPOLL_HOLD_MS);
        if (!boundedHoldCause) boundedHoldCause = 'queued_behind_fairness';
        continue;
      }

      const retry = this._retryInfo(account, requestInfo.model);
      note(retry.cause);
      if (!fairnessOnlyBlock && retry.weeklyCritical && this._isAvailable(account, { allowWeeklyReserve: true, allowWeeklyCritical: true, model: requestInfo.model })) {
        return {
          available: true,
          retryAfterMs: 0,
          cause: 'weekly_critical_last_resort',
          reasons,
          matchingRoutes,
        };
      }
      if (retry.queueable && retry.retryAt) {
        // A known, soon short-term reset (5h cap / rate-limit / cooldown) — even on
        // a weekly-critical account, this is the REAL near-term recovery time, so
        // it holds here with the true cause rather than the distant weekly reset.
        const ms = retry.retryAt - Date.now();
        if (ms < soonestTemporary) {
          soonestTemporary = ms;
          temporaryCause = retry.cause;
        }
      } else if (retry.weeklyCritical || retry.transientCap) {
        // A recoverable-transient block with no queueable short-term reset — a
        // weekly-critical account (last-resort usable) or an otherwise-healthy
        // account at its concurrency cap. _retryInfo always reaches here with
        // retryAt:null (a KNOWN short-term reset is queueable and routes through
        // soonestTemporary above), so the hold is a bounded re-poll. Recoverable by
        // definition — hold finite, never collapse to Infinity and KILL the session.
        soonestBoundedHold = Math.min(soonestBoundedHold, BOUNDED_REPOLL_HOLD_MS);
        // Label precedence: an account that is BOTH weekly-critical and short-term
        // capped is fundamentally weekly_critical; concurrency_cap only labels the
        // hold when no weekly-critical account contributed it.
        if (retry.weeklyCritical) boundedHoldCause = 'weekly_critical';
        else if (!boundedHoldCause) boundedHoldCause = 'concurrency_cap';
      } else if (!fairnessOnlyBlock && retry.cause === 'weekly_exhausted' && retry.retryAt) {
        // A fairness-gated account NEVER contributes the weekly reset: holding a
        // thinking session for days behind the queue is the over-correction we
        // avoid (a weekly-exhausted gated fleet stays terminal → honest error,
        // matching the no-newcomer-vs-queue distinction). Only its short-term reset
        // (above) or the bounded hold may fire.
        const ms = retry.retryAt - Date.now();
        if (ms < soonestWeekly) soonestWeekly = ms;
      } else if (!fairnessOnlyBlock && retry.cause === 'weekly_exhausted' && !retry.retryAt) {
        // Weekly-capped but we haven't learned the reset time (cold start /
        // probe failure). We cannot estimate a wait — flag it so the caller
        // emits an honest "reset time unknown" error instead of waiting forever.
        weeklyUnknownReset++;
      }
    }

    // Min-merge ALL THREE recovery buckets and emit the cause of the SOONEST one.
    // A weekly-critical account is last-resort usable and frees when its
    // short-term blocker clears (often ~minutes); a weekly-exhausted account is
    // unusable until its full 7d reset. Picking any one bucket ahead of the others
    // (the old temporary-then-weekly-then-critical order) could mask a sibling's
    // sooner recovery behind a far reset — error-fasting a holdable request and
    // emitting a misleading multi-day Retry-After.
    const recoveries = [
      { ms: soonestTemporary, cause: temporaryCause || 'temporary_unavailable' },
      { ms: soonestWeekly, cause: 'weekly_exhausted' },
      { ms: soonestBoundedHold, cause: boundedHoldCause || 'weekly_critical' },
    ].filter(r => Number.isFinite(r.ms));
    if (recoveries.length) {
      const best = recoveries.reduce((a, b) => (b.ms < a.ms ? b : a));
      return {
        available: false,
        retryAfterMs: Math.max(0, best.ms),
        cause: best.cause,
        reasons,
        matchingRoutes,
      };
    }

    if (weeklyUnknownReset > 0) {
      return {
        available: false,
        retryAfterMs: Infinity,
        cause: 'weekly_reset_unknown',
        reasons,
        matchingRoutes,
      };
    }

    return {
      available: false,
      retryAfterMs: Infinity,
      cause: matchingRoutes ? 'unavailable' : 'no_eligible_route',
      reasons,
      matchingRoutes,
    };
  }

  hasAvailableRoute(requestInfo = {}, excludedIndexes = new Set()) {
    this.refreshExpiredQuotas();
    const profile = requestInfo.profile || 'claude';
    // Route-EXISTENCE check only (order-independent `.some`): unlike the acquire
    // path's re-home loop, pass ORDER doesn't matter here — the bound 2-entry set
    // covers the same accounts (reserve+critical) — so it intentionally is NOT
    // unified to the healthy-first ladder. Do not "sync" these.
    const hasBinding = Boolean(requestInfo.sessionKey && this.sessionBindings.has(requestInfo.sessionKey));
    const weeklyPasses = hasBinding
      ? [
          { allowWeeklyReserve: true, allowWeeklyCritical: false },
          { allowWeeklyReserve: true, allowWeeklyCritical: true },
        ]
      : [
          { allowWeeklyReserve: false, allowWeeklyCritical: false },
          { allowWeeklyReserve: true, allowWeeklyCritical: false },
          { allowWeeklyReserve: true, allowWeeklyCritical: true },
        ];

    return weeklyPasses.some(options => this.accounts.some(account => {
      if (excludedIndexes.has(account.index)) return false;
      if (!this._matchesRequest(account, profile, requestInfo)) return false;
      return this._isAvailable(account, { ...options, model: requestInfo.model });
    }));
  }

  acquireAccount(requestInfo = {}, excludedIndexes = new Set()) {
    this._noteRequestPolicy(requestInfo);
    // Capture the session's prior account BEFORE selection, so the caller can tell
    // whether this acquire MOVED the session (the thinking-signature fail-safe needs
    // the pre-migration issuing account to revert to).
    const prevCurrentName = requestInfo.sessionKey
      ? this._sessionBinding(requestInfo.sessionKey)?.currentName
      : null;
    const account = this.getActiveAccount(requestInfo, excludedIndexes);
    if (!account) return null;

    const weight = Math.max(1, Number(requestInfo.weight) || 1);
    const upstreamThrottleProbe = account.type !== 'provider' && this._claimUpstreamThrottleProbe();
    if (requestInfo.sessionKey) {
      this._bindSession(requestInfo.sessionKey, account, requestInfo.model);
    }
    account.inFlight++;
    account.activeWeight += weight;
    account.lastUsedAt = Date.now();
    // Non-null only when this acquire moved the session off its prior account.
    const migratedFromName = (prevCurrentName && account.name !== prevCurrentName) ? prevCurrentName : null;
    return { account, weight, startedAt: Date.now(), upstreamThrottleProbe, migratedFromName };
  }

  /** Fail-safe: snap a session's binding back to the pre-migration issuing account
   *  after a rejected cross-account thinking replay, so the retry (and future
   *  requests) route to the account that actually generated the thinking blocks.
   *  Defensive — signatures are portable in practice (verified 2026-07-02); this
   *  only fires if Anthropic ever account-binds them. */
  revertSessionBinding(sessionKey, name) {
    if (!sessionKey || !name) return;
    const binding = this._sessionBinding(sessionKey);
    if (!binding) return;
    binding.currentName = name;
    this.sessionBindings.set(sessionKey, binding);
  }

  releaseAccount(lease, outcome = {}) {
    if (!lease?.account) return;
    const account = lease.account;

    account.inFlight = Math.max(0, account.inFlight - 1);
    account.activeWeight = Math.max(0, account.activeWeight - lease.weight);

    if (lease.upstreamThrottleProbe) {
      if (outcome.success) {
        this.clearUpstreamThrottle('successful recovery probe');
      } else if (!outcome.upstreamThrottled) {
        this.deferUpstreamThrottleProbe(5, outcome.error || `HTTP ${outcome.status || 'failure'}`);
      }
    }

    if (outcome.neutral) return;

    // A per-model weekly cap is NOT an account failure — the account is healthy for
    // every other model. Don't poison its failure counters / scoring penalty (mirror
    // the network-blip carve-out); the scoped bench is already set in markRateLimited.
    if (outcome.error === 'model_rate_limited') return;

    if (outcome.success) {
      account.completedRequests++;
      account.consecutiveFailures = 0;
      account.lastStatus = outcome.status || account.lastStatus;
      account.lastResponseMs = Date.now() - lease.startedAt;
      if (account.provisionalUpstreamFingerprint) {
        account.provisionalUpstreamUntil = null;
        account.provisionalUpstreamFingerprint = null;
      }
      if (account.status !== 'throttled' || account.lastError !== 'rate_limited') {
        account.lastError = null;
        account.lastErrorAt = null;
      }
      this._recordLoadEvent(account, lease, { ...outcome, success: true });
      account.lastSuccessAt = Date.now();
      return;
    }

    if (outcome.error || outcome.status) {
      account.failedRequests++;
      account.consecutiveFailures++;
      account.lastStatus = outcome.status || account.lastStatus;
      account.lastResponseMs = Date.now() - lease.startedAt;
      this._recordLoadEvent(account, lease, outcome);
      account.lastError = outcome.error || `HTTP ${outcome.status}`;
      account.lastErrorAt = Date.now();
    }
  }

  _recordLoadEvent(account, lease, outcome = {}) {
    const now = Date.now();
    account.loadEvents ||= [];
    account.loadEvents.push({
      at: now,
      durationMs: Math.max(0, now - lease.startedAt),
      weight: Math.max(1, lease.weight || 1),
      success: Boolean(outcome.success),
      status: outcome.status || null,
    });
    this._pruneLoadEvents(account, now);
  }

  _pruneLoadEvents(account, now = Date.now()) {
    if (!account.loadEvents?.length) return;
    const cutoff = now - LOAD_EVENT_MAX_AGE_MS;
    while (account.loadEvents.length && account.loadEvents[0].at < cutoff) {
      account.loadEvents.shift();
    }
  }

  _loadSummary(account, windowMs, now = Date.now()) {
    this._pruneLoadEvents(account, now);
    const since = now - windowMs;
    const events = (account.loadEvents || []).filter(e => e.at >= since);
    const requests = events.length;
    const failed = events.filter(e => !e.success).length;
    const weight = events.reduce((sum, e) => sum + (e.weight || 1), 0);
    const durationMs = events.reduce((sum, e) => sum + (e.durationMs || 0), 0);
    return {
      requests,
      failed,
      weight,
      avgMs: requests ? Math.round(durationMs / requests) : null,
    };
  }

  // True (with the scoped reset) when THIS request's model family has hit its
  // per-model weekly sub-limit on this account — a block SEPARATE from the unified
  // weekly (Fable can be 100% while unified is 56%). A model-agnostic request (no
  // family) or an account with no scoped data fails OPEN (returns null), matching
  // prior behavior. Gate: is_active AND (severity critical OR util ≥ exhausted).
  _scopedExhausted(account, model) {
    const fam = modelFamily(model);
    if (!fam) return null;
    const e = account.quota?.scopedWeekly?.[fam];
    if (!e || e.isActive === false) return null;
    // Bench ONLY at genuine exhaustion (>= weeklyExhaustedThreshold). Anthropic
    // labels a scoped weekly `severity:'critical'` well before it's actually
    // capped (~90%), where the model still has headroom and is still served — a
    // hard bench there strands the remainder and mislabels the account "maxed".
    // A real scoped 429 writes utilization:1 (markRateLimited), so genuine
    // exhaustion is still caught by the threshold. Same predicate drives the TUI
    // `maxed` tag, so "maxed" renders iff the model is actually benched.
    const exhausted = e.utilization != null && e.utilization >= this.scheduler.weeklyExhaustedThreshold;
    return exhausted ? { resetAt: e.resetAt || null, family: fam } : null;
  }

  _isAvailable(account, options = {}) {
    if (!account) return false;
    if (!account.enabled) return false;
    const now = Date.now();

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (now < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.recoveredAt = now;
      if (account.lastError === 'rate_limited') {
        account.lastError = null;
        account.lastErrorAt = null;
        account.provisionalRateLimitFingerprint = null;
      }
      console.log(`[Maxpool] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.cooldownUntil) {
      if (now < account.cooldownUntil) return false;
      account.cooldownUntil = null;
      account.recoveredAt = now;
    }

    if (account.provisionalUpstreamUntil) {
      if (now < account.provisionalUpstreamUntil) return false;
      account.provisionalUpstreamUntil = null;
      account.provisionalUpstreamFingerprint = null;
      account.recoveredAt = now;
      if (account.lastError === 'upstream_throttled') {
        account.lastError = null;
        account.lastErrorAt = null;
      }
    }

    if (account.inFlight >= this.scheduler.safetyMaxActivePerAccount) return false;
    if (this.getGlobalInFlight() >= this.scheduler.safetyMaxGlobalActive) return false;
    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isSessionQuotaUnavailable(account)) return false;
    // Gate on RAW weekly usage, not pace-adjusted: an account with real
    // headroom (e.g. 69% used, resets in days) must stay in the healthy-spread
    // pool even if it's burning fast. Pace is a soft SCORE cost, never a bench.
    const weeklyState = this._weeklyRawState(account);
    if (weeklyState === 'exhausted') return false;
    if (weeklyState === 'critical' && !options.allowWeeklyCritical) return false;
    if (weeklyState === 'reserve' && !options.allowWeeklyReserve) return false;

    // Per-model weekly cap for THIS request's model — unavailable for this request
    // (but the account still serves its other models). options.model is threaded in
    // by request-path callers; model-agnostic call sites skip this gate.
    if (options.model && this._scopedExhausted(account, options.model)) return false;

    return true;
  }

  getGlobalInFlight() {
    return this.accounts.reduce((sum, account) => sum + account.inFlight, 0);
  }

  setAdmissionPaused(paused) {
    this.admissionPaused = Boolean(paused);
  }

  markUpstreamThrottled(retryAfterSeconds, reason = 'temporary_server_limit') {
    const retryAfter = clampRetryAfterSeconds(retryAfterSeconds);
    const until = Date.now() + retryAfter * 1000;
    this.upstreamThrottle.until = Math.max(this.upstreamThrottle.until || 0, until);
    this.upstreamThrottle.reason = reason;
    this.upstreamThrottle.probeInFlight = false;
    this.upstreamThrottle.count++;
    this.upstreamThrottle.lastAt = Date.now();
    console.log(`[Maxpool] Anthropic upstream temporarily limiting requests for ${retryAfter}s; pausing Claude routes`);
  }

  clearUpstreamThrottle(reason = 'recovered') {
    if (!this.upstreamThrottle.until && !this.upstreamThrottle.probeInFlight) return;
    this.upstreamThrottle.until = null;
    this.upstreamThrottle.reason = null;
    this.upstreamThrottle.probeInFlight = false;
    this.queueState.rampUntil = Date.now() + 5000;
    this.queueState.lastAdmissionAt = Date.now();
    console.log(`[Maxpool] Anthropic upstream throttle cleared (${reason})`);
  }

  confirmUpstreamProbe(lease) {
    if (!lease?.upstreamThrottleProbe) return;
    this.clearUpstreamThrottle('Anthropic accepted recovery probe');
    lease.upstreamThrottleProbe = false;
  }

  deferUpstreamThrottleProbe(retryAfterSeconds = 5, reason = 'probe_failed') {
    if (!this.upstreamThrottle.until && !this.upstreamThrottle.probeInFlight) return;
    const retryAfter = clampRetryAfterSeconds(retryAfterSeconds);
    this.upstreamThrottle.until = Date.now() + retryAfter * 1000;
    this.upstreamThrottle.reason = reason;
    this.upstreamThrottle.probeInFlight = false;
    this.upstreamThrottle.lastAt = Date.now();
    console.log(`[Maxpool] Anthropic recovery probe failed; retrying in ${retryAfter}s (${reason})`);
  }

  noteAmbiguousRateLimit(accountIndex, fingerprint, _retryAfterSeconds) {
    if (!fingerprint) return false;
    const now = Date.now();
    const windowMs = 30_000;
    for (const [key, incident] of this.ambiguousRateLimits) {
      if (now - incident.lastAt > windowMs) this.ambiguousRateLimits.delete(key);
    }

    const incident = this.ambiguousRateLimits.get(fingerprint) || {
      accounts: new Set(),
      firstAt: now,
      lastAt: now,
    };
    incident.accounts.add(accountIndex);
    incident.lastAt = now;
    this.ambiguousRateLimits.set(fingerprint, incident);
    if (incident.accounts.size < 2) return false;

    for (const index of incident.accounts) {
      const account = this.accounts[index];
      if (
        !account
        || account.lastError !== 'rate_limited'
        || account.provisionalRateLimitFingerprint !== fingerprint
      ) continue;
      account.status = 'active';
      account.rateLimitedUntil = null;
      account.lastError = null;
      account.lastErrorAt = null;
      account.provisionalRateLimitFingerprint = null;
    }
    this.ambiguousRateLimits.delete(fingerprint);
    return true;
  }

  _isUpstreamThrottleBlocking() {
    const throttle = this.upstreamThrottle;
    if (!throttle.until) return false;
    if (Date.now() < throttle.until) return true;
    return throttle.probeInFlight;
  }

  _claimUpstreamThrottleProbe() {
    const throttle = this.upstreamThrottle;
    if (!throttle.until || Date.now() < throttle.until || throttle.probeInFlight) return false;
    throttle.probeInFlight = true;
    console.log('[Maxpool] Anthropic upstream throttle window expired; sending one recovery probe');
    return true;
  }

  _upstreamThrottleRetry() {
    const throttle = this.upstreamThrottle;
    if (!throttle.until) return null;
    const now = Date.now();
    if (now < throttle.until) {
      return {
        available: false,
        retryAfterMs: throttle.until - now,
        cause: 'upstream_throttle',
        reasons: { upstream_throttle: 1 },
        matchingRoutes: this.accounts.filter(a => a.type !== 'provider').length,
      };
    }
    if (throttle.probeInFlight) {
      return {
        available: false,
        retryAfterMs: 1000,
        cause: 'upstream_probe',
        reasons: { upstream_probe: 1 },
        matchingRoutes: this.accounts.filter(a => a.type !== 'provider').length,
      };
    }
    return null;
  }

  _hasAvailableProvider(requestInfo = {}, excludedIndexes = new Set()) {
    const profile = requestInfo.profile || 'claude';
    return this.accounts.some(account => {
      if (account.type !== 'provider' || excludedIndexes.has(account.index)) return false;
      if (!this._matchesRequest(account, profile, requestInfo)) return false;
      return this._isAvailable(account, { allowWeeklyReserve: true, allowWeeklyCritical: true });
    });
  }

  // Drop wedged head tickets (deadline passed or explicitly marked dead) so a
  // single orphaned waiter cannot block every other request behind it. Cheap;
  // safe to call before every head check.
  _reapStaleQueueHead() {
    const q = this.queueState;
    const now = Date.now();
    let guard = 0;
    while (q.waiting.length && guard++ < 10_000) {
      const head = q.waiting[0];
      const stale = head.dead === true || (head.deadlineAt && now > head.deadlineAt);
      if (!stale) break;
      q.waiting.shift();
      q.bytes = Math.max(0, q.bytes - (head.bytes || 0));
    }
  }

  // Register a waiter. Returns the ticket, or null if a backpressure limit
  // (maxConcurrentQueued / maxQueuedBytes) would be exceeded — the caller then
  // rejects the request with a "queue full" error instead of holding it.
  // Evict any waiting ticket(s) for a session key, releasing their slot + bytes.
  // A client timeout-retry opens a fresh request for the same session; this lets
  // the retry SUPERSEDE its own ghost instead of leaving a dead ticket occupying
  // a queue slot for up to the hold ceiling (the steady-state ghost-leak DoS).
  _evictQueuedSession(sessionKey) {
    if (!sessionKey) return;
    const q = this.queueState;
    for (let i = q.waiting.length - 1; i >= 0; i--) {
      const t = q.waiting[i];
      if (t.sessionKey !== sessionKey) continue;
      // Only supersede a GHOST — a prior hold whose client connection is already
      // gone (a timeout-retry of the SAME logical request). NEVER evict a LIVE
      // concurrent sibling: a single Claude Code process fires concurrent
      // requests under ONE session id (the main stream + the haiku title/summary
      // call + parallel subagents), and evicting a live one orphans it for days.
      // Catch a half-dead EPIPE ghost too: after a client RST the ServerResponse
      // may not have flipped destroyed/writableEnded yet (it's noticed on the next
      // write), but its underlying socket is already destroyed. A LIVE sibling has a
      // live socket (socket.destroyed===false), so this never evicts one. (Mock-live
      // res objects leave socket undefined → not dead.) Uses socket.destroyed only —
      // a stable terminal signal — not the transient res.writable.
      const dead = !t.res || t.res.destroyed || t.res.writableEnded
        || t.res.socket?.destroyed === true;
      if (!dead) continue;
      if (t.requestInfo) t.requestInfo.queueTicket = null; // let its waiter exit fast
      t.dead = true;
      q.bytes = Math.max(0, q.bytes - (t.bytes || 0));
      q.waiting.splice(i, 1);
    }
  }

  registerQueuedRequest(requestInfo = {}, opts = {}) {
    if (requestInfo.queueTicket) return requestInfo.queueTicket;
    this._reapStaleQueueHead();
    const sessionKey = opts.sessionKey || requestInfo.sessionKey || null;
    this._evictQueuedSession(sessionKey); // a retry supersedes its own DEAD prior hold
    const bytes = Math.max(0, Number(opts.bytes) || 0);
    const { maxConcurrentQueued, maxQueuedBytes } = opts;
    if (maxConcurrentQueued != null && this.queueState.waiting.length >= maxConcurrentQueued) return null;
    if (maxQueuedBytes != null && this.queueState.waiting.length > 0
      && this.queueState.bytes + bytes > maxQueuedBytes) return null;
    const ticket = {
      id: this.queueState.nextId++,
      queuedAt: Date.now(),
      bytes,
      deadlineAt: opts.deadlineAt || null,
      sessionKey,
      res: opts.res || null,
      requestInfo,
    };
    this.queueState.waiting.push(ticket);
    this.queueState.bytes += bytes;
    requestInfo.queueTicket = ticket;
    // Re-queuing CONSUMES any prior admission: a request that was admitted
    // (ticket cleared, queueAdmitted=true) but then failed to acquire the freed
    // slot (lost the race) must re-enter the FIFO as a fair waiter, NOT keep
    // bypassing the fairness gate forever and starve everyone behind it.
    requestInfo.queueAdmitted = false;
    return ticket;
  }

  canAdmitQueuedRequest(requestInfo = {}) {
    const ticket = requestInfo.queueTicket;
    if (!ticket) return true;
    this._reapStaleQueueHead();
    if (this.queueState.waiting[0]?.id !== ticket.id) return false;
    const now = Date.now();
    if (now < this.queueState.rampUntil && now - this.queueState.lastAdmissionAt < 250) return false;
    this.queueState.waiting.shift();
    this.queueState.bytes = Math.max(0, this.queueState.bytes - (ticket.bytes || 0));
    this.queueState.lastAdmissionAt = now;
    requestInfo.queueTicket = null;
    requestInfo.queueAdmitted = true;
    return true;
  }

  removeQueuedRequest(requestInfo = {}) {
    const ticket = requestInfo.queueTicket;
    if (!ticket) return;
    const index = this.queueState.waiting.findIndex(entry => entry.id === ticket.id);
    if (index >= 0) {
      this.queueState.waiting.splice(index, 1);
      this.queueState.bytes = Math.max(0, this.queueState.bytes - (ticket.bytes || 0));
    }
    requestInfo.queueTicket = null;
  }

  /**
   * Clear any quota counters whose reset time has passed. Cheap and safe to
   * call frequently (e.g. from the TUI render loop) — once a counter is cleared
   * it stays null until the next upstream response repopulates it, so the
   * "reset" log fires at most once per window.
   * @returns {{changed: boolean, session: boolean}} what was cleared.
   */
  _clearExpiredQuotas(account) {
    const q = account.quota;
    const now = Date.now();
    let changed = false;
    let session = false;

    // Clear expired unified quotas
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[Maxpool] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[Maxpool] Account "${account.name}" weekly quota reset`);
      q.unified7d = null;
      q.unified7dReset = null;
      q.unifiedStatus = null;
      changed = true;
    }

    // Expire per-model weekly sub-limits on their own reset (a family whose scoped
    // window has passed is usable again for that model, independent of unified).
    if (q.scopedWeekly && typeof q.scopedWeekly === 'object') {
      for (const [fam, e] of Object.entries(q.scopedWeekly)) {
        if (e && e.resetAt && now >= e.resetAt) {
          console.log(`[Maxpool] Account "${account.name}" ${fam} weekly sub-limit reset`);
          delete q.scopedWeekly[fam];
          changed = true;
        }
      }
    }

    // Clear expired standard quotas
    if (q.resetsAt && now >= new Date(q.resetsAt).getTime()) {
      q.tokensRemaining = null;
      q.tokensLimit = null;
      q.requestsRemaining = null;
      q.requestsLimit = null;
      q.resetsAt = null;
      changed = true;
    }

    return { changed, session };
  }

  /**
   * Clear expired quotas across all accounts. Called from the display loop and
   * the request path so a window expiry (e.g. the 5-hour session quota) resets
   * the view instantly rather than waiting for the next request.
   *
   * When an account's session quota resets, it may have become the better
   * choice — switch to it if its weekly limit expires sooner than the current
   * account's (and it still has weekly quota), so we spend the quota closest to
   * refreshing first.
   */
  refreshExpiredQuotas() {
    let changed = false;
    const now = Date.now();
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
      this._clearRecoveredNetworkError(account, now);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
  }

  /**
   * Clear a fully-healed transient error so a long-gone blip stops showing as a
   * phantom "Err" in the TUI. A network blip (markTransientFailure network:true)
   * and an expired upstream_throttled window both set `lastError` WITHOUT bumping
   * `consecutiveFailures`; once the account is active again with no live backoff
   * window, that error is history. Runs for EVERY account on the display/request
   * refresh — required (not just `_isAvailable`, which never evaluates an idle
   * fallback provider that Claude-health keeps out of the candidate set, so its
   * blip lingered ~100 min until restart). Mirrors the rate_limited /
   * upstream_throttled recovery clears in `_isAvailable`.
   *
   * The `consecutiveFailures > 0` guard is load-bearing: a genuinely-flaky account
   * (markResult failure — windowless, status active, counter bumped) must KEEP its
   * error visible. Only the fleet-wide-blip paths leave the counter at 0.
   */
  _clearRecoveredNetworkError(account, now = Date.now()) {
    if (!account.lastError) return;
    if (account.status !== 'active') return;         // throttled / error / exhausted keep their error
    if (account.consecutiveFailures > 0) return;     // an ongoing per-account fault stays visible
    const blocked = Math.max(
      account.cooldownUntil || 0,
      account.rateLimitedUntil || 0,
      account.provisionalUpstreamUntil || 0,
    );
    if (blocked && now < blocked) return;            // still in a backoff window → keep showing why
    account.lastError = null;
    account.lastErrorAt = null;
    // Mirror _isAvailable's recovery: drop the now-past backoff windows + fingerprint
    // so getStatus() doesn't emit a stale past cooldown and no fingerprint dangles.
    account.cooldownUntil = null;
    account.provisionalUpstreamUntil = null;
    account.provisionalUpstreamFingerprint = null;
  }

  /**
   * Given accounts whose session quota just reset, switch to the one whose
   * weekly limit expires soonest — but only if that is sooner than the current
   * account's weekly limit and the account still has weekly quota to spend.
   */
  _switchOnSessionReset(candidates) {
    const current = this.accounts[this.currentIndex];
    // Need a known weekly reset on the current account to compare against;
    // if it is unknown we are still probing it, so leave it alone.
    if (!current || current.quota.unified7dReset == null) return;

    let best = null;
    let bestWeekly = current.quota.unified7dReset;
    for (const acc of candidates) {
      if (acc.index === this.currentIndex) continue;
      if (!this._isAvailable(acc, { allowWeeklyReserve: true })) continue; // enough session & weekly quota left
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      console.log(`[Maxpool] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  _isSessionQuotaUnavailable(account) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Unified 5h quota is immediate availability. Weekly quota is handled
    // separately as long-horizon admission control.
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;

    // Standard quotas (API key accounts)
    if (q.tokensLimit != null && q.tokensRemaining != null) {
      const used = 1 - (q.tokensRemaining / q.tokensLimit);
      if (used >= this.switchThreshold) return true;
    }

    if (q.requestsLimit != null && q.requestsRemaining != null) {
      const used = 1 - (q.requestsRemaining / q.requestsLimit);
      if (used >= this.switchThreshold) return true;
    }

    return false;
  }

  _isNearQuota(account) {
    // RAW weekly state (not pace): a raw-healthy account with real headroom is
    // never treated as near-quota just because it's burning fast. Pace stays a
    // soft cost in _scoreAccount only.
    return this._isSessionQuotaUnavailable(account)
      || ['reserve', 'critical', 'exhausted'].includes(this._weeklyRawState(account));
  }

  // ── Session rebalancing (issue #1) ────────────────────────────────────────
  // A bound session normally sticks to its account (continuity + Anthropic signed-
  // thinking signature validity). These let it migrate OFF a hot account onto fresh
  // capacity, but only when it's provably safe and clearly worth it.

  /** Per-request safety gate: a request is safe to migrate to a DIFFERENT account
   *  iff its body carries NO signed thinking (replaying a signed thinking block to
   *  another account → non-retryable "invalid signature"). Uses the PER-REQUEST
   *  body signal only — never the session-sticky policy — and fails CLOSED on any
   *  body we couldn't fully scan (non-JSON / parse error → bodyThinkingScanned unset). */
  _migrationSafeForRequest(requestInfo = {}) {
    // Fail closed on any body we couldn't fully scan (non-JSON / parse error).
    if (requestInfo.bodyThinkingScanned !== true) return false;
    // An Anthropic-incompatible (provider-pinned) session's only possible cross is
    // GLM↔Kimi, whose mismatched thinking formats risk a reasoning-loop — keep it on
    // its bound provider rather than rebalancing.
    if (this._effectiveIncompatible(requestInfo).incompatible) return false;
    // A signed-thinking request is migration-safe when cross-account thinking
    // migration is enabled: the signature is content/model integrity, not account-
    // bound. The rebalance candidate loop (_shouldRebalanceBoundSession) additionally
    // skips PROVIDER targets for a signed-thinking request, so every migration target
    // stays a Claude account (a signed block isn't shuttled to a provider mid-session).
    // When the flag is off, keep the conservative bar (never migrate signed thinking).
    if (requestInfo.requiresAnthropicThinkingIntegrity === true) {
      return this.scheduler.crossAccountThinkingMigration === true;
    }
    return true;
  }

  /** Flap-stable "hot": burn-PACE reserve/critical/exhausted, or immediate session-
   *  quota pressure (5h cap or an API-key token/request limit via
   *  `_isSessionQuotaUnavailable`).
   *  Pace (not raw level) is the right trigger — it spreads a long/heavy session's
   *  later load onto fresh capacity BEFORE it exhausts one account, while a light or
   *  near-reset session (whose pace stays normal) never triggers → no churn. Does
   *  NOT flip the instant a request migrates (unlike live in-flight, left to the
   *  score loop), so a healthy bound account never ping-pongs. */
  _isBoundAccountHot(account) {
    return this._isSessionQuotaUnavailable(account)
      || ['reserve', 'critical', 'exhausted'].includes(this._weeklyPaceState(account));
  }

  /** Decide whether a bound session should leave its (hot) account THIS request.
   *  All gates must hold: thinking-safe + not mid queue-admission + bound is hot +
   *  a genuinely-healthy alternative that is BOTH much cheaper AND a strictly
   *  healthier weekly tier (so concurrency jitter alone can never trigger a move). */
  _shouldRebalanceBoundSession(bound, profile, excludedIndexes, requestInfo, scoringCtx) {
    if (!this._migrationSafeForRequest(requestInfo)) return false;
    if (requestInfo.queueTicket || requestInfo.queueAdmitted) return false;
    if (!this._isBoundAccountHot(bound)) return false;

    const boundScore = this._scoreAccount(bound, requestInfo, scoringCtx);
    // Tier guard on the SAME axis as the trigger (pace, not raw). If the trigger is
    // pace but the tier guard is raw, a pace-hot fast-burner whose RAW tier is still
    // `normal` can never find a strictly-healthier raw tier → migration never fires
    // for the exact account this is meant to relieve. Match the axes.
    const boundTier = WEEKLY_TIER[this._weeklyPaceState(bound)] ?? 0;

    let bestScore = Infinity;
    let bestTier = Infinity;
    for (const account of this.accounts) {
      if (account.index === bound.index) continue;
      if (excludedIndexes.has(account.index)) continue;
      // Keep a signed-thinking session's live migration on Claude accounts only —
      // don't shuttle an Anthropic-signed block onto a provider mid-session even
      // though _isRequestCompatible now allows providers for thinking under policy.
      // LOAD-BEARING for the absolute-near-cap `return true` below: it's what
      // guarantees that path only fires with a CLAUDE target present (a signed
      // session with no healthy Claude alt → bestScore stays Infinity → return
      // false → stays on its Claude account, never re-homed to a provider). Do not
      // remove assuming the fall-through protects signed thinking — it does not.
      if (requestInfo.requiresAnthropicThinkingIntegrity === true && account.type === 'provider') continue;
      if (!this._matchesRequest(account, profile, requestInfo)) continue;
      // Genuinely-healthy alternatives only (normal/soft/unknown weekly + model headroom).
      if (!this._isAvailable(account, { allowWeeklyReserve: false, allowWeeklyCritical: false, model: requestInfo.model })) continue;
      const score = this._scoreAccount(account, requestInfo, scoringCtx);
      if (score < bestScore) {
        bestScore = score;
        bestTier = WEEKLY_TIER[this._weeklyPaceState(account)] ?? 0;
      }
    }
    if (!Number.isFinite(bestScore)) return false; // no RAW-healthy alternative → don't move (no stranding)

    // Absolute near-cap: the bound account is genuinely low on weekly headroom
    // (RAW reserve+, not merely burning fast). Every candidate the loop kept is RAW
    // normal/soft, so this is a STRICT absolute-headroom improvement and flap-stable
    // (a reserve account can never be a target → no bounce-back). Skip the
    // concurrency-relief margin: it's calibrated for moving off a LOADED account and
    // is UNSATISFIABLE for an idle near-cap one — an idle boundScore ≈ the ~2
    // concurrency floor, so boundScore*0.5 ≈ 1 sits below every account's minimum
    // score, pinning the session to the near-exhausted account. Preserving the thin
    // remaining weekly headroom dominates concurrency spread; the per-request
    // candidate loop lands on the least-loaded healthy account, spreading the move.
    if ((WEEKLY_TIER[this._weeklyRawState(bound)] ?? 0) >= WEEKLY_TIER.reserve) return true;

    // Otherwise the trigger was PACE-only on a RAW-healthy account — a fast-burner
    // that still has real absolute headroom (RAW soft but pace reserve/critical,
    // e.g. 79% used resetting in ~3.5d). Keep the conservative gate so it isn't
    // churned off an account that's genuinely fine: move only for a clearly-cheaper,
    // strictly-healthier-pace-tier target. (A RAW-soft/pace-normal fast-burner with
    // lots of headroom never even reaches here — _isBoundAccountHot gates it out.)
    return bestScore <= boundScore * REBALANCE_SCORE_MARGIN
      && (boundScore - bestScore) >= REBALANCE_MIN_ABS_GAP
      && bestTier < boundTier;
  }

  _retryInfo(account, model = null) {
    const now = Date.now();
    const q = account.quota || {};

    // TERMINAL (non-recoverable) states FIRST — before any weekly/short-term
    // bucket. An auth-dead / disabled / exhausted-status account is NOT
    // recoverable-by-definition: it must error-fast (retryAt:null, no weeklyCritical
    // tag → Infinity → 429), and a stale critical/exhausted QUOTA reading must never
    // shadow that into a finite hold that spins the session for up to 7 days.
    if (!account.enabled) return { cause: 'disabled', retryAt: null, queueable: false };
    if (account.status === 'error') return { cause: 'error', retryAt: null, queueable: false };
    if (account.status === 'exhausted') return { cause: 'exhausted', retryAt: null, queueable: false };

    // Per-model weekly cap for THIS request's model: a hard block until the scoped
    // weekly reset (days), exactly like weekly_exhausted but scoped to one model —
    // reuse that cause so the oracle's weekly-reset branches hold on the scoped
    // reset consistently (agreeing with _isAvailable's model gate above; the oracle
    // still returns available:true off any SIBLING account with model headroom).
    const scoped = model ? this._scopedExhausted(account, model) : null;
    if (scoped) return { cause: 'weekly_exhausted', retryAt: scoped.resetAt, queueable: false, modelScoped: true };

    // RAW weekly state, so the retry oracle agrees with _isAvailable's raw gate.
    // (Pace must NOT classify a raw-healthy account as weekly_critical here, or
    // the queue keys on a far-future reset instead of the account's real
    // short-term availability — the session-kill bug.)
    const weeklyState = this._weeklyRawState(account);

    // Short-term blockers (rate-limit / cooldown / upstream / 5h session cap /
    // token-request-provider limits) clear on their OWN schedule — usually FAR
    // sooner than a 7d weekly reset. Compute them up front so a weekly-critical
    // account reports its REAL near-term recovery, not the distant weekly reset.
    const shortTerm = this._shortTermRetry(account, now, q);

    if (weeklyState === 'exhausted') {
      // Hard block: only a weekly reset unblocks it — a sooner short-term clear
      // does not help — so key the hold on the weekly reset.
      return { cause: 'weekly_exhausted', retryAt: q.unified7dReset || null, queueable: false };
    }

    if (weeklyState === 'critical') {
      // Last-resort USABLE: the account becomes selectable (as last resort) the
      // moment its short-term blocker clears — NOT at the far weekly reset. So
      // report the SOONER real blocker (the 5h cap / rate-limit), not unified7dReset.
      // Tag weeklyCritical so the oracle ALWAYS holds (finite) on it: a critical
      // account is recoverable by definition and must never collapse to an
      // Infinity session-kill, even when no reset time is known.
      if (shortTerm) return { ...shortTerm, weeklyCritical: true };
      // No short-term blocker → the only thing keeping it out of the last-resort
      // pool is a TRANSIENT cap (in-flight/concurrency, admission pause), which
      // clears in seconds when a sibling completes — NOT the 7d weekly reset. Hold
      // a bounded re-poll (retryAt:null → BOUNDED_REPOLL_HOLD_MS), never the far
      // weekly reset, so a non-stream request isn't error-fasted for ~7d.
      return { cause: 'weekly_critical', retryAt: null, queueable: false, weeklyCritical: true };
    }

    // Healthy / soft / reserve weekly: the ordinary short-term blocker, if any.
    if (shortTerm) return shortTerm;

    // Otherwise-healthy but at the in-flight / global concurrency cap — a TRANSIENT,
    // self-clearing block (a sibling completing frees a slot in seconds). HOLD a
    // bounded re-poll rather than error-fasting (Infinity): the symmetric case to a
    // concurrency-capped weekly-critical account, which already holds finite above.
    if (account.inFlight >= this.scheduler.safetyMaxActivePerAccount
        || this.getGlobalInFlight() >= this.scheduler.safetyMaxGlobalActive) {
      return { cause: 'concurrency_cap', retryAt: null, queueable: false, transientCap: true };
    }

    return { cause: 'unavailable', retryAt: null, queueable: false };
  }

  // The soonest active short-term (non-weekly) blocker for an account, or null if
  // none is active. Ordered most-specific-first; each entry is a {cause, retryAt,
  // queueable} the retry oracle can hold on. Kept separate from the weekly state
  // so weekly-critical accounts surface their real near-term recovery time.
  _shortTermRetry(account, now, q) {
    if (account.status === 'throttled' && account.rateLimitedUntil && now < account.rateLimitedUntil) {
      return { cause: 'rate_limited', retryAt: account.rateLimitedUntil, queueable: true };
    }

    if (account.cooldownUntil && now < account.cooldownUntil) {
      return { cause: 'cooldown', retryAt: account.cooldownUntil, queueable: true };
    }

    if (account.provisionalUpstreamUntil && now < account.provisionalUpstreamUntil) {
      return { cause: 'upstream_failure', retryAt: account.provisionalUpstreamUntil, queueable: true };
    }

    if (q.unified5h != null && q.unified5h >= this.switchThreshold) {
      return { cause: 'session_limit', retryAt: q.unified5hReset || null, queueable: Boolean(q.unified5hReset) };
    }

    if (q.tokensLimit != null && q.tokensRemaining != null && q.tokensLimit > 0) {
      const used = 1 - q.tokensRemaining / q.tokensLimit;
      if (used >= this.switchThreshold) {
        const retryAt = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
        return { cause: 'token_limit', retryAt, queueable: Boolean(retryAt) };
      }
    }

    if (q.requestsLimit != null && q.requestsRemaining != null && q.requestsLimit > 0) {
      const used = 1 - q.requestsRemaining / q.requestsLimit;
      if (used >= this.switchThreshold) {
        const retryAt = q.resetsAt ? new Date(q.resetsAt).getTime() : null;
        return { cause: 'request_limit', retryAt, queueable: Boolean(retryAt) };
      }
    }

    if (q.genericLimit != null && q.genericRemaining != null && q.genericRemaining <= 0) {
      return { cause: 'provider_limit', retryAt: q.genericReset || null, queueable: Boolean(q.genericReset) };
    }

    return null;
  }

  _selectNext(requestInfo = {}, excludedIndexes = new Set()) {
    // Adaptive least-loaded balancing: spread requests across every healthy
    // account immediately, and let live load, quota pressure, and recent errors
    // push traffic away from weaker accounts.
    let best = null;
    let bestScore = Infinity;
    let bestPriority = Infinity;
    const profile = requestInfo.profile || 'claude';
    const scoringCtx = this._scoringContext();

    // Fail-safe retry pin: steer this request's remaining retry/queue chain onto a
    // specific account (the pre-migration issuer, after a cross-account thinking
    // replay was rejected). Honored ahead of everything else, but FALLS THROUGH to
    // normal selection whenever that account is excluded/unavailable — a down issuer
    // never strands the request (the retry then re-migrates and terminates via
    // excludedIndexes + maxAttempts). See the thinking-signature fail-safe in server.js.
    if (requestInfo.pinnedAccountName) {
      const pinned = this.accounts.find(a => a.name === requestInfo.pinnedAccountName);
      if (pinned && !excludedIndexes.has(pinned.index)
        && this._matchesRequest(pinned, profile, requestInfo)
        && this._isAvailable(pinned, { allowWeeklyReserve: true, allowWeeklyCritical: true, model: requestInfo.model })) {
        this.currentIndex = pinned.index;
        return pinned;
      }
    }

    const preferred = this._preferredAccount(profile, excludedIndexes, requestInfo);
    if (preferred) {
      const preferredPasses = [
        { allowWeeklyReserve: true, allowWeeklyCritical: false },
        { allowWeeklyReserve: true, allowWeeklyCritical: true },
      ];
      if (preferredPasses.some(options => this._isAvailable(preferred, { ...options, model: requestInfo.model }))) {
        this.currentIndex = preferred.index;
        return preferred;
      }
    }
    const bound = this._boundAccount(requestInfo.sessionKey, profile, excludedIndexes, requestInfo);
    if (bound
      && !this._hasHigherPriorityAvailable(bound, profile, excludedIndexes, requestInfo)
      && !this._shouldRebalanceBoundSession(bound, profile, excludedIndexes, requestInfo, scoringCtx)) {
      return bound;
    }
    // Else fall through to the candidate score loop, which re-homes the session
    // onto the best healthy account via _bindSession on acquire.

    // Healthy-first ladder for BOTH bound and unbound sessions. A bound session
    // only reaches this loop once we've decided to LEAVE its account (rebalance
    // fired / a higher-priority account is available / the bound account is down) —
    // the sticky "stay put" path returns above without reaching here — so re-homing
    // must prefer a genuinely-healthy account and fall back to reserve/critical only
    // if none exists, never re-pick the idle reserve account it's leaving.
    const weeklyPasses = [
      { allowWeeklyReserve: false, allowWeeklyCritical: false },
      { allowWeeklyReserve: true, allowWeeklyCritical: false },
      { allowWeeklyReserve: true, allowWeeklyCritical: true },
    ];

    for (const weeklyOptions of weeklyPasses) {
      best = null;
      bestScore = Infinity;
      bestPriority = Infinity;

      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (this.nextIndex + i) % this.accounts.length;
        const account = this.accounts[idx];
        if (excludedIndexes.has(account.index)) continue;
        if (!this._matchesRequest(account, profile, requestInfo)) continue;
        if (!this._isAvailable(account, { ...weeklyOptions, model: requestInfo.model })) continue;

        const priority = this._effectivePriority(account, requestInfo);
        const score = this._scoreAccount(account, requestInfo, scoringCtx);
        if (priority < bestPriority || (priority === bestPriority && score < bestScore)) {
          bestPriority = priority;
          bestScore = score;
          best = account;
        }
      }

      if (best) {
        const switched = best.index !== this.currentIndex;
        this.currentIndex = best.index;
        this.nextIndex = (best.index + 1) % this.accounts.length;
        // If we switched to an account whose weekly quota is still unknown, flag
        // it so we re-evaluate once that quota is learned (see updateQuota).
        best.probing = best.quota.unified7dReset == null;
        if (switched) {
          console.log(`[Maxpool] Switched to account "${best.name}"`);
        }
        return best;
      }
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
      if (!this._matchesRequest(account, profile, requestInfo)) continue;
      if (!account.enabled) continue;
      const resetTime = account.rateLimitedUntil
        || account.quota.unified5hReset
        || account.quota.unified7dReset
        || (account.quota.resetsAt ? new Date(account.quota.resetsAt).getTime() : null);

      if (resetTime && resetTime < soonestTime) {
        soonestTime = resetTime;
        soonestAccount = account;
      }
    }

    if (soonestAccount && soonestTime <= Date.now()) {
      soonestAccount.status = 'active';
      soonestAccount.rateLimitedUntil = null;
      this.currentIndex = soonestAccount.index;
      console.log(`[Maxpool] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  _boundAccount(sessionKey, profile, excludedIndexes = new Set(), requestInfo = {}) {
    if (!sessionKey) return null;
    const binding = this._sessionBinding(sessionKey);
    if (!binding) return null;

    const home = this._eligibleBoundAccount(binding.homeName, profile, excludedIndexes, { allowWeeklyReserve: true }, requestInfo);
    if (home) return home;

    const current = this._eligibleBoundAccount(binding.currentName, profile, excludedIndexes, { allowWeeklyReserve: true }, requestInfo);
    if (current) return current;

    const homeExists = binding.homeName && this.accounts.some(a => a.name === binding.homeName);
    const currentExists = binding.currentName && this.accounts.some(a => a.name === binding.currentName);
    if (!homeExists && !currentExists) {
      this.sessionBindings.delete(sessionKey);
    }
    return null;
  }

  _eligibleBoundAccount(accountName, profile, excludedIndexes = new Set(), options = {}, requestInfo = {}) {
    if (!accountName) return null;
    const account = this.accounts.find(a => a.name === accountName);
    if (!account) return null;
    if (excludedIndexes.has(account.index)) return null;
    if (!this._matchesRequest(account, profile, requestInfo)) return null;
    if (!this._isAvailable(account, { ...options, model: requestInfo.model })) return null;
    return account;
  }

  _bindSession(sessionKey, account, model = null) {
    const priority = this._priority(account);
    const binding = this._sessionBinding(sessionKey) || {
      homeName: account.name,
      homePriority: priority,
      currentName: account.name,
    };

    if (!binding.homeName || priority < binding.homePriority) {
      binding.homeName = account.name;
      binding.homePriority = priority;
    } else if (priority === binding.homePriority && account.name !== binding.homeName) {
      // Same-priority move. If the previous home is still AVAILABLE we left it by
      // CHOICE (session rebalancing off a hot-but-usable account) → re-home, so
      // _boundAccount (which prefers homeName) doesn't snap the session straight
      // back to the hot home next request. If the old home is UNAVAILABLE this is a
      // FAILOVER → keep homeName so the session returns to it once it recovers.
      // Model-aware: a move off a home that's capped for THIS model (but healthy
      // for others) is a FAILOVER, not a by-choice rebalance — keep homeName so the
      // session snaps back once the model's scoped cap resets.
      const oldHome = this.accounts.find(a => a.name === binding.homeName);
      if (oldHome && this._isAvailable(oldHome, { allowWeeklyReserve: true, model })) {
        binding.homeName = account.name;
      }
    }
    binding.currentName = account.name;
    this.sessionBindings.set(sessionKey, binding);
  }

  _sessionBinding(sessionKey) {
    const binding = this.sessionBindings.get(sessionKey);
    if (!binding) return null;
    if (typeof binding === 'string') {
      const account = this.accounts.find(a => a.name === binding);
      const normalized = {
        homeName: binding,
        homePriority: account ? this._priority(account) : Infinity,
        currentName: binding,
      };
      this.sessionBindings.set(sessionKey, normalized);
      return normalized;
    }
    return binding;
  }

  _hasHigherPriorityAvailable(boundAccount, profile, excludedIndexes = new Set(), requestInfo = {}) {
    const boundPriority = this._priority(boundAccount);
    return this.accounts.some(account => {
      if (account.index === boundAccount.index) return false;
      if (excludedIndexes.has(account.index)) return false;
      if (!this._matchesRequest(account, profile, requestInfo)) return false;
      const priority = this._priority(account);
      return priority < boundPriority && this._isAvailable(account, { allowWeeklyReserve: true, model: requestInfo.model });
    });
  }

  _priority(account) {
    return Number.isFinite(account?.priority) ? account.priority : 0;
  }

  _preferredAccount(profile, excludedIndexes = new Set(), requestInfo = {}) {
    if (this.routingMode !== 'preferred' || !this.preferredAccountName) return null;
    const account = this.accounts.find(candidate => candidate.name === this.preferredAccountName);
    if (!account || excludedIndexes.has(account.index)) return null;
    if (!this._matchesRequest(account, profile, requestInfo)) return null;
    return account;
  }

  setRoutingMode(mode, preferredAccount = null) {
    if (mode !== 'preferred') {
      this.routingMode = 'automatic';
      this.preferredAccountName = null;
      return true;
    }
    const account = this.accounts.find(candidate => candidate.name === preferredAccount);
    if (!account || account.type === 'provider' || !account.enabled) {
      this.routingMode = 'automatic';
      this.preferredAccountName = null;
      return false;
    }
    this.routingMode = 'preferred';
    this.preferredAccountName = account.name;
    this.currentIndex = account.index;
    return true;
  }

  setAccountEnabled(index, enabled) {
    const account = this.accounts[index];
    if (!account) return false;
    account.enabled = Boolean(enabled);
    if (!enabled && account.name === this.preferredAccountName) {
      this.setRoutingMode('automatic');
    }
    return true;
  }

  _matchesProfile(account, profile) {
    const profiles = account.profiles || ['claude', 'all'];
    return profiles.includes(profile);
  }

  _matchesRequest(account, profile, requestInfo = {}) {
    if (this.admissionPaused) return false;
    if (!this._isRequestCompatible(account, profile, requestInfo)) return false;
    if (
      account.type !== 'provider'
      && this.queueState.waiting.length
      && !requestInfo.queueTicket
      && !requestInfo.queueAdmitted
    ) return false;
    if (account.type !== 'provider' && this._isUpstreamThrottleBlocking()) return false;
    return true;
  }

  _crossProviderFallbackPolicy() {
    const p = this.scheduler.crossProviderFallbackPolicy;
    return (p === 'never' || p === 'always') ? p : 'when-exhausted';
  }

  // Selection priority with the 'always' cross-provider policy applied: a provider
  // account peers with oauth (priority 0) for an Anthropic/unknown session so a
  // Claude session load-balances across Claude+GLM+Kimi rather than using providers
  // only as last-resort. 'never'/'when-exhausted' keep the provider's own priority
  // (10/20) → fallback-only. A foreign session is provider-only regardless.
  _effectivePriority(account, requestInfo = {}) {
    const base = Number.isFinite(account.priority) ? account.priority : 0;
    if (account.type === 'provider'
        && this._crossProviderFallbackPolicy() === 'always'
        && !this._effectiveIncompatible(requestInfo).incompatible) {
      return 0;
    }
    return base;
  }

  setCrossProviderFallbackPolicy(policy) {
    if (!['never', 'when-exhausted', 'always'].includes(policy)) return false;
    this.scheduler.crossProviderFallbackPolicy = policy;
    console.log(`[Maxpool] Cross-provider fallback policy set to "${policy}"`);
    return true;
  }

  // Effective Anthropic-incompatibility for a request: the request's own transcript
  // verdict, OR a sticky latch on the session — set once a foreign server_tool_use
  // id is seen, or once Anthropic REJECTED the transcript on replay (react-and-heal
  // in server.js). Never downgrades, so a later no-tool follow-up turn stays
  // provider-pinned. Both the selector AND the retry oracle read this so they never
  // disagree. homeProvider is a SOFT hint (first foreign id shape) for 'never' only.
  _effectiveIncompatible(requestInfo = {}) {
    const sticky = requestInfo.sessionKey ? this.sessionPolicies.get(requestInfo.sessionKey) : null;
    return {
      incompatible: Boolean(requestInfo.anthropicIncompatible || sticky?.anthropicIncompatible),
      homeProvider: requestInfo.homeProvider || sticky?.homeProvider || null,
    };
  }

  _isRequestCompatible(account, profile, requestInfo = {}) {
    if (!this._matchesProfile(account, profile)) return false;

    // Kimi (Moonshot) 400s on images Anthropic/GLM accept ("failed to decode
    // image") — and a provider 400 is TERMINAL (not retried to another account), so
    // an image request that fell back to Kimi FAILS the whole request. Keep image
    // requests off Kimi; they still route to GLM (handles images) + OAuth. If those
    // are all unavailable the request HOLDS/queues (recoverable) rather than 400ing.
    if (requestInfo.hasImage && account.provider === 'kimi') return false;

    const { incompatible, homeProvider } = this._effectiveIncompatible(requestInfo);
    const policy = this._crossProviderFallbackPolicy();

    if (incompatible) {
      // The transcript can't replay to Claude (a foreign server_tool_use id, or
      // content Anthropic rejected on replay) — provider accounts ONLY, regardless
      // of policy. Providers are lenient and accept each other's ids (GLM↔Kimi is
      // fine); 'never' pins to the detected home provider when known.
      if (account.type !== 'provider') return false;
      if (policy === 'never' && homeProvider && account.provider !== homeProvider) return false;
      return true;
    }

    // Compatible session — includes Kimi and GLM-without-server-tools, whose regular
    // tool_use ids pass Anthropic's loose validation, AND ordinary Claude sessions.
    // Claude is eligible + preferred (priority 0). Provider fallback is the SAFE
    // direction (lenient providers accept Anthropic ids/signatures) and is
    // policy-gated ONLY: 'never' keeps a Claude session on Claude; 'when-exhausted'
    // lets providers serve as a priority-fallback; 'always' peers them
    // (_effectivePriority). Signed thinking no longer bars providers here — but its
    // live MIGRATION stays Claude-only (see the rebalance guard).
    if (account.type === 'provider' && policy === 'never') return false;
    return true;
  }

  _noteRequestPolicy(requestInfo = {}) {
    if (!requestInfo.sessionKey) return;
    if (requestInfo.requiresAnthropicThinkingIntegrity) {
      this.markSessionThinkingProtected(requestInfo.sessionKey, requestInfo.model);
    }
    if (requestInfo.anthropicIncompatible) {
      this.markSessionIncompatible(requestInfo.sessionKey, requestInfo.homeProvider);
    }
  }

  // Latch a session as Anthropic-incompatible (a foreign server_tool_use id, or a
  // transcript Anthropic rejected on replay). Sticky + never-downgrades so the
  // session stays provider-pinned across later follow-up turns.
  markSessionIncompatible(sessionKey, homeProvider = null) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    if (!existing.anthropicIncompatible) {
      console.log(`[Maxpool] Session "${sessionKey}" is Anthropic-incompatible (${homeProvider || 'provider'} transcript) — pinned to GLM/Kimi`);
    }
    this.sessionPolicies.set(sessionKey, {
      ...existing,
      anthropicIncompatible: true,
      homeProvider: existing.homeProvider || homeProvider || null,
    });
  }

  // Marks a session as containing Anthropic signed thinking. This no longer bars
  // provider fallback (a lenient provider accepts an Anthropic signature) — it only
  // keeps the session's live cross-account MIGRATION on Claude (the rebalance guard),
  // so a signed block isn't needlessly shuttled to a provider mid-session.
  markSessionThinkingProtected(sessionKey, model = null) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    this.sessionPolicies.set(sessionKey, {
      ...existing,
      requiresAnthropicThinkingIntegrity: true,
      model: existing.model || model || null,
    });
  }

  _requiresAnthropicThinkingIntegrity(requestInfo = {}) {
    if (requestInfo.requiresAnthropicThinkingIntegrity) return true;
    if (!requestInfo.sessionKey) return false;
    return Boolean(this.sessionPolicies.get(requestInfo.sessionKey)?.requiresAnthropicThinkingIntegrity);
  }

  /**
   * Per-selection context shared across the candidate loop so each account's
   * recent-load *share* can be computed against the live fleet total exactly
   * once (rather than O(N) per candidate).
   */
  _scoringContext() {
    const now = Date.now();
    // Denominator for the recent-load *share* term: the primary OAuth pool we
    // balance across. Exclude disabled accounts (never selectable) and provider
    // fallbacks (last-resort, not part of the spread) so a busy provider can't
    // shrink the share signal for the OAuth accounts.
    let fleetRecentWeight = 0;
    for (const account of this.accounts) {
      if (account.enabled === false || account.type === 'provider') continue;
      fleetRecentWeight += this._loadSummary(account, this.scheduler.spreadWindowMs, now).weight;
    }
    return { now, fleetRecentWeight };
  }

  /**
   * Routing cost — lower is preferred. Composed of independent forces rather
   * than a single quota ratio:
   *   - concurrency: never pile concurrent streams on one account (dominant when busy)
   *   - scarcity:    quota *rate* pressure — high only when an account would burn out
   *                  before its window resets; ~0 for a near-reset account with quota
   *                  left (use-it-or-lose-it), so that account is drained, not avoided
   *   - spread:      recent-load share, so sequential traffic rotates off whoever
   *                  served last instead of funnelling onto the lowest-quota account
   *   - ramp:        ease a just-recovered account back in instead of slamming it
   *   - failures:    direct per-account backoff after errors
   */
  _scoreAccount(account, requestInfo = {}, ctx = null) {
    const now = ctx?.now ?? Date.now();
    const reqWeight = Math.max(1, requestInfo.weight || 1);
    const inflight = account.activeWeight + reqWeight;

    // DOMINANT term: in-flight concurrency. Short-term throttling is driven by
    // how many requests pile on one account, so least-loaded-first spread is
    // the primary objective.
    const concurrency = inflight * this.scheduler.concurrencyWeight;

    // Steep soft cap past depth D — the throttle safety floor. No single
    // account absorbs a deep concurrent burst no matter how "cheap" it looks.
    const capPenalty = this.scheduler.capPenaltyWeight
      * Math.max(0, inflight - this.scheduler.perAccountConcurrencyTarget);

    // Burn-pace COST only (demoted from the old dominant scarcity×6 term): a
    // soft de-preference of accounts burning ahead of an even pace. Never a bench.
    const paceCost = this._accountScarcity(account, now) * this.scheduler.paceCostWeight;

    // Per-model weekly de-preference: an account whose scoped weekly for THIS
    // request's model (e.g. Fable) is high-but-not-exhausted is a poor pick for
    // that model — shed its load toward healthier accounts BEFORE the hard bench
    // at weeklyExhaustedThreshold, so it's chosen only as overflow (rarely
    // re-429ing). Scoped weekly is otherwise absent from scoring. Soft, never a
    // bench; 0 below reserve and for models with no scoped cap.
    const scopedPace = requestInfo.model
      ? this._scopedScarcity(account, requestInfo.model, now) * this.scheduler.paceCostWeight
      : 0;

    const fleetRecentWeight = ctx?.fleetRecentWeight ?? 0;
    const recentWeight = this._loadSummary(account, this.scheduler.spreadWindowMs, now).weight;
    const share = fleetRecentWeight > 0 ? recentWeight / fleetRecentWeight : 0;
    const spread = share * this.scheduler.spreadShareWeight;

    const ramp = this._recoveryRamp(account, now);
    const failurePenalty = account.consecutiveFailures * 5;
    // NO unknown-quota bonus. An account whose quota we cannot see must never be
    // MORE attractive than a known-healthy one — the old -0.5 nudge (safe only
    // while the prober quickly resolved "unknown") turned into a relentless pull
    // toward blind accounts once probing was off, driving an out-of-band-burned
    // account to exhaustion. Unknown now scores neutral; the prober (on by
    // default) learns the real number within a cycle. `probing`/requalify still
    // flags a never-seen account for learning — that path is unchanged.

    return concurrency + capPenalty + paceCost + scopedPace + spread + ramp + failurePenalty;
  }

  /**
   * Per-model weekly pace-overage for `model`'s family, or 0 when the account has
   * no scoped cap for it, the cap is inactive, or it's below the reserve tier
   * (plenty of headroom → no steering). Same pace discount as _windowScarcity, so
   * a scoped window about to reset is cheap to spend.
   */
  _scopedScarcity(account, model, now = Date.now()) {
    const fam = modelFamily(model);
    if (!fam) return 0;
    const e = account.quota?.scopedWeekly?.[fam];
    if (!e || e.isActive === false || e.utilization == null) return 0;
    if (e.utilization < this.scheduler.weeklyReserveThreshold) return 0;
    return this._windowScarcity(e.utilization, e.resetAt, WEEK_MS, now);
  }

  /**
   * Quota scarcity in [0, 1+]: the worst (max) pace-overage across all known
   * windows. Pace overage = how far an account's utilization is *ahead of* an
   * even burn over the window. It is ~0 when a window is about to reset (the
   * remaining quota is about to refresh, so it is cheap to spend) and grows
   * toward 1 for an account burning quota fast early in a long window (the
   * genuinely scarce case). When a reset time is unknown we fall back to raw
   * utilization (conservative — no time information to discount by).
   */
  _accountScarcity(account, now = Date.now()) {
    const q = account.quota;
    let scarcity = 0;
    if (q.unified5h != null) {
      scarcity = Math.max(scarcity, this._windowScarcity(q.unified5h, q.unified5hReset, FIVE_HOUR_MS, now));
    }
    if (q.unified7d != null) {
      scarcity = Math.max(scarcity, this._windowScarcity(q.unified7d, q.unified7dReset, WEEK_MS, now));
    }
    if (q.tokensLimit != null && q.tokensRemaining != null && q.tokensLimit > 0) {
      scarcity = Math.max(scarcity, 1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null && q.requestsLimit > 0) {
      scarcity = Math.max(scarcity, 1 - q.requestsRemaining / q.requestsLimit);
    }
    return scarcity;
  }

  _windowScarcity(util, resetMs, windowLen, now = Date.now()) {
    const used = clamp01(util);
    if (!resetMs || resetMs <= now) return used; // unknown / just-reset → face value
    const remainingMs = Math.max(0, resetMs - now);
    const elapsedFrac = clamp01((windowLen - remainingMs) / windowLen);
    return Math.max(0, used - elapsedFrac);
  }

  /**
   * Decaying penalty applied for `recoveryRampMs` after an account un-parks,
   * so a freshly-recovered account (which has ~0 recent load and may look most
   * attractive) is eased back in rather than instantly slammed back to a limit.
   */
  _recoveryRamp(account, now = Date.now()) {
    if (!account.recoveredAt) return 0;
    const age = now - account.recoveredAt;
    if (age < 0 || age >= this.scheduler.recoveryRampMs) return 0;
    return this.scheduler.recoveryRampWeight * (1 - age / this.scheduler.recoveryRampMs);
  }

  _weeklyState(account) {
    const rawState = this._weeklyRawState(account);
    if (rawState === 'unknown' || rawState === 'exhausted') return rawState;

    const pressure = Math.max(clamp01(account.quota.unified7d ?? 0), this._effectiveWeeklyUsage(account));
    if (pressure >= this.scheduler.weeklyCriticalThreshold) return 'critical';
    if (pressure >= this.scheduler.weeklyReserveThreshold) return 'reserve';
    if (pressure >= this.scheduler.weeklySoftThreshold) return 'soft';
    return 'normal';
  }

  // True only when the account is REJECTED ACCOUNT-WIDE — a 'rejected' unified
  // status CORROBORATED by an actually-exhausted unified bucket. A bare 'rejected'
  // with healthy unified buckets is a PER-MODEL sub-limit rejection (e.g. Fable
  // weekly, tracked in scopedWeekly) that Anthropic reports on the unified-status
  // header — it must NOT bench or "block" the whole account, which still has
  // headroom for its other models. Guards both routing (_weeklyRawState) and the
  // TUI "blocked" label against the per-model→account-wide conflation. NOTE: this
  // is a display/inter-429 hint, not the primary bench — a genuinely-dead account
  // is benched account-wide by markRateLimited (status='throttled') on its next 429.
  _isAccountWideRejected(account) {
    const q = account?.quota || {};
    if (q.unifiedStatus !== 'rejected') return false;
    const floor = this.scheduler.weeklyExhaustedThreshold;
    return (Number.isFinite(q.unified5h) && q.unified5h >= floor)
      || (Number.isFinite(q.unified7d) && q.unified7d >= floor);
  }

  _weeklyRawState(account) {
    const q = account.quota;
    this._clearExpiredQuotas(account);
    if (this._isAccountWideRejected(account)) return 'exhausted';
    if (q.unified7d == null) return 'unknown';

    const used = clamp01(q.unified7d);
    if (used >= this.scheduler.weeklyExhaustedThreshold) return 'exhausted';
    if (used >= this.scheduler.weeklyCriticalThreshold) return 'critical';
    if (used >= this.scheduler.weeklyReserveThreshold) return 'reserve';
    if (used >= this.scheduler.weeklySoftThreshold) return 'soft';
    return 'normal';
  }

  _weeklyPaceState(account) {
    if (account.quota.unified7d == null) return 'unknown';
    const effective = this._effectiveWeeklyUsage(account);
    if (effective >= this.scheduler.weeklyExhaustedThreshold) return 'exhausted';
    if (effective >= this.scheduler.weeklyCriticalThreshold) return 'critical';
    if (effective >= this.scheduler.weeklyReserveThreshold) return 'reserve';
    if (effective >= this.scheduler.weeklySoftThreshold) return 'soft';
    return 'normal';
  }

  _effectiveWeeklyUsage(account) {
    const q = account.quota;
    const used = clamp01(q.unified7d ?? 0);
    if (!q.unified7dReset) return used;

    const remainingMs = Math.max(0, q.unified7dReset - Date.now());
    const elapsedRatio = clamp01((WEEK_MS - remainingMs) / WEEK_MS);
    const burnDebt = Math.max(0, used - elapsedRatio);
    return Math.min(1.5, used + burnDebt * this.scheduler.weeklyBurnDebtWeight);
  }

  /**
   * Update an account's quota from a background usage probe (fetchUsage result).
   * Same effect as learning quota from a live response, but for idle accounts.
   */
  applyUsageData(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = clamp01(usage.fiveHour.utilization);
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = clamp01(usage.sevenDay.utilization);
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    // Per-model weekly sub-limits (Fable, Opus, ...). Replace wholesale with the
    // fresh probe set so a family that dropped out of the response doesn't linger
    // stale; expiry on reset is a backstop for the between-probe window. EXCEPTION:
    // a `reactive` scoped-429 bench is authoritative-high — while its resetAt is
    // still future, a lagging probe may neither lower it nor drop it (a probe that
    // omits the family, or reports the pre-429 level, would otherwise un-bench it
    // and trigger an immediate re-429 flap). _clearExpiredQuotas self-clears it at
    // resetAt even if probes die.
    if (usage.scopedWeekly && typeof usage.scopedWeekly === 'object') {
      const now = Date.now();
      const prev = (q.scopedWeekly && typeof q.scopedWeekly === 'object') ? q.scopedWeekly : {};
      const fresh = {};
      for (const [fam, e] of Object.entries(usage.scopedWeekly)) {
        if (!e) continue;
        fresh[fam] = {
          utilization: e.utilization != null ? clamp01(e.utilization) : null,
          resetAt: e.resetAt != null ? e.resetAt : null,
          severity: e.severity || null,
          isActive: e.isActive !== false,
        };
      }
      for (const [fam, pe] of Object.entries(prev)) {
        if (!pe || !pe.reactive || pe.resetAt == null || pe.resetAt <= now) continue;
        const f = fresh[fam];
        // Probe absent, null, or LOWER than the reactive bench → keep the bench.
        // Probe CONFIRMS >= the reactive level → take the fresh reading (still >=
        // threshold, so still exhausted; no stickiness needed).
        if (!f || f.utilization == null || f.utilization < (pe.utilization ?? 0)) {
          fresh[fam] = { ...pe };
        }
      }
      q.scopedWeekly = fresh;
    }

    q.lastProbeOkAt = Date.now();
    // A successful probe clears any recorded failure — freshness confirmed.
    q.lastProbeError = null;
    q.lastProbeErrorAt = null;
    q.lastProbeErrorStatus = null;

    // If we just learned this account's weekly window while probing, re-evaluate
    // selection (same path as learning it from a live response).
    if (account.probing && q.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
    }
  }

  /**
   * Record a background probe FAILURE for an account (called by the prober instead
   * of swallowing the error). Surfaced in getStatus()/the TUI so a persistently
   * failing probe is visible; the stored quota values are left untouched (they age
   * into the staleness marker rather than being blanked — see applyUsageData's
   * `!= null` guards, which are load-bearing for weekly routing).
   */
  recordProbeError(accountIndex, message, status = null) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const q = account.quota;
    q.lastProbeError = message ? String(message).slice(0, 160) : 'probe failed';
    q.lastProbeErrorAt = Date.now();
    q.lastProbeErrorStatus = Number.isFinite(status) ? status : null;
  }

  /**
   * Update a PROVIDER account's quota from a provider usage probe
   * (fetchProviderUsage). z.ai maps to Ses/Wk token windows; Kimi has no pollable
   * source and only sets a `console-only` marker. Writes ONLY the provider* fields
   * (never the unified or scopedWeekly fields) so a provider reading can't reach
   * the OAuth quota gates.
   */
  applyProviderUsage(accountIndex, usage) {
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;
    if (usage.error) {
      // Distinguish "no pollable quota" (Kimi) from a transient probe failure.
      // Never clear existing values on a transient error — let them age into the
      // staleness marker instead of blanking the bars.
      if (usage.source === 'console-only') q.providerQuotaSource = 'console-only';
      return;
    }
    q.providerQuotaSource = usage.source || 'zai';
    if (usage.ses) {
      if (usage.ses.utilization != null) q.providerSes = clamp01(usage.ses.utilization);
      if (usage.ses.resetAt != null) q.providerSesReset = usage.ses.resetAt;
    }
    if (usage.wk) {
      if (usage.wk.utilization != null) q.providerWk = clamp01(usage.wk.utilization);
      if (usage.wk.resetAt != null) q.providerWkReset = usage.wk.resetAt;
    } else {
      // Weekly window absent from this plan/response — clear so a stale weekly
      // reading doesn't linger after a plan/window change.
      q.providerWk = null;
      q.providerWkReset = null;
    }
    q.lastProbeOkAt = Date.now();
  }

  /**
   * True when the background quota probe hasn't succeeded in > 3× its interval —
   * the last-known scoped/provider values are aging with no confirmation. Returns
   * false when the probe is off (nothing to be stale against) or has never yet
   * succeeded (startup — shown as "no data", not "stale").
   */
  _quotaProbeStale(account, now = Date.now()) {
    const interval = this.quotaProbeIntervalMs;
    if (!interval || interval <= 0) return false;
    const last = account?.quota?.lastProbeOkAt;
    if (last == null) return false;
    // 3× interval (min 3 min): the probe now rolls through accounts one at a time
    // (a full sweep ~ N × interval/6), so a healthy account refreshes well inside
    // this window — the marker only fires on a genuine multi-sweep probe failure.
    return (now - last) > Math.max(3 * interval, 180_000);
  }

  /**
   * Update an account's quota tracking from upstream response headers.
   */
  updateQuota(accountIndex, headers) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    // Unified rate limits (Claude Max)
    const u5h = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const u7d = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(u5h)) {
      account.quota.unified5hRaw = u5h;
      account.quota.unified5h = clamp01(u5h);
    }
    if (!isNaN(u7d)) {
      account.quota.unified7dRaw = u7d;
      account.quota.unified7d = clamp01(u7d);
    }

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseResetHeader(r5h);
    if (r7d) account.quota.unified7dReset = parseResetHeader(r7d);

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[Maxpool] Learned weekly quota for "${account.name}", re-evaluating selection`);
    }

    const uStatus = headers['anthropic-ratelimit-unified-status'];
    if (uStatus) {
      // 'rejected' with HEALTHY unified buckets is a PER-MODEL sub-limit rejection
      // (e.g. Fable weekly) — Anthropic surfaces it on the account-wide status
      // header, but recording it account-wide would bench the account for EVERY
      // model and render it "blocked" (the per-model cap is tracked in scopedWeekly).
      // Only honor 'rejected' when a unified bucket corroborates a real account block.
      const floor = this.scheduler.weeklyExhaustedThreshold;
      const unifiedExhausted =
        (Number.isFinite(account.quota.unified5h) && account.quota.unified5h >= floor)
        || (Number.isFinite(account.quota.unified7d) && account.quota.unified7d >= floor);
      account.quota.unifiedStatus = (uStatus === 'rejected' && !unifiedExhausted) ? 'allowed' : uStatus;
    }

    // Standard rate limits (API key accounts)
    const tokensLimit = parseInt(headers['anthropic-ratelimit-tokens-limit'], 10);
    const tokensRemaining = parseInt(headers['anthropic-ratelimit-tokens-remaining'], 10);
    const tokensReset = headers['anthropic-ratelimit-tokens-reset'];
    const requestsLimit = parseInt(headers['anthropic-ratelimit-requests-limit'], 10);
    const requestsRemaining = parseInt(headers['anthropic-ratelimit-requests-remaining'], 10);
    const requestsReset = headers['anthropic-ratelimit-requests-reset'];

    if (!isNaN(tokensLimit)) account.quota.tokensLimit = tokensLimit;
    if (!isNaN(tokensRemaining)) account.quota.tokensRemaining = tokensRemaining;
    if (!isNaN(requestsLimit)) account.quota.requestsLimit = requestsLimit;
    if (!isNaN(requestsRemaining)) account.quota.requestsRemaining = requestsRemaining;

    if (tokensReset) account.quota.resetsAt = tokensReset;
    else if (requestsReset) account.quota.resetsAt = requestsReset;

    const genericLimit = parseFirstInt(headers, [
      'x-ratelimit-limit',
      'x-rate-limit-limit',
      'ratelimit-limit',
      'x-ratelimit-limit-requests',
      'x-ratelimit-requests-limit',
    ]);
    const genericRemaining = parseFirstInt(headers, [
      'x-ratelimit-remaining',
      'x-rate-limit-remaining',
      'ratelimit-remaining',
      'x-ratelimit-remaining-requests',
      'x-ratelimit-requests-remaining',
    ]);
    const genericReset = parseResetHeader(firstHeader(headers, [
      'x-ratelimit-reset',
      'x-rate-limit-reset',
      'ratelimit-reset',
      'x-ratelimit-reset-requests',
      'x-ratelimit-requests-reset',
    ]));

    if (genericLimit != null) account.quota.genericLimit = genericLimit;
    if (genericRemaining != null) account.quota.genericRemaining = genericRemaining;
    if (genericReset != null) account.quota.genericReset = genericReset;

    // Stamp header-freshness ONLY when a real quota header actually arrived — so a
    // header-less response never falsely marks the bars fresh. Drives the TUI's
    // "busy account isn't stale even if its background probe is 429-throttled".
    const gotQuotaHeader = !isNaN(u5h) || !isNaN(u7d)
      || !isNaN(tokensLimit) || !isNaN(tokensRemaining)
      || !isNaN(requestsLimit) || !isNaN(requestsRemaining)
      || genericLimit != null || genericRemaining != null;
    if (gotQuotaHeader) account.quota.lastHeaderQuotaAt = Date.now();

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      const reason = this._isSessionQuotaUnavailable(account) ? 'session quota' : `weekly ${this._weeklyRawState(account)}`;
      const logKey = `${reason}:${pct}`;
      if (account.lastQuotaLogKey !== logKey) {
        account.lastQuotaLogKey = logKey;
        console.log(`[Maxpool] Account "${account.name}" at ${pct}% usage — limiting new placement (${reason})`);
      }
    }
  }

  /**
   * Update cumulative token usage from response body data.
   */
  updateUsage(accountIndex, inputTokens, outputTokens) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    if (inputTokens) account.usage.totalInputTokens += inputTokens;
    if (outputTokens) account.usage.totalOutputTokens += outputTokens;
  }

  /**
   * Mark an account as rate-limited for a given duration.
   */
  markRateLimited(accountIndex, retryAfterSeconds, options = {}) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const retryAfter = clampRetryAfterSeconds(retryAfterSeconds);

    // Model-scoped rate-limit: a per-model weekly cap (e.g. Fable) rejected this
    // request while the account's UNIFIED quota is healthy. Record ONLY the scoped
    // exhaustion — do NOT bench the whole account (its other models still have
    // headroom). The just-429'd request fails over to a headroom account via the
    // per-request excludedIndexes; future same-model requests are steered by the
    // scoped gate; future other-model requests keep using this account.
    if (options.modelScope) {
      account.quota.scopedWeekly = account.quota.scopedWeekly || {};
      account.quota.scopedWeekly[options.modelScope] = {
        utilization: 1,
        resetAt: Date.now() + (retryAfter * 1000),
        severity: 'critical',
        isActive: true,
        // Authoritative-high: a real reject. A lagging 60s probe reporting the
        // pre-429 level (e.g. 0.96) must NOT lower/drop this before resetAt, else
        // the account un-benches and immediately re-429s — a per-probe flap.
        reactive: true,
      };
      account.lastStatus = options.status || 429;
      account.lastErrorAt = Date.now();
      console.log(`[Maxpool] Account "${account.name}" ${options.modelScope} weekly limit hit — scoped bench ${retryAfter}s (account stays active for other models)`);
      return;
    }

    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfter * 1000);
    account.lastStatus = options.status || 429;
    account.lastError = 'rate_limited';
    account.lastErrorAt = Date.now();
    account.provisionalRateLimitFingerprint = options.fingerprint || null;
    if (options.recordFailure !== false) {
      account.failedRequests++;
      account.consecutiveFailures++;
    }
    console.log(`[Maxpool] Account "${account.name}" rate limited for ${retryAfter}s`);
  }

  markAuthFailed(accountIndex, status = 403, reason = 'auth_failed') {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.status = 'error';
    account.rateLimitedUntil = null;
    account.cooldownUntil = null;
    account.provisionalUpstreamUntil = null;
    account.provisionalUpstreamFingerprint = null;
    account.lastStatus = status;
    account.lastError = reason;
    account.lastErrorAt = Date.now();
    console.log(`[Maxpool] Account "${account.name}" disabled after HTTP ${status} (${reason})`);
  }

  markTransientFailure(accountIndex, reason = 'transient_error', { network = false } = {}) {
    const account = this.accounts[accountIndex];
    if (!account) return;

    if (network) {
      // A network-class failure (lost connectivity / token-refresh `fetch failed`)
      // is a FLEET-WIDE condition, not this account's fault — every account fails at
      // once. Use a SHORT FIXED cooldown so the whole fleet retries within seconds of
      // connectivity returning and recovers AUTOMATICALLY, never the exponential
      // 15-min bench that stranded the fleet long after a multi-hour outage and forced
      // a manual restart (2026-06-29 hotel-network nightly cutoff). Deliberately does
      // NOT bump consecutiveFailures: a network blip must not poison the scoring
      // penalty (_scoreAccount) or prime the next REAL per-account failure for the max
      // cooldown — so the counter stays a pure request-health signal and needs no reset.
      account.failedRequests++;
      account.lastError = reason;
      account.lastErrorAt = Date.now();
      account.cooldownUntil = Date.now() + this.scheduler.networkCooldownMs;
      console.log(`[Maxpool] Account "${account.name}" cooling down for ${Math.ceil(this.scheduler.networkCooldownMs / 1000)}s after ${reason} (network — short fixed, auto-recovers)`);
      return;
    }

    const failures = Math.max(1, account.consecutiveFailures + 1);
    const cooldown = Math.min(
      this.scheduler.maxCooldownMs,
      this.scheduler.cooldownMs * 2 ** Math.min(failures - 1, 5),
    );
    account.consecutiveFailures = failures;
    account.failedRequests++;
    account.lastError = reason;
    account.lastErrorAt = Date.now();
    account.cooldownUntil = Date.now() + cooldown;
    console.log(`[Maxpool] Account "${account.name}" cooling down for ${Math.ceil(cooldown / 1000)}s after ${reason}`);
  }

  markProvisionalUpstreamFailure(accountIndex, status, fingerprint, retryAfterSeconds = 10) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const retryAfter = Math.min(clampRetryAfterSeconds(retryAfterSeconds), 30);
    account.provisionalUpstreamUntil = Math.max(
      account.provisionalUpstreamUntil || 0,
      Date.now() + retryAfter * 1000,
    );
    account.lastStatus = status;
    account.lastError = 'upstream_throttled';
    account.lastErrorAt = Date.now();
    account.provisionalUpstreamFingerprint = fingerprint;
    console.log(`[Maxpool] Account "${account.name}" returned HTTP ${status}; trying another Claude account and retrying this one in ${retryAfter}s`);
  }

  clearProvisionalUpstreamFailures(fingerprint, accountIndexes) {
    for (const index of accountIndexes) {
      const account = this.accounts[index];
      if (!account || account.provisionalUpstreamFingerprint !== fingerprint) continue;
      account.provisionalUpstreamUntil = null;
      account.provisionalUpstreamFingerprint = null;
      if (account.lastError === 'upstream_throttled') {
        account.lastError = null;
        account.lastErrorAt = null;
      }
    }
  }

  shouldPromoteUpstreamFailure(incident, requestInfo = {}) {
    if (!incident || incident.accounts.size < 2) return false;
    for (const account of this.accounts) {
      if (
        !account.enabled
        || account.type === 'provider'
        || !this._isRequestCompatible(account, requestInfo.profile || 'claude', requestInfo)
      ) {
        continue;
      }
      if (
        (account.lastSuccessAt && account.lastSuccessAt >= incident.firstAt)
        || (account.lastAcceptedAt && account.lastAcceptedAt >= incident.firstAt)
      ) return false;
      if (incident.accounts.has(account.index)) continue;
      if (account.status === 'exhausted' || account.status === 'error') continue;
      if (this._isSessionQuotaUnavailable(account)) continue;
      if (this._weeklyRawState(account) === 'exhausted') continue;
      return false;
    }
    return true;
  }

  markUpstreamAccepted(accountIndex) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    account.lastAcceptedAt = Date.now();
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return true;

    // Single-writer baton: a worker without the lease NEVER rotates a single-use
    // refresh token (doing so would invalidate the lease holder's token →
    // invalid_grant → bricked account). It serves on its existing access token
    // for the bounded drain; the lease holder owns all rotation.
    if (!this.writerLease) return true;

    // A dead refresh token (invalid_grant) is PERMANENT until browser re-auth —
    // never auto-retry it. Without this the prober re-POSTs the rejected token every
    // ~60s forever (hammering Anthropic's OAuth endpoint). Cleared on re-login.
    if (account.refreshDead) return false;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return true;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[Maxpool] Refreshing token for account "${account.name}"...`);
      // Record the token we're rotating FROM so the persistence layer's
      // generation guard can detect another writer having already advanced it.
      account._refreshedFrom = account.refreshToken;
      try {
        const newTokens = await this._refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account.status = 'active';
        account.cooldownUntil = null;
        console.log(`[Maxpool] Token refreshed for account "${account.name}" (rotated ${tokenFingerprint(account._refreshedFrom)} → ${tokenFingerprint(newTokens.refreshToken)})`);
        // Persist-before-serve: the rotated single-use refresh token must be
        // DURABLE on disk before we return true (before this request serves on the
        // new access token). A non-graceful kill (SIGKILL/crash/OOM/terminal-close)
        // between here and the disk write would otherwise leave the now-CONSUMED
        // token on disk → next boot POSTs it → invalid_grant → forced re-auth.
        // This minimizes the loss window to the write duration (it cannot be zero —
        // the upstream consumes the old token the instant the POST returns); the
        // fingerprint audit trail makes the irreducible residual diagnosable.
        // persistTokenRefresh is bulletproofed to never throw, but the refresh has
        // ALREADY succeeded — a persist anomaly must never be re-classified as a
        // refresh failure (which would latch refreshDead on a working account), so
        // guard the await too.
        try {
          await this._onTokenRefresh?.(accountIndex, newTokens);
        } catch (persistErr) {
          console.error(`[Maxpool] Token persist raised unexpectedly for "${account.name}": ${persistErr?.message || persistErr}`);
        }
        return true;
      } catch (err) {
        console.error(`[Maxpool] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          if (err.retryable) {
            // A retryable refresh failure with NO HTTP status is a network/connectivity
            // failure (fetch failed / timeout) → short fixed cooldown so it auto-recovers
            // when the network returns. A retryable HTTP status (429 / 5xx from the OAuth
            // endpoint) is server-side → keep the exponential backoff.
            this.markTransientFailure(accountIndex, `token_refresh_${err.status || 'network'}`, { network: !err.status });
          } else {
            this.markAuthFailed(accountIndex, err.status || 401, 'token_refresh_failed');
            // The refresh TOKEN itself was rejected (invalid_grant) — permanent until
            // browser re-auth. Latch so ensureTokenFresh + the prober stop retrying a
            // dead token. Set ONLY here (a rejected refresh), never in markAuthFailed
            // (shared with provider auth failures).
            account.refreshDead = true;
            // Monitoring: name the exact token that was rejected + how to diagnose it
            // from the persistent event log next time this recurs. (fp= is safe from
            // the log's secret-redactor; refresh_token= would be redacted.)
            const rejFp = tokenFingerprint(account._refreshedFrom);
            console.error(`[Maxpool] Token refresh REJECTED for "${account.name}" (invalid_grant) — the refresh token maxpool sent (fp=${rejFp}) was not accepted. Diagnose from the event log: an earlier "rotated → ${rejFp}" that WAS "Persisted" ⇒ upstream revocation; NO persisted line for ${rejFp} ⇒ the rotation was lost across a restart (double-spend); the SAME source fp in two "rotated" lines in one window ⇒ two writers double-spent it. Re-login via the TUI ('l' key).`);
          }
          return false;
        }
        return true;
      } finally {
        account._refreshPromise = null;
      }
    })();

    return account._refreshPromise;
  }

  /**
   * Await every in-flight OAuth token refresh to settle. The single-writer baton
   * uses this on RELEASE: a refresh that passed the `if(!writerLease) return` gate
   * BEFORE the lease was dropped is still awaiting its OAuth POST; the new worker
   * must not acquire the lease and rotate the SAME single-use token until these
   * settle, or the upstream invalidates one token → invalid_grant → bricked.
   */
  async drainRefreshes() {
    const pending = this.accounts.map(a => a._refreshPromise).filter(Boolean);
    if (pending.length) await Promise.allSettled(pending);
  }

  /**
   * Set a callback to persist refreshed tokens to config.
   */
  onTokenRefresh(callback) {
    this._onTokenRefresh = callback;
  }

  /**
   * Update a specific account's OAuth tokens (e.g. after intercepting a token refresh).
   */
  updateAccountTokens(accountIndex, { accessToken, refreshToken, expiresAt }) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth') return;

    account.credential = accessToken;
    if (refreshToken) account.refreshToken = refreshToken;
    account.expiresAt = expiresAt;
    account.refreshDead = false;  // fresh tokens from re-auth revive a dead-refresh account
    if (account.status === 'error') account.status = 'active';
    console.log(`[Maxpool] Updated tokens for account "${account.name}"`);
    this._onTokenRefresh?.(accountIndex, {
      accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    });
  }

  /**
   * Add a new account at runtime.
   */
  addAccount(acctData) {
    const index = this.accounts.length;
    this.accounts.push({
      index,
      name: acctData.name,
      type: acctData.type,
      provider: acctData.provider || (acctData.type === 'provider' ? 'provider' : 'anthropic'),
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.authToken || acctData.apiKey,
      upstream: acctData.upstream || null,
      authHeader: acctData.authHeader || null,
      profiles: acctData.profiles || (acctData.type === 'provider' ? ['all'] : ['claude', 'all']),
      priority: Number.isFinite(acctData.priority) ? acctData.priority : 0,
      model: acctData.model || null,
      modelMap: acctData.modelMap || null,
      stripBetaHeaders: Boolean(acctData.stripBetaHeaders),
      runtime: Boolean(acctData.runtime),
      enabled: acctData.enabled !== false,
      refreshToken: acctData.refreshToken || null,
      expiresAt: acctData.expiresAt || null,
      status: 'active',
      // Unknown quota until the first response — probe it like startup accounts.
      probing: true,
      quota: emptyQuota(),
      usage: { totalInputTokens: 0, totalOutputTokens: 0, totalRequests: 0, lastUsed: null },
      inFlight: 0,
      activeWeight: 0,
      completedRequests: 0,
      failedRequests: 0,
      loadEvents: [],
      consecutiveFailures: 0,
      lastStatus: null,
      lastResponseMs: null,
      lastAcceptedAt: null,
      lastError: null,
      lastErrorAt: null,
      cooldownUntil: null,
      provisionalUpstreamFingerprint: null,
      provisionalUpstreamUntil: null,
      rateLimitedUntil: null,
      provisionalRateLimitFingerprint: null,
      recoveredAt: null,
      lastQuotaLogKey: null,
    });
    return index;
  }

  upsertRuntimeAccount(acctData) {
    const idx = this.accounts.findIndex(a => a.name === acctData.name);
    if (idx < 0) return this.addAccount({ ...acctData, runtime: true });

    const account = this.accounts[idx];
    const nextCredential = acctData.accessToken || acctData.authToken || acctData.apiKey || account.credential;
    const nextUpstream = acctData.upstream || account.upstream;
    const changed = nextCredential !== account.credential || nextUpstream !== account.upstream;

    account.type = acctData.type || account.type;
    account.provider = acctData.provider || account.provider;
    account.credential = nextCredential;
    account.upstream = nextUpstream;
    account.authHeader = acctData.authHeader || account.authHeader;
    account.profiles = acctData.profiles || account.profiles;
    account.priority = Number.isFinite(acctData.priority) ? acctData.priority : account.priority;
    account.model = acctData.model || account.model;
    account.modelMap = acctData.modelMap || account.modelMap;
    account.stripBetaHeaders = Boolean(acctData.stripBetaHeaders);
    account.runtime = true;
    if (account.status === 'error' && changed) {
      account.status = 'active';
      account.lastError = null;
      account.lastErrorAt = null;
      account.consecutiveFailures = 0;
      account.refreshDead = false;
    }
    return idx;
  }

  /**
   * Serialize runtime (client-supplied) PROVIDER accounts so they survive a
   * restart. They're created lazily from `cc all` request headers
   * (prepareRuntimeProviders), NOT from config — so without persistence a cold boot
   * / reload shows only the config OAuth accounts until the next `cc all` request
   * re-sends the tokens. Persisted to state.json (0600, same protection as the
   * OAuth-token-bearing config) alongside quota.
   */
  exportRuntimeProviders() {
    return this.accounts
      .filter(a => a.runtime && a.type === 'provider' && a.credential)
      .map(a => ({
        name: a.name,
        type: a.type,
        provider: a.provider,
        authToken: a.credential,
        upstream: a.upstream,
        authHeader: a.authHeader,
        profiles: a.profiles,
        priority: a.priority,
        model: a.model,
        modelMap: a.modelMap,
        stripBetaHeaders: a.stripBetaHeaders,
      }));
  }

  /**
   * Restore persisted runtime providers on boot, via the SAME upsert the header
   * path uses (so a restored provider is byte-identical to a header-created one). A
   * live `cc all` request refreshes the token before routing (prepareRuntimeProviders
   * runs ahead of account selection), so a stale restored token never serves a
   * request. Idempotent — upsertRuntimeAccount matches by name.
   */
  restoreRuntimeProviders(list) {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || !p.name || !(p.authToken || p.credential)) continue;
      this.upsertRuntimeAccount({ ...p, authToken: p.authToken || p.credential });
    }
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    const removed = this.accounts[index];
    if (removed.inFlight > 0) return false;
    const removedName = removed.name;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
    if (removedName === this.preferredAccountName) {
      this.setRoutingMode('automatic');
    }
    return true;
  }

  // Match a saved state entry to a live account by stable identity: prefer the
  // account UUID when both have one, otherwise fall back to the name.
  _sameIdentity(saved, account) {
    if (saved.accountUuid && account.accountUuid) return saved.accountUuid === account.accountUuid;
    return saved.name === account.name;
  }

  /**
   * Serialize persistable quota state for all accounts (no credentials), keyed
   * by account identity so it can be matched back after a restart.
   */
  exportQuotaState() {
    return this.accounts.map(a => {
      const quota = {};
      for (const f of PERSISTED_QUOTA_FIELDS) quota[f] = a.quota[f];
      return { accountUuid: a.accountUuid, name: a.name, quota };
    });
  }

  /**
   * Restore quota learned in a previous run, matched to accounts by identity.
   * Stale windows are not special-cased — _clearExpiredQuotas wipes any restored
   * window whose reset time has already passed on first use.
   */
  restoreQuotaState(saved) {
    if (!Array.isArray(saved)) return;
    for (const account of this.accounts) {
      const match = saved.find(s => this._sameIdentity(s, account));
      if (!match || !match.quota) continue;
      for (const f of PERSISTED_QUOTA_FIELDS) {
        if (match.quota[f] != null) account.quota[f] = match.quota[f];
      }
      // Only keep a restored utilization that carries a clearable reset window.
      // A stale value with no reset can't be cleared by _clearExpiredQuotas and
      // could otherwise pin the account unavailable until the first live response.
      if (account.quota.unified5hReset == null) account.quota.unified5h = null;
      if (account.quota.unified7dReset == null) account.quota.unified7d = null;
      // Drop restored scoped entries lacking a clearable reset window — they can't
      // be expired by _clearExpiredQuotas and would otherwise pin an account
      // unavailable-for-family until the first live probe.
      if (account.quota.scopedWeekly && typeof account.quota.scopedWeekly === 'object') {
        for (const [fam, e] of Object.entries(account.quota.scopedWeekly)) {
          if (!e || e.resetAt == null) delete account.quota.scopedWeekly[fam];
        }
      } else {
        account.quota.scopedWeekly = {};
      }
      // We already know this account's weekly window, so it isn't "probing".
      if (account.quota.unified7dReset != null) account.probing = false;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    const now = Date.now();
    return {
      // Running version + npm update state (set at startup by maybeCheckForUpdate).
      // null until the check resolves; `current` is known even offline.
      version: this.versionInfo || null,
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      routing: {
        mode: this.routingMode,
        preferredAccount: this.preferredAccountName,
        crossProviderFallbackPolicy: this._crossProviderFallbackPolicy(),
      },
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        provider: a.provider,
        enabled: a.enabled,
        upstream: a.upstream,
        profiles: a.profiles,
        priority: a.priority,
        runtime: a.runtime,
        status: a.status,
        refreshDead: Boolean(a.refreshDead),
        inFlight: a.inFlight,
        activeWeight: a.activeWeight,
        completedRequests: a.completedRequests,
        failedRequests: a.failedRequests,
        consecutiveFailures: a.consecutiveFailures,
        lastStatus: a.lastStatus,
        lastResponseMs: a.lastResponseMs,
        load: {
          current: {
            inFlight: a.inFlight,
            activeWeight: a.activeWeight,
          },
          last15m: this._loadSummary(a, 15 * 60 * 1000, now),
          last1h: this._loadSummary(a, 60 * 60 * 1000, now),
        },
        lastError: a.lastError,
        lastErrorAt: a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
        cooldownUntil: Math.max(a.cooldownUntil || 0, a.provisionalUpstreamUntil || 0)
          ? new Date(Math.max(a.cooldownUntil || 0, a.provisionalUpstreamUntil || 0)).toISOString()
          : null,
        quota: { ...a.quota },
        weekly: {
          state: this._weeklyState(a),
          rawState: this._weeklyRawState(a),
          effectiveUsage: this._effectiveWeeklyUsage(a),
          paceState: this._weeklyPaceState(a),
        },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
      scheduler: {
        mode: 'adaptive-least-loaded',
        globalInFlight: this.getGlobalInFlight(),
        admissionPaused: this.admissionPaused,
        safetyMaxActivePerAccount: this.scheduler.safetyMaxActivePerAccount,
        safetyMaxGlobalActive: this.scheduler.safetyMaxGlobalActive,
      },
      upstreamThrottle: {
        active: this._isUpstreamThrottleBlocking(),
        until: this.upstreamThrottle.until
          ? new Date(this.upstreamThrottle.until).toISOString()
          : null,
        reason: this.upstreamThrottle.reason,
        probeInFlight: this.upstreamThrottle.probeInFlight,
        count: this.upstreamThrottle.count,
        lastAt: this.upstreamThrottle.lastAt
          ? new Date(this.upstreamThrottle.lastAt).toISOString()
          : null,
        queued: this.queueState.waiting.length,
        oldestQueuedMs: this.queueState.waiting.length
          ? Math.max(0, now - this.queueState.waiting[0].queuedAt)
          : 0,
      },
      sessions: {
        stickyBindings: this.sessionBindings.size,
        thinkingProtected: [...this.sessionPolicies.values()].filter(p => p.requiresAnthropicThinkingIntegrity).length,
        providerPinned: [...this.sessionPolicies.values()].filter(p => p.anthropicIncompatible).length,
      },
    };
  }
}
