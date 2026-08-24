import { refreshAccessToken, isTokenExpiringSoon, modelFamily, tokenFingerprint } from './oauth.js';
import { CapacityLedger } from './capacity-ledger.js';

// Nominal window length per kind — mirrors capacity-ledger's WINDOW_MS (kept here as a
// local table so account-manager does not import a private constant).
const WINDOW_MS_BY_KIND = { ses: 5 * 3600_000, wk: 7 * 86400_000 };

// A capacity window boundary must move by at least this much to count as a real
// window ADVANCE rather than reset-stamp jitter (see noteCapacityWindowAdvance).
const WINDOW_ADVANCE_EPSILON_MS = 60_000;
import { peakWindowState, DEFAULT_PEAK_CAP } from './peak-window.js';

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
// Warmup-pull: a freshly-ADDED account (mid-session, no reload) would otherwise idle
// until a reload clears bindings, because bound sessions only leave a HOT account. So
// for a bounded window pull migration-safe sessions onto it. Keyed on the account's
// own onboarding state (addedAt + completedRequests), NOT relative load — so it
// PROVABLY TERMINATES (once it has served WARMUP_REQUESTS, or WARMUP_MS elapses, it
// stops warming and never fires again) and cannot oscillate for any #sessions/#accounts
// ratio, unlike a share/concurrency-gap rebalance (which flaps on the lagging load signal).
const WARMUP_MS = 5 * 60 * 1000;      // a just-added account stays "warming" this long…
const WARMUP_REQUESTS = 5;            // …or until it has served this many requests, whichever comes first
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
    // TRUE when a SUCCESSFUL probe reported no weekly cap for this account — i.e.
    // "this plan has no weekly limit", NOT "we couldn't read one". Without it both
    // states render as an empty bar and a healthy account reads as broken.
    weeklyAbsent: false,
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
  // Use-it-or-lose-it (2026-07-24): bench only at 99.9%, not 98.5% — the weekly quota
  // resets, so reserving the top ~1.5% just wastes it. The thin 0.1% floor is the ONE
  // remaining guard: don't fire a request at an account whose own header already says
  // it's essentially full (a near-guaranteed-waste hard-429). A real 429 sets util≈1.0
  // and still benches here. Critical (0.95-0.999) stays last-resort-only (pass 2).
  weeklyExhaustedThreshold: 0.999,
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
  utilizationWeight: 3,           // RAW utilization cost — drives load balancing in the mid-range
  scarcityWeight: 6,              // legacy; superseded by paceCostWeight (kept so old configs don't error)
  // Reserve-account OVERFLOW model. A weekly-RESERVE account (util 0.85-0.95) used to
  // sit idle behind a healthy-only first pass; now it's eligible in the first pass but
  // ranked BELOW healthy accounts by _reserveCost (so healthy stays first-pick). Among
  // reserve accounts the SOONEST-to-reset is cheapest (use-it-or-lose-it); the further
  // into the band, the costlier (preserve). Critical (≥0.95)/exhausted stay hard-benched
  // in the second pass, never softened. See _reserveCost + _selectNext's 2-pass ladder.
  reserveFloorCost: 5,            // base overflow cost — keeps any reserve account behind an idle healthy one (~2)
  reserveBandWeight: 8,           // ×(util-0.85)/0.10: deeper into the reserve band ⇒ costlier ⇒ consumed later
  reserveScarcityWeight: 6,       // ×weekly _windowScarcity: reset-timing weight, ON TOP of the global paceCost, so
                                  // a near-reset reserve account is used freely and a far-from-reset one is used last
  reserveConcurrencyTarget: 2,    // tighter in-flight cap for reserve (capPenalty bites at inflight>2 ⇒ load fans out
                                  // across the fleet before any single reserve account is dogpiled toward a 429)
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
  //
  // SUPERSEDED by `routingMode` below — kept for backward-compat migration only. An
  // old config carrying `crossProviderFallbackPolicy` but no `routingMode` is upgraded
  // at boot: 'always' → 'balance', 'when-exhausted'/'never' → 'prefer-claude'. The
  // per-provider `providers[<key>].claudeFallback` field still controls the same thing
  // for its one provider under the legacy modes.
  crossProviderFallbackPolicy: 'never',
  // ROUTING MODE — the single knob that governs how sessions are distributed across
  // the account pool. Replaces the hidden per-session binding that made 'always' not
  // actually balance. Reported 2026-08-10: with cross-provider 'always' set, 20
  // long-lived sessions that happened to start on the same Anthropic account hammered
  // it at 82% while two GLM accounts at 2%/9% sat idle — because 'always' only governed
  // the FIRST request; after that the session was pinned to one account.
  //
  //   'balance'         — score EVERY request across the full pool. No session binding.
  //                       Accounts drain evenly. The behaviour 'always' should always
  //                       have been.
  //   'prefer-claude'   — score every request, but Anthropic accounts outrank providers
  //                       unless they are all loaded/exhausted.
  //   'prefer-zai'      — GLM accounts preferred; Claude/Kimi fill overflow.
  //   'prefer-kimi'     — Kimi preferred; Claude/GLM fill overflow.
  //   'sticky'          — the old behaviour, made explicit. Sessions stay on the account
  //                       they first land on until it goes hot, then rebalance.
  routingMode: 'sticky',
  // The OTHER cross direction, independent of the policy above: may a provider-origin
  // (GLM/Kimi) session cross to the OTHER provider (GLM↔Kimi)? Default ON — both legs are
  // lenient and accept each other's ids, and it's the reliable direction the user wants
  // kept even while Claude→provider is 'never'. Only has effect under policy:'never' (the
  // 'when-exhausted'/'always' paths never pinned to home). Set false for a strict home-pin.
  providerCrossFallback: true,
  // PER-PROVIDER Claude→provider control. One knob per provider so GLM and Kimi are
  // steered independently (their reliability and quota differ). Each takes the same
  // 'never' | 'when-exhausted' | 'always'. Undefined ⇒ inherit crossProviderFallbackPolicy,
  // so an existing config upgrades to byte-identical behavior. Default 'never': letting a
  // Claude session finish on a provider contaminates its transcript (BOTH providers emit
  // thinking blocks Anthropic rejects — measured 2026-07-25), and while Maxpool now repairs
  // that automatically, a provider server-tool call is NOT repairable.
  // Ships EMPTY on purpose: an unset provider INHERITS crossProviderFallbackPolicy (whose
  // default is already 'never'), so off-by-default holds without a per-provider entry
  // shadowing the global one. Seeding explicit values here would mean cycling the global
  // policy silently did nothing — the two-gate trap.
  providers: {},
};
const LOAD_EVENT_MAX_AGE_MS = 60 * 60 * 1000;
// Consecutive failed recovery probes before we stop trusting the SHARED breaker and
// fall back to per-account handling. Bounds any future "poisoned probe" from becoming
// an indefinite fleet-wide outage (2026-07-25 incident).
const MAX_FAILED_PROBES = 4;
// Consecutive quota-probe failures before we say so. High enough that a network blip or a
// single 429 never trips it; low enough that a permanently dead endpoint surfaces the same
// day rather than never.
const PROBE_FAILURE_ALERT_AT = 20;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// Peak-hour governance (2026-08-18). A peak TIER, added to _effectivePriority after the
// mode layer: tier 1 = provider inside its peak window (de-prefer), tier 2 = also over
// its peakCap (last-resort). A STRIDE, not an additive constant, so a peak account ranks
// below every non-peak account BY CONSTRUCTION even against a hand-set `priority: 500`,
// while intra-tier ordering (the mode layer) is preserved. Not Infinity — the selector's
// `priority < bestPriority` is false for Infinity vs Infinity and an all-peaked pool
// would select nothing.
const PEAK_TIER_STRIDE = 1_000_000;
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
    // Migrate the legacy single-value policy to the new mode if the caller (config)
    // set `crossProviderFallbackPolicy` but not `routingMode`. The per-provider
    // `providers[<key>].claudeFallback` still works under the prefer-* modes.
    // IMPORTANT: when schedulerOptions is empty (no explicit crossProviderFallbackPolicy),
    // the DEFAULT_SCHEDULER value 'never' triggers migration. But the old behaviour
    // under 'never' WAS sticky pinning — so the default must map to 'sticky', not
    // 'prefer-claude'. Only an EXPLICIT 'always' in the caller's config changes the mode.
    if (!schedulerOptions.routingMode) {
      const leg = schedulerOptions.crossProviderFallbackPolicy;
      if (leg === 'always') this.scheduler.routingMode = 'balance';
      else if (leg === 'when-exhausted') this.scheduler.routingMode = 'prefer-claude';
      // 'never' or unset → sticky (the historical default: sessions pin to one account)
      else this.scheduler.routingMode = 'sticky';
    }
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
    this._peakCache = null;   // per-UTC-minute peak-window memo (see _peakStateFor)
    // CAPACITY LEDGER (2026-08-22): observed tokens per completed window cycle, so
    // "true capacity" is comparable across providers. Restored from state on boot.
    this.capacity = new CapacityLedger();
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
    return this._selectNext(requestInfo, excludedIndexes, requestInfo.now);
  }

  nextRetryForRequest(requestInfo = {}, excludedIndexes = new Set(), now = Date.now()) {
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
      if (!fairnessOnlyBlock && this._isAvailable(account, { allowWeeklyReserve: true, model: requestInfo.model, now })) {
        return {
          available: true,
          retryAfterMs: 0,
          cause: 'available',
          reasons,
          matchingRoutes,
        };
      }
      if (fairnessOnlyBlock && this._isAvailable(account, { allowWeeklyReserve: true, allowWeeklyCritical: true, model: requestInfo.model, now })) {
        soonestBoundedHold = Math.min(soonestBoundedHold, BOUNDED_REPOLL_HOLD_MS);
        if (!boundedHoldCause) boundedHoldCause = 'queued_behind_fairness';
        continue;
      }

      const retry = this._retryInfo(account, requestInfo.model, now);
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
        const ms = retry.retryAt - now;
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
        const ms = retry.retryAt - now;
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

  hasAvailableRoute(requestInfo = {}, excludedIndexes = new Set(), now = Date.now()) {
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
      return this._isAvailable(account, { ...options, model: requestInfo.model, now });
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
      // Same clock the selection above used, so the peak-failover guard can never
      // disagree with the peak tier that caused the move (defaults to real time).
      this._bindSession(requestInfo.sessionKey, account, requestInfo.model, requestInfo.now);
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
    const now = options.now ?? Date.now();

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

    // PEAK HARD BAR (peakCap: 0.0 — "never during peak"). The ONLY peak gate on
    // ELIGIBILITY; the soft cap is a priority tier and can never strand a request.
    // No allow* opt-out exists on purpose: zero means zero. The request parks on the
    // finite hold the _retryInfo peak branch hands the oracle — it must never die.
    if (this._peakHardBarred(account, now)) return false;

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
    this.upstreamThrottle.failedProbes = 0;   // fresh breaker → fresh probe budget
    this.upstreamThrottle.count++;
    this.upstreamThrottle.lastAt = Date.now();
    console.log(`[Maxpool] Anthropic upstream temporarily limiting requests for ${retryAfter}s; pausing Claude routes`);
  }

  clearUpstreamThrottle(reason = 'recovered') {
    if (!this.upstreamThrottle.until && !this.upstreamThrottle.probeInFlight) return;
    this.upstreamThrottle.until = null;
    this.upstreamThrottle.reason = null;
    this.upstreamThrottle.probeInFlight = false;
    this.upstreamThrottle.failedProbes = 0;
    this.queueState.rampUntil = Date.now() + 5000;
    this.queueState.lastAdmissionAt = Date.now();
    console.log(`[Maxpool] Anthropic upstream throttle cleared (${reason})`);
  }

  confirmUpstreamProbe(lease) {
    if (!lease?.upstreamThrottleProbe) return;
    this.clearUpstreamThrottle('Anthropic accepted recovery probe');
    lease.upstreamThrottleProbe = false;
  }

  /** Hand the recovery probe back UNUSED — the request never got an upstream answer
   *  (client disconnected, token refresh failed), so it is no evidence either way.
   *  Leaves the window open so the very next request can claim the probe, instead of
   *  scoring a failure that would re-arm the fleet-wide throttle. */
  relinquishUpstreamProbe(lease) {
    if (!lease?.upstreamThrottleProbe) return;
    lease.upstreamThrottleProbe = false;
    this.upstreamThrottle.probeInFlight = false;
  }

  deferUpstreamThrottleProbe(retryAfterSeconds = 5, reason = 'probe_failed') {
    if (!this.upstreamThrottle.until && !this.upstreamThrottle.probeInFlight) return;
    // PROBE BUDGET. A flat 5s retry with unbounded repetition is what let a single
    // poisoned request hold the whole fleet down forever. Escalate the backoff, and
    // after MAX_FAILED_PROBES consecutive failures give up on the shared breaker and
    // fall back to per-account handling — the fleet then retries for real, and if
    // Anthropic genuinely is throttling, shouldPromoteUpstreamFailure re-arms it.
    // (This is a circuit breaker's half-open state, paced by the backoff.)
    this.upstreamThrottle.failedProbes = (this.upstreamThrottle.failedProbes || 0) + 1;
    if (this.upstreamThrottle.failedProbes >= MAX_FAILED_PROBES) {
      this.clearUpstreamThrottle(`probe budget exhausted after ${this.upstreamThrottle.failedProbes} failures (${reason}) — deferring to per-account handling`);
      return;
    }
    const backoff = Math.min(60, retryAfterSeconds * 2 ** (this.upstreamThrottle.failedProbes - 1));
    const retryAfter = clampRetryAfterSeconds(backoff);
    this.upstreamThrottle.until = Date.now() + retryAfter * 1000;
    this.upstreamThrottle.reason = reason;
    this.upstreamThrottle.probeInFlight = false;
    this.upstreamThrottle.lastAt = Date.now();
    console.log(`[Maxpool] Anthropic recovery probe failed (${this.upstreamThrottle.failedProbes}/${MAX_FAILED_PROBES}); retrying in ${retryAfter}s (${reason})`);
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

    // Clear expired unified quotas. The capacity cycle closes HERE, before the stamp
    // is nulled: this is the authoritative rollover moment, and it fires wherever the
    // rollover is noticed (TUI render tick, every routed request) — not only on a
    // prober sweep that happens to land inside the sub-second window before the stamp
    // disappears (without this, OAuth cycles essentially never close: red-team 2026-08-22).
    if (q.unified5h != null && q.unified5hReset && now >= q.unified5hReset) {
      console.log(`[Maxpool] Account "${account.name}" session quota reset`);
      this.capacity?.closeCycle?.(account.name, 'ses', q.unified5hReset, { resetAt: q.unified5hReset });
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[Maxpool] Account "${account.name}" weekly quota reset`);
      this.capacity?.closeCycle?.(account.name, 'wk', q.unified7dReset, { resetAt: q.unified7dReset });
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

    // Provider (z.ai/Kimi) session quota — the 5h token window. Without this a
    // provider at 95% of its 5h cap reads as fully available.
    if (q.providerSes != null && q.providerSes >= this.switchThreshold) return true;

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
    // A same-PROVIDER migration (GLM→GLM, Kimi→Kimi) is always safe: the thinking
    // format is identical on both sides, so there is no cross-format replay risk.
    // The body-scanning gate below exists for Anthropic cross-account migration
    // (where a signed thinking block replayed to a different account can 400). It
    // was blocking provider rebalancing entirely — a GLM session bound to an account
    // at 92% weekly stayed there forever because bodyThinkingScanned was never set
    // on provider-origin requests (no Anthropic thinking blocks to scan).
    const boundName = this._sessionBinding(requestInfo.sessionKey)?.currentName;
    const boundAcct = boundName ? this.accounts.find(a => a.name === boundName) : null;
    if (boundAcct?.type === 'provider') return true;

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
  _isBoundAccountHot(account, now = Date.now()) {
    return this._isSessionQuotaUnavailable(account)
      || ['reserve', 'critical', 'exhausted'].includes(this._weeklyPaceState(account))
      // SESSION-window pressure counts too. _isSessionQuotaUnavailable only fires at
      // switchThreshold (0.90), and the weekly bands don't see the 5h window at all —
      // so an account at 82% of a 5h window was "not hot" and every bound session
      // stayed on it while idle accounts sat at 2%. Measured 2026-08-10: Anthropic at
      // Ses 82% / Wk 66% hammered flat-out beside two GLM accounts at 2% and 9%.
      // Uses the SOFT band (0.65), not reserve (0.85): the point is to shed load while
      // there is still headroom, not at the cliff edge. _shouldRebalanceBoundSession
      // still requires a clearly-cheaper, strictly-healthier target, so a hot account
      // with no better alternative keeps its sessions — this only opens the question.
      || this._sessionWindowUsage(account) >= this.scheduler.weeklySoftThreshold
      // PEAK (2026-08-18): a provider inside its peak window is "hot" in the COST
      // sense — staying bound burns at 2x for hours. Peak-only ⇒ inert off-peak
      // (SC2). This only OPENS the question; the rebalance gates still decide.
      || this._peakTier(account, now) > 0;
  }

  /** Fraction of the SESSION (5h) window consumed, across both quota shapes.
   *  Anthropic reports unified5h; a provider reports providerSes. Returns 0 when
   *  unknown — an unreadable window must never make an account look hot. */
  _sessionWindowUsage(account) {
    const q = account?.quota;
    if (!q) return 0;
    const vals = [];
    if (q.unified5h != null) vals.push(clamp01(q.unified5h));
    if (q.providerSes != null) vals.push(clamp01(q.providerSes));
    return vals.length ? Math.max(...vals) : 0;
  }

  /** Decide whether a bound session should leave its (hot) account THIS request.
   *  All gates must hold: thinking-safe + not mid queue-admission + bound is hot +
   *  a genuinely-healthy alternative that is BOTH much cheaper AND a strictly
   *  healthier weekly tier (so concurrency jitter alone can never trigger a move). */
  /** Is this account still in its post-add onboarding window? A freshly-ADDED
   *  account (addedAt set only by addAccount, never on boot) that has served fewer
   *  than WARMUP_REQUESTS within WARMUP_MS. Providers are never "warming" targets. */
  _isWarming(account, now = Date.now()) {
    if (!account || account.type === 'provider') return false;
    if (account.addedAt == null) return false;                 // boot/config account → never warming
    if (account.completedRequests >= WARMUP_REQUESTS) return false; // onboarded → terminates the pull
    return (now - account.addedAt) < WARMUP_MS;
  }

  /** Warmup-pull target: the best (lowest-score) healthy, migration-eligible,
   *  still-WARMING NON-provider account to onboard a freshly-added account WITHOUT a
   *  reload, or null. Returned DIRECTLY (not via the score-loop fallthrough) so the
   *  destination is GUARANTEED non-provider even under 'always' cross-provider policy
   *  — a signed-thinking session can never be shuttled onto a provider here (which
   *  the shared candidate loop, keyed only on _matchesRequest, would not prevent).
   *  Fires only when the bound account is itself established (not warming) AND is
   *  actually carrying recent load — relieving a real carrier onto the fresh account,
   *  never churning fresh↔fresh or re-homing an idle session. */
  _warmupPullTarget(bound, profile, excludedIndexes, requestInfo, now = Date.now()) {
    // Cheapest early-out first: the overwhelmingly common steady state has NO warming
    // account, so bail before the migration-safety / load / fleet-scoring work. This
    // runs on every bound request's selection — keep the no-warming path near-free.
    if (!this.accounts.some(a => this._isWarming(a, now))) return null;
    if (!this._migrationSafeForRequest(requestInfo)) return null;
    if (requestInfo.queueTicket || requestInfo.queueAdmitted) return null;
    if (this._isWarming(bound, now)) return null;
    if (this._loadSummary(bound, this.scheduler.spreadWindowMs, now).weight <= 0) return null;
    const ctx = this._scoringContext();
    let best = null;
    let bestScore = Infinity;
    for (const account of this.accounts) {
      if (account.index === bound.index) continue;
      if (account.type === 'provider') continue;               // GUARANTEED non-provider destination
      if (excludedIndexes.has(account.index)) continue;
      if (!this._isWarming(account, now)) continue;
      if (!this._matchesRequest(account, profile, requestInfo)) continue;
      // Genuinely-healthy target only (same bar as the hot-rebalance candidate scan).
      if (!this._isAvailable(account, { allowWeeklyReserve: false, allowWeeklyCritical: false, model: requestInfo.model, now })) continue;
      const score = this._scoreAccount(account, requestInfo, ctx);
      if (score < bestScore) {
        bestScore = score;
        best = account;
      }
    }
    return best;
  }

  _shouldRebalanceBoundSession(bound, profile, excludedIndexes, requestInfo, scoringCtx, now = Date.now()) {
    if (!this._migrationSafeForRequest(requestInfo)) return false;
    if (requestInfo.queueTicket || requestInfo.queueAdmitted) return false;
    if (!this._isBoundAccountHot(bound, now)) return false;

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
      // PEAK (2026-08-18): never migrate ONTO a peak-suppressed account — the move
      // would immediately be a 2x-burn destination. Peak-only ⇒ inert off-peak.
      if (this._peakTier(account, now) > 0) continue;
      // Genuinely-healthy alternatives only (normal/soft/unknown weekly + model headroom).
      if (!this._isAvailable(account, { allowWeeklyReserve: false, allowWeeklyCritical: false, model: requestInfo.model, now })) continue;
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

    // Same absolute escape for the SESSION window. The tier test below compares WEEKLY
    // tiers, so a bound account burning down its 5h window can never satisfy it while
    // its weekly is merely soft — which is exactly how an account at Ses 82% kept every
    // session while idle accounts sat at 2%. Requires a MATERIALLY cheaper target so
    // this can't churn between two similarly-loaded accounts.
    // No score margin here, for the reason the weekly escape documents directly above:
    // boundScore*0.5 on an IDLE near-cap account sits below every candidate's minimum
    // score, so the margin is unsatisfiable and pins the session to the account it is
    // meant to relieve. The candidate loop has already kept only RAW-healthy targets,
    // and preserving the last of a 5h window beats concurrency spread.
    if (this._sessionWindowUsage(bound) >= this.scheduler.weeklyReserveThreshold) return true;

    // PEAK (2026-08-18) — absolute escape. The score margins below are calibrated for
    // LOAD relief and are UNSATISFIABLE for a healthy peak account: peak tier 1/2 with
    // weekly pace `normal` means bestTier < boundTier can never hold, so without this
    // escape the exact sessions causing the 2x spend would never move. Flap-stable:
    // clause (b) guarantees every candidate is non-peak, and within the window nothing
    // pulls the session back. Peak-only ⇒ inert off-peak (SC2).
    if (this._peakTier(bound, now) > 0) return true;

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

  _retryInfo(account, model = null, now = Date.now()) {
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

    // PEAK HARD BAR (peakCap 0.0) — barred until a KNOWN wall-clock time, so the oracle
    // must hold FINITE. Placement is pinned: AFTER the terminal checks above, BEFORE
    // the weekly branches. A LATE placement falls through to the terminal
    // `{cause:'unavailable'}` return, contributes to NO recovery bucket, collapses
    // nextRetryForRequest to Infinity, and server.js error-fasts — a session KILL at
    // 06:00 UTC. Precedence: weekly_exhausted (below) outranks peak when the weekly
    // reset dominates; here the max() merge with shortTerm means BOTH must clear.
    if (this._peakHardBarred(account, now)) {
      const { endsAt } = this._peakStateFor(account.provider, now);
      // Only a weekly reset that is ACTUALLY BLOCKING may dominate. providerWkReset is
      // set on every successfully-PROBED provider account — i.e. the steady state, not
      // an exceptional one — so reading it unconditionally made a HEALTHY account at 5%
      // weekly report a 72h "weekly_exhausted" hold instead of the real 3h peak hold.
      // That is the multi-day-hang class this branch exists to prevent, inverted.
      // (Caught by red-team probe 2026-08-18; the D5b control passed only because its
      // fixture left quota={}, a state a probed account is never in.)
      const weeklyBlocked = weeklyState === 'exhausted';
      const weeklyReset = weeklyBlocked ? (q.providerWkReset || q.unified7dReset || 0) : 0;
      // CAUSE follows the DOMINANT blocker, not merely the branch we are in. A
      // peak-barred account that is ALSO weekly-exhausted clears in DAYS, not at the
      // window end — labelling that `peak_window` would tell the user "peak ends in
      // 3h" while the real wait is 3 days (the misleading-message class this codebase
      // has been bitten by before). The TIME was always right via the max-merge; this
      // makes the LABEL agree with it.
      const retryAt = Math.max(endsAt || 0, shortTerm?.retryAt || 0, weeklyReset);
      const weeklyDominates = weeklyReset > 0 && weeklyReset >= (endsAt || 0);
      return {
        cause: weeklyDominates ? 'weekly_exhausted' : 'peak_window',
        retryAt,
        queueable: true,
      };
    }
    if (weeklyState === 'exhausted') {
      // Hard block: only a weekly reset unblocks it — a sooner short-term clear
      // does not help — so key the hold on the weekly reset.
      //
      // Read the PROVIDER reset too. `unified7dReset` is an Anthropic-only field;
      // a GLM/Kimi account stores its weekly reset in `providerWkReset`
      // (applyProviderUsage). Reading only the Anthropic field returned retryAt:null
      // for every weekly-exhausted PROVIDER, which lands on `weeklyUnknownReset` in
      // nextRetryForRequest → retryAfterMs: Infinity → server.js error-fasts → the
      // live session is KILLED, despite the real reset time being known all along.
      // Reproduced 2026-08-18 with providerWk=0.9995 + a known providerWkReset.
      return {
        cause: 'weekly_exhausted',
        retryAt: q.unified7dReset || q.providerWkReset || null,
        queueable: false,
      };
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

  /**
   * Why is every Claude account unavailable RIGHT NOW? Counts the per-account causes
   * the retry oracle already computes, so the 429 can name the real one.
   *
   * "All N accounts are at their limit" was wrong whenever the true cause was a short
   * NETWORK cooldown (5s each, applied on a connection drop): the user reads a quota
   * problem, waits, and considers adding accounts — when the fleet is actually fine and
   * recovers in seconds. Returns { total, quota, transient, network, dominant }.
   */
  unavailabilityCensus(model = null) {
    const QUOTA = new Set(['exhausted', 'weekly_exhausted', 'session_limit', 'token_limit', 'request_limit', 'rate_limited']);
    const TRANSIENT = new Set(['cooldown', 'upstream_failure', 'concurrency_cap', 'weekly_critical']);
    const c = { total: 0, quota: 0, transient: 0, network: 0, disabled: 0, error: 0, other: 0 };
    for (const a of this.accounts) {
      if (a.type === 'provider') continue;
      // DISABLED accounts are out of the serving pool — counting them in `total`
      // made the 429 say "all 9 Claude accounts are momentarily busy" when ONE
      // enabled account was reconnecting and EIGHT were disabled with dead tokens
      // (reported 2026-08-13). The user reads 9-busy as fleet saturation; the
      // truth is 1-busy + 8-off. Track them for the message, exclude from cause math.
      if (a.enabled === false) { c.disabled++; continue; }
      c.total++;
      const cause = this._retryInfo(a, model)?.cause || 'unavailable';
      if (cause === 'error') c.error++;
      else if (QUOTA.has(cause)) c.quota++;
      else if (TRANSIENT.has(cause)) {
        c.transient++;
        // A cooldown whose window matches the NETWORK cooldown is a connectivity blip,
        // not congestion — the distinction the user's report was about.
        if (cause === 'cooldown' && a.cooldownUntil
          && (a.cooldownUntil - Date.now()) <= this.scheduler.networkCooldownMs) c.network++;
      } else c.other++;
    }
    const eligible = c.total - c.error;
    c.dominant = eligible <= 0 ? 'none'
      : c.quota >= Math.max(1, Math.ceil(eligible / 2)) ? 'quota'
        : c.transient > 0 ? 'transient' : 'other';
    return c;
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

  // `now` is the injected clock for every time-varying predicate on the selection
  // path (peak tier, sticky escape). Defaults to the real clock; tests pass it.
  _selectNext(requestInfo = {}, excludedIndexes = new Set(), now = Date.now()) {
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
        && this._isAvailable(pinned, { allowWeeklyReserve: true, allowWeeklyCritical: true, model: requestInfo.model, now })) {
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
      if (preferredPasses.some(options => this._isAvailable(preferred, { ...options, model: requestInfo.model, now }))) {
        this.currentIndex = preferred.index;
        return preferred;
      }
    }
    // Session binding only applies in 'sticky' mode. Every other mode scores each
    // request independently — the whole point of 'balance' is that 20 sessions that
    // happened to start on the same account do NOT keep hammering it while others
    // idle. Warmup-pull still works under the non-sticky modes because it keys on
    // `_isWarming`, not on a binding.
    const isStickyMode = this.scheduler.routingMode === 'sticky';
    const bound = isStickyMode
      ? this._boundAccount(requestInfo.sessionKey, profile, excludedIndexes, requestInfo, now)
      : null;
    if (bound) {
      // Warmup-pull: onboard a freshly-ADDED account (added mid-session, no reload)
      // by DIRECTLY re-homing this migration-safe session onto the warming account,
      // before the sticky "stay bound" return. Directed (not via the score loop) so
      // the destination is guaranteed non-provider. Bounded + self-terminating via
      // _isWarming; each session re-homes at most once → no flap. Skipped for a
      // preferred/pinned request (handled above) and any non-migration-safe request.
      const warmupTarget = this._warmupPullTarget(
        bound, profile, excludedIndexes, requestInfo, scoringCtx?.now,
      );
      if (warmupTarget) {
        this.currentIndex = warmupTarget.index;
        return warmupTarget;   // _bindSession re-homes the session on acquire
      }
      if (!this._hasHigherPriorityAvailable(bound, profile, excludedIndexes, requestInfo)
        && !this._shouldRebalanceBoundSession(bound, profile, excludedIndexes, requestInfo, scoringCtx, now)) {
        return bound;
      }
    }
    // Else fall through to the candidate score loop, which re-homes the session
    // onto the best healthy account via _bindSession on acquire.

    // Two-pass ladder for BOTH bound and unbound sessions. Pass 1 admits healthy AND
    // reserve accounts together; the reserve accounts carry _reserveCost so a healthy
    // account is preferred whenever one is comparably loaded — but a reserve account
    // CAN outrank a badly-slammed healthy one (its capPenalty is unbounded), which is
    // intended load-spread, not a regression. Pass 2 adds critical only when pass 1 is
    // empty (the untouched hard fallback). A bound session reaches this loop only once
    // we've decided to LEAVE its account (the sticky "stay put" path returns above); it
    // may now re-home onto a lightly-loaded reserve account rather than a slammed
    // healthy one — deliberate, since the whole point is to USE reserve accounts.
    const weeklyPasses = [
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
        if (!this._isAvailable(account, { ...weeklyOptions, model: requestInfo.model, now })) continue;

        const priority = this._effectivePriority(account, requestInfo, now);
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

  _boundAccount(sessionKey, profile, excludedIndexes = new Set(), requestInfo = {}, now = Date.now()) {
    if (!sessionKey) return null;
    const binding = this._sessionBinding(sessionKey);
    if (!binding) return null;

    const home = this._eligibleBoundAccount(binding.homeName, profile, excludedIndexes, { allowWeeklyReserve: true, now }, requestInfo);
    if (home) return home;

    const current = this._eligibleBoundAccount(binding.currentName, profile, excludedIndexes, { allowWeeklyReserve: true, now }, requestInfo);
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

  _bindSession(sessionKey, account, model = null, now = Date.now()) {
    const priority = this._priority(account);
    const binding = this._sessionBinding(sessionKey) || {
      homeName: account.name,
      homePriority: priority,
      currentName: account.name,
    };

    // PEAK FAILOVER GUARD (2026-08-18): a move forced by peak suppression is a
    // FAILOVER, not a by-choice rebalance — keep homeName so the session returns to
    // its home once the window closes. Without this, `priority < homePriority`
    // (oauth 0 < provider 10) permanently re-homes every sticky GLM session live at
    // 06:00 UTC, and it never returns after 10:00 — an SC2 violation. Mirrors the
    // CHOICE-vs-FAILOVER distinction the equal-priority branch below already encodes.
    // Both legs need the previous home, so it is resolved once here.
    const oldHome = binding.homeName ? this.accounts.find(a => a.name === binding.homeName) : null;
    const oldHomeInPeak = oldHome != null && this._peakTier(oldHome, now) > 0;
    // Lower-priority leg: only a move ONTO a non-peak account is peak-driven.
    const peakFailover = oldHomeInPeak && this._peakTier(account, now) === 0;

    if (!binding.homeName || (priority < binding.homePriority && !peakFailover)) {
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
      //
      // PEAK FAILOVER GUARD (equal-priority leg): an in-peak old home reads AVAILABLE
      // (tier 1/2 is a ranking, not an eligibility bar) — so without this check the
      // CHOICE branch would treat a peak-driven move as by-choice and permanently
      // re-home the session. A peak home is a FAILOVER cause: keep homeName.
      if (oldHome && !oldHomeInPeak && this._isAvailable(oldHome, { allowWeeklyReserve: true, model })) {
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
    // CAPACITY LEDGER: a cycle that spent part of its life DISABLED did not get the
    // chance to deliver its true capacity, so it is not a capacity observation —
    // flag it partial (shown, excluded from the averages).
    if (!enabled && account.enabled) this.capacity.markPartial(account.name, { disabled: true });
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
  _effectivePriority(account, requestInfo = {}, now = Date.now()) {
    // PEAK TIER (2026-08-18): a stride added AFTER the mode layer, so a peak provider
    // ranks strictly below every non-peak account in EVERY routing mode with no
    // per-mode branch. Tier 0 returns base IDENTICALLY — off-peak behaviour is
    // byte-identical to the pre-peak implementation (SC2 by construction).
    const base = this._basePriority(account, requestInfo);
    const tier = this._peakTier(account, now);
    return tier === 0 ? base : base + tier * PEAK_TIER_STRIDE;
  }

  _basePriority(account, requestInfo = {}) {
    const base = Number.isFinite(account.priority) ? account.priority : 0;
    const mode = this.scheduler.routingMode;
    const incompatible = this._effectiveIncompatible(requestInfo).incompatible;
    // An incompatible session is pinned to its provider family — no mode overrides that.
    if (incompatible) {
      const isHome = account.type === 'provider'
        && (mode === 'prefer-zai' ? account.provider === 'zai'
          : mode === 'prefer-kimi' ? account.provider === 'kimi' : true);
      return isHome ? 0 : base;
    }
    // Balance: every account peers at priority 0. Accounts are ranked by score alone.
    if (mode === 'balance') return 0;
    // Prefer-* modes: the preferred family sits at 0, everything else at its base
    // priority (10 for GLM, 20 for Kimi). So the preferred family is chosen first and
    // the others only when every preferred account is unavailable (the score loop's
    // pass-1 admits reserve accounts, so a loaded preferred account DOES give way).
    if (mode === 'prefer-claude') {
      return account.type === 'provider' ? base : 0;
    }
    if (mode === 'prefer-zai') {
      return account.provider === 'zai' ? 0 : base;
    }
    if (mode === 'prefer-kimi') {
      return account.provider === 'kimi' ? 0 : base;
    }
    // Sticky: legacy behaviour — the 'always' policy promoted providers to 0.
    if (account.type === 'provider'
        && this._claudeFallbackFor(account.provider) === 'always') {
      return 0;
    }
    return base;
  }

  setProviderRoutingMode(mode) {
    if (!['balance', 'prefer-claude', 'prefer-zai', 'prefer-kimi', 'sticky'].includes(mode)) return false;
    this.scheduler.routingMode = mode;
    console.log(`[Maxpool] Routing mode set to "${mode}"`);
    return true;
  }

  // Legacy shim — the TUI routing screen still cycles this. Maps to the new mode.
  setCrossProviderFallbackPolicy(policy) {
    if (!['never', 'when-exhausted', 'always'].includes(policy)) return false;
    this.scheduler.crossProviderFallbackPolicy = policy;
    // Map to the new mode so the binding/priority logic agrees.
    this.scheduler.routingMode = policy === 'always' ? 'balance' : policy === 'when-exhausted' ? 'prefer-claude' : 'sticky';
    console.log(`[Maxpool] Cross-provider fallback policy set to "${policy}" (routing mode: ${this.scheduler.routingMode})`);
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

  /** Claude→provider policy for ONE provider. Falls back to the legacy global policy when
   *  unset, so an existing config keeps its exact behavior on upgrade. */
  _claudeFallbackFor(providerKey) {
    const per = this.scheduler.providers?.[providerKey]?.claudeFallback;
    const valid = new Set(['never', 'when-exhausted', 'always']);
    return valid.has(per) ? per : this._crossProviderFallbackPolicy();
  }

  setClaudeFallbackForProvider(providerKey, policy) {
    const valid = new Set(['never', 'when-exhausted', 'always']);
    if (!providerKey || !valid.has(policy)) return false;
    const providers = { ...(this.scheduler.providers || {}) };
    providers[providerKey] = { ...(providers[providerKey] || {}), claudeFallback: policy };
    this.scheduler.providers = providers;
    this._peakCache = null;   // provider settings changed → peak memo is stale (MINOR 10)
    return true;
  }

  /** Peak settings setter (TUI + config writes). Validates, spread-preserves sibling
   *  keys, clears the per-minute memo. Returns false on invalid input (no change). */
  setPeakSettingsForProvider(providerKey, { peakWindows, peakCap, peakDepreference, peakTimezone } = {}) {
    if (!providerKey) return false;
    const existing = this.scheduler.providers?.[providerKey] || {};
    const next = { ...existing };
    if (peakWindows !== undefined) {
      if (!Array.isArray(peakWindows)) return false;
      next.peakWindows = peakWindows;
    }
    if (peakCap !== undefined) {
      // The SAME coercion trap the read path documents: Number(null)/Number('')/
      // Number(false) are all 0 = the HARD BAR. A persisted 0 is then unreachable
      // by the read-path guard (typeof 0 === 'number'). Reject non-numbers here.
      if (typeof peakCap !== 'number' || !Number.isFinite(peakCap) || peakCap < 0 || peakCap > 1) return false;
      next.peakCap = peakCap;
    }
    if (peakDepreference !== undefined) next.peakDepreference = Boolean(peakDepreference);
    if (peakTimezone !== undefined) {
      // null = follow the machine's zone. A string must be a zone Intl accepts —
      // validate by construction so a typo is rejected here rather than silently
      // falling back at every routing decision.
      if (peakTimezone !== null) {
        if (typeof peakTimezone !== 'string') return false;
        try { new Intl.DateTimeFormat('en-US', { timeZone: peakTimezone }); } catch { return false; }
      }
      next.peakTimezone = peakTimezone;
    }
    const providers = { ...(this.scheduler.providers || {}) };
    providers[providerKey] = next;
    this.scheduler.providers = providers;
    this._peakCache = null;
    return true;
  }

  /** Machine-readable peak state for the status endpoint (SC9). Per provider:
   *  inPeak/endsAt/cap/depreference; plus which accounts are tier-1/2/barred. */
  peakSummary(now = Date.now()) {
    const providers = {};
    for (const a of this.accounts) {
      if (a.type !== 'provider' || providers[a.provider]) continue;
      const { inPeak, endsAt, settings } = this._peakStateFor(a.provider, now);
      providers[a.provider] = { inPeak, endsAt, cap: settings.cap, depreference: settings.depreference };
    }
    return { providers };
  }

  // ── Peak-hour governance (2026-08-18) ─────────────────────────────────────────
  // Peak is a DERIVED, STATELESS overlay: a pure function of now + config. Never
  // persisted, never latched, never timer-driven — so sleep/wake, restart and the
  // zero-downtime reload need no recovery code. All peak predicates route through
  // these four helpers so the selector, the oracle and the TUI can never disagree.

  /** Merged peak settings for one provider family. A malformed cap falls back to the
   *  shipped default rather than throwing — but a malformed WINDOW yields `[]`, i.e.
   *  never peak, so a config typo degrades to today's behaviour instead of benching an
   *  account. Defaults resolve ONLY from scheduler.providers (seeded by the loadConfig
   *  migration / createDefaultConfig — see peak-window.js for why they must not live
   *  in DEFAULT_SCHEDULER). Resolved once per provider per minute via _peakStateFor. */
  _peakSettingsFor(providerKey) {
    const p = this.scheduler.providers?.[providerKey] || {};
    // Accept ONLY a real number. `Number(null)`/`Number('')`/`Number(false)`/`Number([])`
    // are all 0 — which is the HARD BAR — so a config carrying `peakCap: null` (the
    // natural JSON spelling of "no cap", and the very convention `peakTimezone: null`
    // uses in this same object) would silently bench every GLM account for 4h every
    // weekday. The window path already documents "a typo degrades to today's
    // behaviour"; the cap path must match it.
    const cap = typeof p.peakCap === 'number' && Number.isFinite(p.peakCap) ? p.peakCap : undefined;
    return {
      windows: Array.isArray(p.peakWindows) ? p.peakWindows : [],
      // null/absent ⇒ follow the MACHINE's local zone (wallClockIn's own default).
      // A string pins an IANA zone. Both are user-settable (2026-08-18).
      timezone: typeof p.peakTimezone === 'string' && p.peakTimezone ? p.peakTimezone : null,
      cap: cap === undefined ? DEFAULT_PEAK_CAP : Math.max(0, Math.min(1, cap)),
      depreference: p.peakDepreference !== false,
    };
  }

  /** {inPeak, endsAt, settings} for a provider family, memoized per UTC MINUTE (the
   *  evaluation is minute-stable by construction, so the memo is exact). Carrying the
   *  resolved settings in the same entry is what lets _peakTier / _peakHardBarred /
   *  peakSummary read them without re-resolving. Invalidated by the peak/provider
   *  setters, which are the only things that can change settings mid-minute. */
  _peakStateFor(providerKey, now = Date.now()) {
    const minute = Math.floor(now / 60_000);
    if (!this._peakCache || this._peakCache.minute !== minute) {
      this._peakCache = { minute, byProvider: new Map() };
    }
    let st = this._peakCache.byProvider.get(providerKey);
    if (!st) {
      const settings = this._peakSettingsFor(providerKey);
      st = { ...peakWindowState(settings.windows, now, settings.timezone), settings };
      this._peakCache.byProvider.set(providerKey, st);
    }
    return st;
  }

  /** WEEKLY utilization 0..1, or null when unreadable. The cap's basis (D2): TOTAL
   *  WEEKLY — deliberately NOT _weeklyRawState's max(providerSes, providerWk), which
   *  conflates the 5h session window with the weekly one. null (legacy TOKENS_LIMIT
   *  plan / weeklyAbsent) FAILS OPEN: unknown must never mean over-cap. Provider-only,
   *  like every peak predicate — OAuth accounts have no peak concept. */
  _peakWeeklyUtilization(account) {
    const wk = account?.quota?.providerWk;
    return wk != null ? clamp01(wk) : null;
  }

  /** SOFT cap: weekly utilization at/over the cap during peak ⇒ tier 2 (last-resort).
   *  cap >= 1 is "feature off" (SC4) — the strict < 1 guard also stops cap 1.0 firing
   *  at exactly util 1.0. cap === 0 is NOT handled here; it is the hard bar, a
   *  different mechanism entirely (utilization-independent). */
  _peakCapExceeded(account, settings) {
    if (!(settings.cap > 0 && settings.cap < 1)) return false;
    const util = this._peakWeeklyUtilization(account);
    if (util == null) return false;          // fail open
    return util >= settings.cap;
  }

  /** HARD bar: peakCap === 0.0 means "never use this provider during peak" (D4).
   *  Utilization is irrelevant — zero means zero. The ONLY peak predicate that gates
   *  ELIGIBILITY (_isAvailable); everything else is ranking. */
  _peakHardBarred(account, now = Date.now()) {
    if (account?.type !== 'provider') return false;
    const { inPeak, settings } = this._peakStateFor(account.provider, now);
    return inPeak && settings.cap === 0;
  }

  /** 0 = unaffected · 1 = peak, de-preferred · 2 = peak + over the soft cap.
   *  OAuth accounts are 0 always (no peak concept). A provider with no window is 0
   *  always (Kimi by default — SC5). The cap is independent of depreference: turning
   *  depreference off must not disable the cap (both knobs exist, D7). */
  _peakTier(account, now = Date.now()) {
    if (account?.type !== 'provider') return 0;
    const { inPeak, settings } = this._peakStateFor(account.provider, now);
    if (!inPeak) return 0;
    if (this._peakCapExceeded(account, settings)) return 2;
    return settings.depreference ? 1 : 0;
  }

  _isRequestCompatible(account, profile, requestInfo = {}) {
    if (!this._matchesProfile(account, profile)) return false;

    // Kimi (Moonshot) 400s on images Anthropic/GLM accept ("failed to decode
    // image") — and a provider 400 is TERMINAL (not retried to another account), so
    // an image request that fell back to Kimi FAILS the whole request. Keep image
    // requests off Kimi; they still route to GLM (handles images) + OAuth. If those
    // are all unavailable the request HOLDS/queues (recoverable) rather than 400ing.
    if (requestInfo.hasImage && account.provider === 'kimi') return false;

    // A large-context session: a provider already rejected THIS request with a
    // context-length 400. Deliberately REACTIVE — it never assumes a ceiling, it learns
    // one from an actual rejection, so it self-corrects as providers grow. That matters:
    // the old ~256K coding-endpoint cap is gone (verified 2026-08-02 — GLM 5.2 and Kimi
    // K3 both accepted a ~400K-token payload and both honoured the requested model id),
    // so this branch simply stops firing rather than needing a new constant.
    // Sticky per session (context only grows turn over turn) so no follow-up turn re-pays
    // the wasted attempt.
    if (account.type === 'provider' && this._isSessionLargeContext(requestInfo)) return false;

    const { incompatible, homeProvider } = this._effectiveIncompatible(requestInfo);
    const policy = this._crossProviderFallbackPolicy();

    if (incompatible) {
      // The transcript can't replay to Claude (a foreign server_tool_use id, or
      // content Anthropic rejected on replay) — provider accounts ONLY, regardless
      // of policy. Providers are lenient and accept each other's ids (GLM↔Kimi is
      // fine). Under 'never' we keep the session on its home provider ONLY when
      // providerCrossFallback is explicitly off; by default GLM↔Kimi crossing stays
      // allowed even under 'never' (that reliable direction is governed separately
      // from the Claude→provider policy).
      if (account.type !== 'provider') return false;
      if (policy === 'never' && homeProvider && account.provider !== homeProvider
        && this.scheduler.providerCrossFallback === false) return false;
      return true;
    }

    // Compatible session — includes Kimi and GLM-without-server-tools, whose regular
    // tool_use ids pass Anthropic's loose validation, AND ordinary Claude sessions.
    // Under the new routing modes, providers are eligible whenever the mode allows
    // them to peer (balance + prefer-{zai,kimi}) or serve as fallback
    // (prefer-claude + sticky). The legacy per-provider `claudeFallback: 'never'`
    // gate only applies under 'sticky' — the old behaviour it was written for.
    if (account.type === 'provider') {
      const mode = this.scheduler.routingMode;
      // Balance and prefer-{zai,kimi}: providers are always eligible (scored, not gated).
      if (mode === 'balance' || mode === 'prefer-zai' || mode === 'prefer-kimi') return true;
      // Prefer-claude: providers serve as overflow. Still eligible — priority handles the
      // preference; an available Claude account always wins on priority.
      if (mode === 'prefer-claude') return true;
      // Sticky: the legacy per-provider gate applies — this is the mode it was written for.
      if (this._claudeFallbackFor(account.provider) === 'never') return false;
    }
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
    if (requestInfo.largeContext) {
      this.markSessionLargeContext(requestInfo.sessionKey);
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

  // Latch a session as large-context: a provider (the GLM/Kimi coding endpoint, fixed
  // ~256K) rejected a request with a context-length 400 that only a 1M Claude can hold.
  // Sticky + never-downgrades so every follow-up turn (context only grows) skips the
  // too-small providers instead of re-paying a wasted 400. Cleared only by a new session.
  markSessionLargeContext(sessionKey) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    if (!existing.largeContext) {
      console.log(`[Maxpool] Session "${sessionKey}" exceeds provider context limits — pinned to Claude (GLM/Kimi benched for this session)`);
    }
    this.sessionPolicies.set(sessionKey, { ...existing, largeContext: true });
  }

  // Latch a session whose transcript carries provider-authored thinking blocks Anthropic
  // rejects. Without this the repair is per-REQUEST: the client resends the whole poisoned
  // history every turn, so each turn pays another rejected round-trip before the strip
  // (measured: ~9 rejections per contaminated session). Sticky → later turns are stripped
  // BEFORE the first attempt. In-memory only, like the other session policies.
  markSessionThinkingContaminated(sessionKey) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    if (!existing.thinkingContaminated) {
      console.log(`[Maxpool] Session "${sessionKey}" carries provider-authored thinking — stripping it up front from now on`);
    }
    this.sessionPolicies.set(sessionKey, { ...existing, thinkingContaminated: true });
  }

  /** Release a session pinned provider-only by an earlier turn. The incompatible latch is
   *  deliberately sticky (it never downgrades), which is right while the transcript really
   *  is unrepairable — but a repaired body IS replayable on Claude, so the pin must lift
   *  or every previously-broken session stays exiled forever. */
  clearSessionIncompatible(sessionKey) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey);
    if (!existing?.anthropicIncompatible) return;
    this.sessionPolicies.set(sessionKey, { ...existing, anthropicIncompatible: false });
    console.log(`[Maxpool] Session "${sessionKey}" repaired — Claude routes re-enabled`);
  }

  /** Remember the effort level a MODEL actually accepted for this session, so later turns
   *  apply it up front. The client resends the same rejected setting every turn, so without
   *  this each turn pays a rejected round-trip AND charges a consecutive-failure to whichever
   *  account ate it — deprioritising a perfectly healthy account for a client-side setting.
   *  Keyed by model: opus-4-5 takes 'high' while opus-4-1 takes no effort at all. */
  markSessionEffort(sessionKey, model, effort) {
    if (!sessionKey || !model) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    this.sessionPolicies.set(sessionKey, { ...existing, effortFix: { model, effort } });
  }

  getSessionEffort(sessionKey, model) {
    if (!sessionKey || !model) return undefined;
    const fix = this.sessionPolicies.get(sessionKey)?.effortFix;
    return fix && fix.model === model ? fix : undefined;
  }

  isSessionThinkingContaminated(sessionKey) {
    if (!sessionKey) return false;
    return Boolean(this.sessionPolicies.get(sessionKey)?.thinkingContaminated);
  }

  _isSessionLargeContext(requestInfo = {}) {
    if (requestInfo.largeContext) return true;
    if (!requestInfo.sessionKey) return false;
    return Boolean(this.sessionPolicies.get(requestInfo.sessionKey)?.largeContext);
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
    // account absorbs a deep concurrent burst no matter how "cheap" it looks. A
    // RESERVE account gets a tighter D (reserveConcurrencyTarget) so its capPenalty
    // bites sooner — load fans out across the fleet before a low-quota account is
    // dogpiled toward a 429.
    const weeklyState = this._weeklyRawState(account);
    const concTarget = weeklyState === 'reserve'
      ? this.scheduler.reserveConcurrencyTarget
      : this.scheduler.perAccountConcurrencyTarget;
    const capPenalty = this.scheduler.capPenaltyWeight
      * Math.max(0, inflight - concTarget);

    // Burn-pace COST only (demoted from the old dominant scarcity×6 term): a
    // soft de-preference of accounts burning ahead of an even pace. Never a bench.
    const paceCost = this._accountScarcity(account, now) * this.scheduler.paceCostWeight;

    // RAW utilization cost — direct, not pace-adjusted. The pace cost above discounts
    // by how far into the window you are, so an account at 80% with 2h left is only
    // "slightly ahead of pace" → tiny cost. That's right for avoiding premature
    // benching, but wrong for load balancing: an account at 80% should be clearly less
    // attractive than one at 10% even if both are "on pace". Measured 2026-08-10: cc at
    // 80% scored 52.30 vs glm at 10% at 52.15 — a 0.15 gap drowned by round-robin.
    const utilizationCost = this._rawUtilization(account) * this.scheduler.utilizationWeight;

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
    const reserveCost = this._reserveCost(account, now, weeklyState);
    const failurePenalty = account.consecutiveFailures * 5;
    // NO unknown-quota bonus. An account whose quota we cannot see must never be
    // MORE attractive than a known-healthy one — the old -0.5 nudge (safe only
    // while the prober quickly resolved "unknown") turned into a relentless pull
    // toward blind accounts once probing was off, driving an out-of-band-burned
    // account to exhaustion. Unknown now scores neutral; the prober (on by
    // default) learns the real number within a cycle. `probing`/requalify still
    // flags a never-seen account for learning — that path is unchanged.

    return concurrency + capPenalty + paceCost + utilizationCost + scopedPace + spread + ramp + reserveCost + failurePenalty;
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
    // Provider (z.ai/Kimi) quota — same scoring axis as Anthropic's windows. Without
    // this, a GLM account at 80% of its 5h session scored the same as one at 5%,
    // so the scheduler dogpiled the near-cap account until z.ai 429'd it.
    if (q.providerSes != null) {
      scarcity = Math.max(scarcity, this._windowScarcity(q.providerSes, q.providerSesReset, FIVE_HOUR_MS, now));
    }
    if (q.providerWk != null) {
      scarcity = Math.max(scarcity, this._windowScarcity(q.providerWk, q.providerWkReset, WEEK_MS, now));
    }
    return scarcity;
  }

  /** RAW utilization (0..1) — not pace-adjusted. Reads the same fields as
   *  _accountScarcity but WITHOUT the elapsed-fraction discount. This is the signal
   *  the load balancer needs: an account at 80% is more expensive than one at 10%,
   *  full stop. */
  _rawUtilization(account) {
    const q = account?.quota;
    if (!q) return 0;
    // SESSION windows use raw utilization — headroom is consumed immediately and an
    // 80%-used 5h window is genuinely more expensive than a 10%-used one right now.
    let util = 0;
    if (q.unified5h != null) util = Math.max(util, clamp01(q.unified5h));
    if (q.providerSes != null) util = Math.max(util, clamp01(q.providerSes));
    // WEEKLY windows use PACE-ADJUSTED utilization (via _windowScarcity), not raw —
    // a 79% account resetting in 2h has plenty of headroom and should be cheap to
    // spend (the use-it-or-lose-it principle). Using raw weekly would break that.
    // The pace cost already carries this signal; here we add only the session signal
    // the pace cost was too weak to express.
    if (q.tokensLimit != null && q.tokensLimit > 0 && q.tokensRemaining != null) {
      util = Math.max(util, 1 - q.tokensRemaining / q.tokensLimit);
    }
    return util;
  }

  _windowScarcity(util, resetMs, windowLen, now = Date.now()) {
    const used = clamp01(util);
    if (!resetMs || resetMs <= now) return used; // unknown / just-reset → face value
    const remainingMs = Math.max(0, resetMs - now);
    const elapsedFrac = clamp01((windowLen - remainingMs) / windowLen);
    return Math.max(0, used - elapsedFrac);
  }

  /**
   * Overflow cost for a weekly-RESERVE account (util 0.85-0.95). 0 for every other
   * tier — normal/soft aren't softened, and critical/exhausted are hard-benched by the
   * pass gate (never made cheaper here). This is what lets a reserve account be eligible
   * in the FIRST selection pass yet still rank below healthy accounts: floor keeps it
   * strictly behind an idle healthy pick, the band term makes deeper-into-reserve costlier
   * (consumed later / preserved), and the reset-timing term makes the soonest-to-reset the
   * cheapest reserve pick (use-it-or-lose-it). A slammed HEALTHY account can still score
   * above a lightly-loaded reserve one (its capPenalty is unbounded) — that's intended
   * load-spread, not a violation of "healthy first".
   */
  _reserveCost(account, now = Date.now(), weeklyState = this._weeklyRawState(account)) {
    if (weeklyState !== 'reserve') return 0;
    const q = account.quota;
    const util = clamp01(q.unified7d);
    const band = clamp01(
      (util - this.scheduler.weeklyReserveThreshold)
      / Math.max(1e-6, this.scheduler.weeklyCriticalThreshold - this.scheduler.weeklyReserveThreshold),
    );
    const pace = this._windowScarcity(q.unified7d, q.unified7dReset, WEEK_MS, now);
    return this.scheduler.reserveFloorCost
      + this.scheduler.reserveBandWeight * band
      + this.scheduler.reserveScarcityWeight * pace;
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

    // Provider accounts (GLM/Kimi) carry their quota in providerSes/providerWk, NOT
    // unified7d — those fields are Anthropic-only. Without this, a provider at 83%
    // weekly (Kimi measured 2026-08-08) reads as 'unknown' = healthy, so the scheduler
    // keeps piling onto it instead of spreading load. The same thresholds apply.
    if (account.type === 'provider') {
      const sesUsed = q.providerSes != null ? clamp01(q.providerSes) : null;
      const wkUsed = q.providerWk != null ? clamp01(q.providerWk) : null;
      const used = Math.max(sesUsed ?? 0, wkUsed ?? 0);
      if (used >= this.scheduler.weeklyExhaustedThreshold) return 'exhausted';
      if (used >= this.scheduler.weeklyCriticalThreshold) return 'critical';
      if (used >= this.scheduler.weeklyReserveThreshold) return 'reserve';
      if (used >= this.scheduler.weeklySoftThreshold) return 'soft';
      return 'normal';
    }

    if (q.unified7d == null) return 'unknown';

    const used = clamp01(q.unified7d);
    // NEVER bench on utilization alone while the upstream explicitly says the account is
    // ALLOWED. Anthropic reports both a percentage and a verdict; the verdict is the
    // authority, and it keeps saying "allowed"/"allowed_warning" at 100% used. This mirrors
    // _isAccountWideRejected above, which already treats an explicit 'rejected' as decisive
    // for the negative case — the positive case was simply missing.
    // Measured 2026-08-06: max@gomokka.com sat benched at unified7d=1.00 with
    // unifiedStatus='allowed_warning' and returned 200 to a live request. Capacity the user
    // was waiting on, withheld because a threshold outranked the upstream's own answer.
    // 'exhausted' is the only state that removes an account from routing, so the override
    // is scoped to it — critical/reserve still apply their soft costs unchanged.
    const upstreamAllows = typeof q.unifiedStatus === 'string' && q.unifiedStatus.startsWith('allowed');
    if (used >= this.scheduler.weeklyExhaustedThreshold && !upstreamAllows) return 'exhausted';
    if (used >= this.scheduler.weeklyCriticalThreshold) return 'critical';
    if (used >= this.scheduler.weeklyReserveThreshold) return 'reserve';
    if (used >= this.scheduler.weeklySoftThreshold) return 'soft';
    return 'normal';
  }

  _weeklyPaceState(account) {
    // Provider quota lives in separate fields — see _weeklyRawState.
    if (account.type === 'provider') return this._weeklyRawState(account);
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
    // A successful probe ends any escalation streak.
    if (this.accounts[accountIndex]?.quota) this.accounts[accountIndex].quota.consecutiveProbeFailures = 0;
    const account = this.accounts[accountIndex];
    if (!account || !usage) return;
    const q = account.quota;
    // CAPACITY LEDGER: prev stamps, so a probe observing the window ADVANCE closes
    // the old cycle (the OAuth twin of the applyProviderUsage hook).
    const prevSesReset = q.unified5hReset;
    const prevWkReset = q.unified7dReset;

    if (usage.fiveHour) {
      if (usage.fiveHour.utilization != null) q.unified5h = clamp01(usage.fiveHour.utilization);
      if (usage.fiveHour.resetAt != null) q.unified5hReset = usage.fiveHour.resetAt;
    }
    if (usage.sevenDay) {
      if (usage.sevenDay.utilization != null) q.unified7d = clamp01(usage.sevenDay.utilization);
      if (usage.sevenDay.resetAt != null) q.unified7dReset = usage.sevenDay.resetAt;
    }
    this.noteCapacityWindowAdvance(account.name, 'ses', prevSesReset, usage.fiveHour?.resetAt);
    this.noteCapacityWindowAdvance(account.name, 'wk', prevWkReset, usage.sevenDay?.resetAt);
    // Utilization readings feed the capacity ESTIMATE. The probe path passes per-window
    // marks so the DELTA method can difference consecutive readings.
    this.capacity.noteUtilizationObserved(Date.now(), [
      { name: account.name, window: 'ses', utilization: usage.fiveHour?.utilization },
      { name: account.name, window: 'wk', utilization: usage.sevenDay?.utilization },
    ]);
    // Only a SUCCESSFUL probe carrying the flag speaks to this. A header-driven update
    // can't see the limits[] array, and a FAILED read knows nothing about the account's
    // caps — either one claiming "uncapped" would mislabel a capped account as having no
    // weekly limit, which is the exact wrong direction (it reads as free capacity).
    if (!usage.error && usage.weeklyAbsent !== undefined) q.weeklyAbsent = Boolean(usage.weeklyAbsent);
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
    // ESCALATE A SYSTEMIC PROBE FAILURE. These fields were written and never read by
    // anything, so a probe failing on every call would do so in total silence.
    // (Correction: an earlier version of this comment claimed the Anthropic quota probe was
    // dead because /v1/usages and /v1/usage 404. Those are the KIMI PROVIDER endpoints
    // (src/oauth.js fetchProviderUsage). Anthropic's OAuth quota endpoint is
    // /api/oauth/usage and it is healthy — every account carries a recent lastProbeOkAt and
    // zero consecutive failures, and this escalation has never fired. The guard is still
    // worth having; the diagnosis that motivated it was wrong.)
    q.consecutiveProbeFailures = (q.consecutiveProbeFailures || 0) + 1;
    const n = q.consecutiveProbeFailures;
    // A SUSTAINED 401 is dead credentials, not a blip. Latch refreshDead so (a) the
    // prober stops re-POSTing a rejected token every 60s forever — measured 2026-08-10:
    // 8 disabled accounts each past 20 consecutive 401s, hammering Anthropic's OAuth
    // endpoint for nothing — and (b) the TUI can SHOW that the account needs re-login
    // instead of leaving the user to guess. Cleared on a successful re-auth
    // (updateAccountTokens) exactly like a refresh-path invalid_grant.
    // Three strikes, not one: a single 401 can be a transient edge/token-rotation race.
    if (status === 401 && n >= 3 && !account.refreshDead) {
      account.refreshDead = true;
      console.error(`[Maxpool] "${account.name}" credentials rejected ${n}x (HTTP 401) — marking it needs re-login. `
        + 'Re-authenticate via the TUI (a → l). Probing stops until then.');
    }
    // Once, at a threshold that cannot be a blip, then every 100th so it stays visible
    // without walling the log.
    if (n === PROBE_FAILURE_ALERT_AT || (n > PROBE_FAILURE_ALERT_AT && n % 100 === 0)) {
      console.error(`[Maxpool] Quota probe has failed ${n}x in a row for "${account.name}"`
        + `${status ? ` (HTTP ${status})` : ''}: ${q.lastProbeError}. `
        + 'Weekly quota can only be learned from upstream 429 headers until this recovers, '
        + 'so an account that has not hit a 429 will show a blank weekly.');
    }
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
    // CAPACITY LEDGER: snapshot the previous reset stamps so a probe observing the
    // window ADVANCE (new stamp) closes the capacity cycle at the old boundary —
    // covers windows whose old stamp was never learned (clock-close can't fire).
    const prevSesReset = q.providerSesReset;
    const prevWkReset = q.providerWkReset;
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
      q.weeklyAbsent = false;
    } else {
      // Weekly window absent from this plan/response — clear so a stale weekly
      // reading doesn't linger after a plan/window change. A SUCCESSFUL poll that
      // carries no weekly is positive knowledge that the plan has none: measured
      // 2026-08-06, z.ai `max` returns exactly one TOKENS_LIMIT (unit 3 = the 5h
      // session) and no unit-6 weekly, so GLM's blank Wk is correct, not a gap.
      q.providerWk = null;
      q.providerWkReset = null;
      q.weeklyAbsent = true;
    }
    q.lastProbeOkAt = Date.now();
    this.noteCapacityWindowAdvance(account.name, 'ses', prevSesReset, usage.ses?.resetAt);
    this.noteCapacityWindowAdvance(account.name, 'wk', prevWkReset, usage.wk?.resetAt);
    this.capacity.noteUtilizationObserved(Date.now(), [
      { name: account.name, window: 'ses', utilization: usage.ses?.utilization },
      { name: account.name, window: 'wk', utilization: usage.wk?.utilization },
    ]);
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

    // Utilization from RESPONSE HEADERS (every request) feeds the capacity estimate's
    // delta marks too — header-driven moves arrive far more often than probe cycles.
    const hdrU5 = parseFloat(headers['anthropic-ratelimit-unified-5h-utilization']);
    const hdrU7 = parseFloat(headers['anthropic-ratelimit-unified-7d-utilization']);
    if (!isNaN(hdrU5) || !isNaN(hdrU7)) {
      this.capacity.noteUtilizationObserved(Date.now(), [
        { name: account.name, window: 'ses', utilization: isNaN(hdrU5) ? undefined : clamp01(hdrU5) },
        { name: account.name, window: 'wk', utilization: isNaN(hdrU7) ? undefined : clamp01(hdrU7) },
      ]);
    }

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

  /** Restore the ledger from persisted state. A BOOT GAP (the open cycle's last
   *  accrual is far behind now) means maxpool was down for part of that cycle, so the
   *  cycle is no longer a truthful capacity observation — flag it partial (B2/SC6).
   *  It still displays; it is excluded from averages. */
  restoreCapacityState(payload, now = Date.now(), downtimeMs = null) {
    // Preserve the test seam across the ledger swap (fromSerialized returns a fresh
    // instance; without this the zero-floor harness override dies on any restore).
    const floorOverride = this.capacity?._readFloorOverride ?? null;
    this.capacity = CapacityLedger.fromSerialized(payload);
    this.capacity._readFloorOverride = floorOverride;
    // Partial is keyed on MAXPOOL'S OWN downtime, NEVER on the account's last request:
    // an account parked >10min mid-cycle is normal fleet rotation, and keying on its
    // last request discarded valid observations on every reload (red-team F3). The
    // caller passes measured downtime (state mtime at save → boot now); when it
    // cannot (a seamless reload handoff — the old worker was provably serving
    // throughout), null skips the check entirely.
    // 60s absorbs a restart's own turnaround; anything longer is real downtime, and
    // it disqualifies EVERY open cycle (maxpool was not serving, so no account could
    // deliver its true capacity) — the downtime is a property of the process, not of
    // any one account's traffic.
    if (!(downtimeMs > 60_000)) return;
    const spannedDays = new Set();
    for (let t = now - downtimeMs; t <= now; t += 3600_000) spannedDays.add(new Date(t).toISOString().slice(0, 10));
    spannedDays.add(new Date(now).toISOString().slice(0, 10));
    for (const name of this.capacity.accounts()) {
      if (this.capacity.openCycle(name, 'ses') || this.capacity.openCycle(name, 'wk')) {
        this.capacity.markPartial(name);
      }
      for (const day of spannedDays) this.capacity.markDayPartial(name, day);
    }
  }

  /** Accrue ONE request's tokens into the capacity ledger (per-request values; the
   *  server seam has already applied max-semantics for streamed output). */
  /** The capacity ESTIMATE for an account+window, from live utilization. Falls back
   *  to null when the vendor reports no utilization for that window (the no-weekly GLM
   *  plans), the account has not accrued, or it is already throttled. */
  capacityEstimate(accountIndex, window) {
    const a = this.accounts[accountIndex];
    if (!a) return null;
    const q = a.quota || {};
    const util = window === 'wk'
      ? (a.type === 'provider' ? q.providerWk : q.unified7d)
      : (a.type === 'provider' ? q.providerSes : q.unified5h);
    return this.capacity.estimateFromUtilization(a.name, window, util) || null;
  }

  accrueCapacity(accountIndex, { input = 0, output = 0 } = {}) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    // A no-weekly plan (z.ai legacy TOKENS_LIMIT, weeklyAbsent) has no weekly window to
    // measure, so opening a wk cycle only creates a cycle that can NEVER close — dead
    // weight that grows until the stuck-open invariant false-alarms (~12d). Session
    // window + day buckets (the 7d volume) are the real signals for such accounts.
    const windows = account.type === 'provider' && account.quota?.weeklyAbsent
      ? ['ses'] : ['ses', 'wk'];
    this.capacity.accrue(account.name, { input, output }, undefined, windows);
  }

  /** Close any window cycle whose reset time has passed — CLOCK-AUTHORITATIVE, so a
   *  stale or dead probe can never leave a cycle open and mis-attribute the next
   *  window's tokens to it (pre-mortem M5; worst case is the no-weekly account whose
   *  probe latches refreshDead). Safe to call on every render tick and prober tick. */
  closeExpiredCapacityCycles(now = Date.now()) {
    for (const a of this.accounts) {
      const q = a.quota || {};
      const pairs = a.type === 'provider'
        ? [['ses', 'providerSesReset'], ['wk', 'providerWkReset']]
        : [['ses', 'unified5hReset'], ['wk', 'unified7dReset']];
      // A no-weekly plan's wk cycle can never close (no stamp will ever arrive).
      // Retire it as an explicitly-labelled partial so it stops occupying the open slot
      // and never trips the stuck-open invariant. Reachable for cycles opened before
      // the plan was confirmed no-weekly.
      if (a.type === 'provider' && q.weeklyAbsent) {
        const wkOpen = this.capacity.openCycle(a.name, 'wk');
        if (wkOpen) {
          wkOpen.complete = false;
          wkOpen.partialReason = 'no-weekly-plan';
          this.capacity.closeCycle(a.name, 'wk', now, {});
        }
      }
      // Keep the open cycle's windowStartedAt fresh: a NEW reset stamp whose window
      // start precedes the cycle's open means we joined mid-window (the absolute
      // estimate is then only a lower bound — see the delta method).
      for (const [win, stampKey] of pairs) {
        const resetAt = q[stampKey];
        const open = this.capacity.openCycle(a.name, win);
        if (resetAt && open && open.startedAt > resetAt - WINDOW_MS_BY_KIND[win]) {
          open.windowStartedAt = resetAt - WINDOW_MS_BY_KIND[win];
        }
      }
      for (const [win, stampKey] of pairs) {
        const resetAt = q[stampKey];
        // Close ONLY. This path deliberately does NOT null the stamp: the rollover
        // stays single-shot because closeCycle FOLDS a same-boundary repeat into the
        // already-closed cycle (one boundary, one cycle), and the very next
        // refreshExpiredQuotas / request-path _clearExpiredQuotas nulls the stamp with
        // its full original side effects — the reset log, the `session` signal that
        // drives _switchOnSessionReset, and the weekly `unifiedStatus` clear. Nulling
        // here as well (round-2) made a prober-first notice silently swallow all of
        // those whenever the sweep won the race (red-team round 3, RT3-1).
        if (resetAt && now >= resetAt) {
          this.capacity.closeCycle(a.name, win, resetAt, { resetAt });
        }
      }
    }
  }

  /** Close a cycle because a probe observed the window ADVANCE (a new reset stamp) —
   *  covers the case where the old stamp was never learned. */
  noteCapacityWindowAdvance(accountName, window, prevResetAt, nextResetAt) {
    if (!prevResetAt || !nextResetAt) return;
    // TWO guards, both learned from live data (2026-08-23):
    // 1. PAST stamp = a probe that answered late (its window rolled mid-request) or
    //    vendor clock skew — honoring it closed a minutes-long "cycle" sliver. Close
    //    at NOW instead: the window genuinely rolled, just later than the stale stamp.
    // 2. JITTER: OAuth stamps derive per-response as Date.now()+delay*1000
    //    (parseResetHeader), so one boundary reads ~2s later on every response; a
    //    bare `>` comparison shredded one real 5h window into 9-10 fake cycles and
    //    dated a "weekly" cycle a week into the future. A real advance moves a whole
    //    window (>=5h) — the 60s epsilon separates it by three orders of magnitude.
    //    Provider stamps (z.ai/Kimi probe) are absolute and never jitter.
    const nowMs = Date.now();
    // A close can never be dated in the FUTURE. An advance stamp legitimately points
    // at the NEW window's reset (a fresh 5h away) — that is evidence the OLD window
    // rolled, not the moment it rolled. Close at NOW (live 2026-08-23: a 3,658-token
    // cycle was recorded as endedAt 4.9h in the future; the invariant checker caught
    // it minutes later). `min` also floors the late-probe case (a stamp already
    // expired) — endedAt is always within [start, now].
    const boundary = Math.min(nextResetAt, nowMs);
    if (boundary - prevResetAt < WINDOW_ADVANCE_EPSILON_MS) return;
    this.capacity.closeCycle(accountName, window, boundary, { resetAt: prevResetAt });
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

    // A DISABLED account never spends its single-use refresh token. The prober still
    // READS its quota by design (you disable an exhausted account and still want to
    // watch it recover — prober.js:73), but rotation is a WRITE that can permanently
    // brick the account: each rotation invalidates the previous token, so a refresh
    // that races a restart (or another writer) loses the new token and the account
    // dies with invalid_grant. Spending that risk on an account the user has
    // explicitly benched is never worth it — it serves its existing access token for
    // read-only probing, and re-enabling refreshes on the next real request.
    // `force` still wins: an explicit re-auth/enable path may need the rotation.
    if (!force && account.enabled === false) return true;

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
      configSourced: Boolean(acctData.configSourced),
      secretName: acctData.secretName || null,
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
      // Onboarding clock for the warmup-pull — set ONLY here (mid-session add),
      // never on the boot/config construction path, so an established fleet account
      // is never "warming". Lets a just-added account draw load without a reload.
      addedAt: Date.now(),
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
    if (acctData.configSourced !== undefined) account.configSourced = acctData.configSourced;
    if (acctData.secretName !== undefined) account.secretName = acctData.secretName;
    // Restore path carries an explicit enabled (persisted disable); honor it. The `cc
    // all` header path (prepareRuntimeProviders) omits enabled, so a re-sent token
    // NEVER silently re-enables a provider the user benched in the TUI.
    if (acctData.enabled !== undefined) account.enabled = acctData.enabled !== false;
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
      .filter(a => a.runtime && a.type === 'provider' && a.credential && !a.configSourced)
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
        // Persist the user's enable/disable so a provider they benched in the TUI stays
        // benched across a restart — without this an intentionally-disabled GLM/Kimi
        // silently comes back enabled on the next boot (restore defaults enabled:true).
        enabled: a.enabled,
      }));
  }

  /**
   * Restore persisted runtime providers on boot, via the SAME upsert the header
   * path uses (so a restored provider is byte-identical to a header-created one). A
   * live `cc all` request refreshes the token before routing (prepareRuntimeProviders
   * runs ahead of account selection), so a stale restored token never serves a
   * request. Idempotent — upsertRuntimeAccount matches by name.
   *
   * Config-sourced providers (resolved from GCP Secret Manager at startup) are
   * EXCLUDED — their source of truth is config + GCP, not state.json, so persisting
   * their token to disk would duplicate the secret and survive a GCP deletion.
   */
  restoreRuntimeProviders(list) {
    if (!Array.isArray(list)) return;
    for (const p of list) {
      if (!p || !p.name || !(p.authToken || p.credential)) continue;
      this.upsertRuntimeAccount({ ...p, authToken: p.authToken || p.credential });
    }
  }

  /**
   * Load config-sourced provider accounts — resolved from GCP Secret Manager at
   * startup, NOT from per-request headers. Each config entry is { name, provider,
   * secretName, upstream?, priority?, modelMap? }. The secret is resolved by the
   * caller (index.js) and passed as `token`; if null the provider is created but
   * marked error so the TUI shows WHY it's broken.
   *
   * These are marked configSourced so they're excluded from state.json persistence
   * (their source of truth is config + GCP, not disk) and so the header path can
   * dedup against them (same token → skip creating a duplicate runtime provider).
   */
  loadConfigProviders(entries) {
    if (!Array.isArray(entries)) return;
    // Remove existing config-sourced providers that are no longer in the config
    // (handles a config edit that removes an entry).
    const wantedNames = new Set(entries.map(e => e.name).filter(Boolean));
    // Iterate a COPY: removeAccount splices this.accounts, and splicing the array
    // being iterated makes the loop skip the element after each removal — so
    // dropping 2 of 3 config providers left one phantom behind.
    for (const a of [...this.accounts]) {
      if (a.configSourced && !wantedNames.has(a.name)) {
        const idx = this.accounts.indexOf(a);
        if (idx >= 0 && this.accounts[idx].inFlight === 0) this.removeAccount(idx);
      }
    }
    // Remove state-restored (header-based) providers whose token is now served by a
    // config provider — otherwise the same key shows up twice (once as the old
    // "glm-fallback"/"kimi-fallback" from state.json, once as the config provider).
    const configTokens = new Set(
      entries.map(e => e.token).filter(Boolean),
    );
    for (const a of [...this.accounts]) {
      if (!a.configSourced && a.type === 'provider' && a.credential && configTokens.has(a.credential)) {
        const idx = this.accounts.indexOf(a);
        if (idx >= 0 && this.accounts[idx].inFlight === 0) this.removeAccount(idx);
      }
    }
    for (const entry of entries) {
      if (!entry || !entry.name || !entry.provider) continue;
      // Default model maps — match what `cc all` sends via headers. Users can override
      // per-provider in config. Without these z.ai returns [1210 Invalid API parameter].
      const defaultModelMap = entry.provider === 'zai'
        ? { opus: 'glm-5.3', sonnet: 'glm-5.3', haiku: 'glm-5.3', default: 'glm-5.3' }
        : null;
      const defaultModel = entry.provider === 'kimi' ? 'kimi-k3' : null;
      this.upsertRuntimeAccount({
        name: entry.name,
        type: 'provider',
        provider: entry.provider,
        authToken: entry.token || null,
        upstream: entry.upstream || (entry.provider === 'kimi'
          ? 'https://api.kimi.com/coding'
          : 'https://api.z.ai/api/anthropic'),
        authHeader: 'authorization',
        profiles: ['all'],
        priority: Number.isFinite(entry.priority) ? entry.priority : 10,
        modelMap: entry.modelMap || defaultModelMap,
        model: entry.model || defaultModel,
        stripBetaHeaders: true,
        configSourced: true,
        // An explicitly-disabled provider in config stays benched across restarts —
        // a second GLM account you keep configured but off (a teammate's, a spare).
        enabled: entry.enabled !== false,
      });
      if (!entry.token) {
        const a = this.accounts.find(a => a.name === entry.name);
        if (a) { a.status = 'error'; a.lastError = 'secret-unresolved'; }
      }
    }
  }

  /**
   * Return the config-sourced provider definitions (name + provider + secretName)
   * for the TUI and for config serialization. Tokens are NEVER included.
   */
  configProviderDefs() {
    return this.accounts
      .filter(a => a.configSourced && a.type === 'provider')
      .map(a => ({
        name: a.name,
        provider: a.provider,
        secretName: a.secretName || null,
        upstream: a.upstream,
        priority: a.priority,
      }));
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
      // The version whose CODE is EXECUTING. `version.current` is a package.json DISK
      // read, so after a self-install (or on an npm-link'd checkout) it reports the
      // newest INSTALLED build, not the running one — a post-deploy check keyed on it
      // verifies the wrong thing (measured 2026-08-23: reported 1.8.7 while executing
      // 1.8.6). This field is the one to assert on.
      runningVersion: this.runningVersion || null,
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
        peak: this.peakSummary(),
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
        largeContextPinned: [...this.sessionPolicies.values()].filter(p => p.largeContext).length,
      },
    };
  }
}
