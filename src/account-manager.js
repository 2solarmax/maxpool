import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

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
    unifiedStatus: null,   // allowed | allowed_warning | rejected
    resetsAt: null,
  };
}

const DEFAULT_SCHEDULER = {
  safetyMaxActivePerAccount: 50,
  safetyMaxGlobalActive: 150,
  cooldownMs: 30_000,
  maxCooldownMs: 15 * 60_000,
  weeklySoftThreshold: 0.65,
  weeklyReserveThreshold: 0.85,
  weeklyCriticalThreshold: 0.95,
  weeklyExhaustedThreshold: 0.985,
  weeklyBurnDebtWeight: 0.6,
  // Routing-cost tuning (lower cost = preferred). Quota scarcity is the primary
  // signal; recent-load spread breaks ties between equally-scarce accounts so
  // sequential traffic rotates instead of funnelling onto one account.
  scarcityWeight: 6,          // multiplies quota scarcity (pace overage, 0..~1)
  spreadShareWeight: 3,       // multiplies an account's share of recent fleet load (0..1)
  recoveryRampWeight: 4,      // decaying penalty applied to a just-recovered account
  recoveryRampMs: 5 * 60_000, // how long the post-recovery ramp lasts
  spreadWindowMs: 15 * 60_000,// rolling window used to measure recent per-account load
};
const LOAD_EVENT_MAX_AGE_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const FIVE_HOUR_MS = 5 * 60 * 60 * 1000;

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
    };
    this.admissionPaused = false;
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
    let matchingRoutes = 0;
    const reasons = {};

    const note = reason => {
      reasons[reason] = (reasons[reason] || 0) + 1;
    };

    for (const account of this.accounts) {
      if (excludedIndexes.has(account.index)) continue;
      if (!this._matchesRequest(account, profile, requestInfo)) {
        if (account.type === 'provider' && this._requiresAnthropicThinkingIntegrity(requestInfo)) {
          note('provider_fallback_disabled_signed_thinking');
        }
        continue;
      }

      matchingRoutes++;
      if (this._isAvailable(account, { allowWeeklyReserve: true })) {
        return {
          available: true,
          retryAfterMs: 0,
          cause: 'available',
          reasons,
          matchingRoutes,
        };
      }

      const retry = this._retryInfo(account);
      note(retry.cause);
      if (retry.cause === 'weekly_critical' && this._isAvailable(account, { allowWeeklyReserve: true, allowWeeklyCritical: true })) {
        return {
          available: true,
          retryAfterMs: 0,
          cause: 'weekly_critical_last_resort',
          reasons,
          matchingRoutes,
        };
      }
      if (retry.queueable && retry.retryAt) {
        const ms = retry.retryAt - Date.now();
        if (ms < soonestTemporary) {
          soonestTemporary = ms;
          temporaryCause = retry.cause;
        }
      } else if (retry.cause === 'weekly_exhausted' && retry.retryAt) {
        const ms = retry.retryAt - Date.now();
        if (ms < soonestWeekly) soonestWeekly = ms;
      }
    }

    if (Number.isFinite(soonestTemporary)) {
      return {
        available: false,
        retryAfterMs: Math.max(0, soonestTemporary),
        cause: temporaryCause || 'temporary_unavailable',
        reasons,
        matchingRoutes,
      };
    }

    if (Number.isFinite(soonestWeekly)) {
      return {
        available: false,
        retryAfterMs: Math.max(0, soonestWeekly),
        cause: 'weekly_exhausted',
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
      return this._isAvailable(account, options);
    }));
  }

  acquireAccount(requestInfo = {}, excludedIndexes = new Set()) {
    this._noteRequestPolicy(requestInfo);
    const account = this.getActiveAccount(requestInfo, excludedIndexes);
    if (!account) return null;

    const weight = Math.max(1, Number(requestInfo.weight) || 1);
    const upstreamThrottleProbe = account.type !== 'provider' && this._claimUpstreamThrottleProbe();
    if (requestInfo.sessionKey) {
      this._bindSession(requestInfo.sessionKey, account);
    }
    account.inFlight++;
    account.activeWeight += weight;
    account.lastUsedAt = Date.now();
    return { account, weight, startedAt: Date.now(), upstreamThrottleProbe };
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
    const weeklyState = this._weeklyState(account);
    if (weeklyState === 'exhausted') return false;
    if (weeklyState === 'critical' && !options.allowWeeklyCritical) return false;
    if (weeklyState === 'reserve' && !options.allowWeeklyReserve) return false;

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

  noteAmbiguousRateLimit(accountIndex, fingerprint, retryAfterSeconds) {
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

  registerQueuedRequest(requestInfo = {}) {
    if (requestInfo.queueTicket) return requestInfo.queueTicket;
    const ticket = {
      id: this.queueState.nextId++,
      queuedAt: Date.now(),
    };
    this.queueState.waiting.push(ticket);
    requestInfo.queueTicket = ticket;
    return ticket;
  }

  canAdmitQueuedRequest(requestInfo = {}) {
    const ticket = requestInfo.queueTicket;
    if (!ticket) return true;
    if (this.queueState.waiting[0]?.id !== ticket.id) return false;
    const now = Date.now();
    if (now < this.queueState.rampUntil && now - this.queueState.lastAdmissionAt < 250) return false;
    this.queueState.waiting.shift();
    this.queueState.lastAdmissionAt = now;
    requestInfo.queueTicket = null;
    requestInfo.queueAdmitted = true;
    return true;
  }

  removeQueuedRequest(requestInfo = {}) {
    const ticket = requestInfo.queueTicket;
    if (!ticket) return;
    const index = this.queueState.waiting.findIndex(entry => entry.id === ticket.id);
    if (index >= 0) this.queueState.waiting.splice(index, 1);
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
    const sessionReset = [];
    for (const account of this.accounts) {
      const r = this._clearExpiredQuotas(account);
      if (r.changed) changed = true;
      if (r.session) sessionReset.push(account);
    }
    if (sessionReset.length) this._switchOnSessionReset(sessionReset);
    return changed;
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
    return this._isSessionQuotaUnavailable(account)
      || ['reserve', 'critical', 'exhausted'].includes(this._weeklyState(account));
  }

  _retryInfo(account) {
    const now = Date.now();
    const q = account.quota || {};
    const weeklyState = this._weeklyState(account);
    if (weeklyState === 'critical') {
      return { cause: 'weekly_critical', retryAt: q.unified7dReset || null, queueable: false };
    }

    if (weeklyState === 'exhausted') {
      return { cause: 'weekly_exhausted', retryAt: q.unified7dReset || null, queueable: false };
    }

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

    if (!account.enabled) return { cause: 'disabled', retryAt: null, queueable: false };
    if (account.status === 'error') return { cause: 'error', retryAt: null, queueable: false };
    if (account.status === 'exhausted') return { cause: 'exhausted', retryAt: null, queueable: false };
    return { cause: 'unavailable', retryAt: null, queueable: false };
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

    const hasBinding = Boolean(requestInfo.sessionKey && this.sessionBindings.has(requestInfo.sessionKey));
    const preferred = this._preferredAccount(profile, excludedIndexes, requestInfo);
    if (preferred) {
      const preferredPasses = [
        { allowWeeklyReserve: true, allowWeeklyCritical: false },
        { allowWeeklyReserve: true, allowWeeklyCritical: true },
      ];
      if (preferredPasses.some(options => this._isAvailable(preferred, options))) {
        this.currentIndex = preferred.index;
        return preferred;
      }
    }
    const bound = this._boundAccount(requestInfo.sessionKey, profile, excludedIndexes, requestInfo);
    if (bound && !this._hasHigherPriorityAvailable(bound, profile, excludedIndexes, requestInfo)) return bound;

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

    for (const weeklyOptions of weeklyPasses) {
      best = null;
      bestScore = Infinity;
      bestPriority = Infinity;

      for (let i = 0; i < this.accounts.length; i++) {
        const idx = (this.nextIndex + i) % this.accounts.length;
        const account = this.accounts[idx];
        if (excludedIndexes.has(account.index)) continue;
        if (!this._matchesRequest(account, profile, requestInfo)) continue;
        if (!this._isAvailable(account, weeklyOptions)) continue;

        const priority = Number.isFinite(account.priority) ? account.priority : 0;
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
    if (!this._isAvailable(account, options)) return null;
    return account;
  }

  _bindSession(sessionKey, account) {
    const priority = this._priority(account);
    const binding = this._sessionBinding(sessionKey) || {
      homeName: account.name,
      homePriority: priority,
      currentName: account.name,
    };

    if (!binding.homeName || priority < binding.homePriority) {
      binding.homeName = account.name;
      binding.homePriority = priority;
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
      return priority < boundPriority && this._isAvailable(account, { allowWeeklyReserve: true });
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

  _isRequestCompatible(account, profile, requestInfo = {}) {
    if (!this._matchesProfile(account, profile)) return false;
    if (account.type === 'provider' && this._requiresAnthropicThinkingIntegrity(requestInfo)) return false;
    return true;
  }

  _noteRequestPolicy(requestInfo = {}) {
    if (!requestInfo.sessionKey || !requestInfo.requiresAnthropicThinkingIntegrity) return;
    this.markSessionThinkingProtected(requestInfo.sessionKey, requestInfo.model);
  }

  markSessionThinkingProtected(sessionKey, model = null) {
    if (!sessionKey) return;
    const existing = this.sessionPolicies.get(sessionKey) || {};
    if (!existing.requiresAnthropicThinkingIntegrity) {
      console.log(`[Maxpool] Session "${sessionKey}" contains Anthropic signed thinking; provider fallback disabled`);
    }
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
    const concurrency = account.activeWeight + reqWeight;
    const scarcity = this._accountScarcity(account, now) * this.scheduler.scarcityWeight;

    const fleetRecentWeight = ctx?.fleetRecentWeight ?? 0;
    const recentWeight = this._loadSummary(account, this.scheduler.spreadWindowMs, now).weight;
    const share = fleetRecentWeight > 0 ? recentWeight / fleetRecentWeight : 0;
    const spread = share * this.scheduler.spreadShareWeight;

    const ramp = this._recoveryRamp(account, now);
    const failurePenalty = account.consecutiveFailures * 5;
    // Bias toward an account whose weekly quota is still unknown so it gets
    // probed and learned (matches the legacy unknown-quota exploration nudge).
    const explorationBonus = account.quota.unified7dReset == null ? -0.5 : 0;

    return concurrency + scarcity + spread + ramp + failurePenalty + explorationBonus;
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

  _weeklyRawState(account) {
    const q = account.quota;
    this._clearExpiredQuotas(account);
    if (q.unifiedStatus === 'rejected') return 'exhausted';
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
    if (uStatus) account.quota.unifiedStatus = uStatus;

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

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      const reason = this._isSessionQuotaUnavailable(account) ? 'session quota' : `weekly ${this._weeklyState(account)}`;
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

  markTransientFailure(accountIndex, reason = 'transient_error') {
    const account = this.accounts[accountIndex];
    if (!account) return;
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
      if (this._weeklyState(account) === 'exhausted') continue;
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

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return true;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[Maxpool] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await this._refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        account.status = 'active';
        account.cooldownUntil = null;
        console.log(`[Maxpool] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
        return true;
      } catch (err) {
        console.error(`[Maxpool] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          if (err.retryable) {
            this.markTransientFailure(accountIndex, `token_refresh_${err.status || 'network'}`);
          } else {
            this.markAuthFailed(accountIndex, err.status || 401, 'token_refresh_failed');
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
    }
    return idx;
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

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    const now = Date.now();
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      routing: {
        mode: this.routingMode,
        preferredAccount: this.preferredAccountName,
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
      },
    };
  }
}
