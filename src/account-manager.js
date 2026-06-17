import { refreshAccessToken, isTokenExpiringSoon } from './oauth.js';

function emptyQuota() {
  return {
    // Standard API rate limits (API key accounts)
    tokensLimit: null,
    tokensRemaining: null,
    requestsLimit: null,
    requestsRemaining: null,
    // Unified rate limits (Claude Max accounts)
    unified5h: null,       // utilization 0-1
    unified7d: null,       // utilization 0-1
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
};

function clampRetryAfterSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 60;
  return Math.min(Math.max(Math.ceil(n), 1), 24 * 60 * 60);
}

export class AccountManager {
  constructor(accounts, switchThreshold = 0.90, schedulerOptions = {}) {
    this.scheduler = { ...DEFAULT_SCHEDULER, ...schedulerOptions };
    this.accounts = accounts.map((acct, index) => ({
      index,
      name: acct.name,
      type: acct.type,
      accountUuid: acct.accountUuid || null,
      credential: acct.accessToken || acct.apiKey,
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
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      cooldownUntil: null,
      rateLimitedUntil: null,
    }));
    this.currentIndex = 0;
    this.nextIndex = 0;
    this.switchThreshold = switchThreshold;
  }

  /**
   * Get the best available account, rotating if the current one is near quota.
   * Returns null if all accounts are exhausted.
   */
  getActiveAccount(requestInfo = {}, excludedIndexes = new Set()) {
    this.refreshExpiredQuotas();
    return this._selectNext(requestInfo, excludedIndexes);
  }

  acquireAccount(requestInfo = {}, excludedIndexes = new Set()) {
    const account = this.getActiveAccount(requestInfo, excludedIndexes);
    if (!account) return null;

    const weight = Math.max(1, Number(requestInfo.weight) || 1);
    account.inFlight++;
    account.activeWeight += weight;
    account.lastUsedAt = Date.now();
    return { account, weight, startedAt: Date.now() };
  }

  releaseAccount(lease, outcome = {}) {
    if (!lease?.account) return;
    const account = this.accounts[lease.account.index];
    if (!account) return;

    account.inFlight = Math.max(0, account.inFlight - 1);
    account.activeWeight = Math.max(0, account.activeWeight - lease.weight);

    if (outcome.success) {
      account.completedRequests++;
      account.consecutiveFailures = 0;
      account.lastSuccessAt = Date.now();
      return;
    }

    if (outcome.error || outcome.status) {
      account.failedRequests++;
      account.consecutiveFailures++;
      account.lastError = outcome.error || `HTTP ${outcome.status}`;
      account.lastErrorAt = Date.now();
    }
  }

  _isAvailable(account) {
    if (!account) return false;
    const now = Date.now();

    // Check rate limit expiry
    if (account.status === 'throttled' && account.rateLimitedUntil) {
      if (now < account.rateLimitedUntil) return false;
      account.status = 'active';
      account.rateLimitedUntil = null;
      console.log(`[TeamClaude] Account "${account.name}" rate limit expired, marking active`);
    }

    if (account.cooldownUntil) {
      if (now < account.cooldownUntil) return false;
      account.cooldownUntil = null;
    }

    if (account.inFlight >= this.scheduler.safetyMaxActivePerAccount) return false;
    if (this.getGlobalInFlight() >= this.scheduler.safetyMaxGlobalActive) return false;
    if (account.status === 'exhausted' || account.status === 'error') return false;
    if (this._isNearQuota(account)) return false;

    return true;
  }

  getGlobalInFlight() {
    return this.accounts.reduce((sum, account) => sum + account.inFlight, 0);
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
      console.log(`[TeamClaude] Account "${account.name}" session quota reset`);
      q.unified5h = null;
      q.unified5hReset = null;
      changed = true;
      session = true;
    }
    if (q.unified7d != null && q.unified7dReset && now >= q.unified7dReset) {
      console.log(`[TeamClaude] Account "${account.name}" weekly quota reset`);
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
      if (!this._isAvailable(acc)) continue; // enough session & weekly quota left
      const weekly = acc.quota.unified7dReset;
      if (weekly == null) continue; // need a known weekly to compare
      if (weekly < bestWeekly) {
        bestWeekly = weekly;
        best = acc;
      }
    }

    if (best) {
      this.currentIndex = best.index;
      console.log(`[TeamClaude] Account "${best.name}" session quota reset and weekly expires sooner — switching to it`);
    }
  }

  _isNearQuota(account) {
    const q = account.quota;
    this._clearExpiredQuotas(account);

    // Unified quotas (Claude Max) — utilization is already 0-1
    if (q.unified5h != null && q.unified5h >= this.switchThreshold) return true;
    if (q.unified7d != null && q.unified7d >= this.switchThreshold) return true;

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

  _selectNext(requestInfo = {}, excludedIndexes = new Set()) {
    // Adaptive least-loaded balancing: spread requests across every healthy
    // account immediately, and let live load, quota pressure, and recent errors
    // push traffic away from weaker accounts.
    let best = null;
    let bestScore = Infinity;

    for (let i = 0; i < this.accounts.length; i++) {
      const idx = (this.nextIndex + i) % this.accounts.length;
      const account = this.accounts[idx];
      if (excludedIndexes.has(account.index)) continue;
      if (!this._isAvailable(account)) continue;

      const score = this._scoreAccount(account, requestInfo);
      if (score < bestScore) {
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
        console.log(`[TeamClaude] Switched to account "${best.name}"`);
      }
      return best;
    }

    // All accounts unavailable — find the one that resets soonest
    let soonestAccount = null;
    let soonestTime = Infinity;

    for (const account of this.accounts) {
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
      console.log(`[TeamClaude] Account "${soonestAccount.name}" reset, switching to it`);
      return soonestAccount;
    }

    return null;
  }

  _scoreAccount(account, requestInfo = {}) {
    const quotaPressure = this._quotaPressure(account) * 10;
    const failurePenalty = account.consecutiveFailures * 5;
    const unknownQuotaBonus = account.quota.unified7dReset == null ? -0.25 : 0;
    return account.activeWeight + (requestInfo.weight || 1) + quotaPressure + failurePenalty + unknownQuotaBonus;
  }

  _quotaPressure(account) {
    const q = account.quota;
    const values = [];
    if (q.unified5h != null) values.push(q.unified5h);
    if (q.unified7d != null) values.push(q.unified7d);
    if (q.tokensLimit != null && q.tokensRemaining != null && q.tokensLimit > 0) {
      values.push(1 - q.tokensRemaining / q.tokensLimit);
    }
    if (q.requestsLimit != null && q.requestsRemaining != null && q.requestsLimit > 0) {
      values.push(1 - q.requestsRemaining / q.requestsLimit);
    }
    return values.length ? Math.max(...values) : 0;
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
    if (!isNaN(u5h)) account.quota.unified5h = u5h;
    if (!isNaN(u7d)) account.quota.unified7d = u7d;

    const r5h = headers['anthropic-ratelimit-unified-5h-reset'];
    const r7d = headers['anthropic-ratelimit-unified-7d-reset'];
    if (r5h) account.quota.unified5hReset = parseInt(r5h, 10) * 1000;
    if (r7d) account.quota.unified7dReset = parseInt(r7d, 10) * 1000;

    // We switched to this account to discover its weekly quota; now that we
    // know it, flag for re-evaluation so selection can pick the best account.
    if (account.probing && account.quota.unified7dReset != null) {
      account.probing = false;
      account.requalify = true;
      console.log(`[TeamClaude] Learned weekly quota for "${account.name}", re-evaluating selection`);
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

    account.usage.totalRequests++;
    account.usage.lastUsed = new Date().toISOString();

    // Log when approaching quota
    if (this._isNearQuota(account)) {
      const pct = account.quota.unified7d != null
        ? (account.quota.unified7d * 100).toFixed(1)
        : account.quota.tokensLimit
          ? ((1 - account.quota.tokensRemaining / account.quota.tokensLimit) * 100).toFixed(1)
          : '?';
      console.log(`[TeamClaude] Account "${account.name}" at ${pct}% usage — will switch on next request`);
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
  markRateLimited(accountIndex, retryAfterSeconds) {
    const account = this.accounts[accountIndex];
    if (!account) return;
    const retryAfter = clampRetryAfterSeconds(retryAfterSeconds);
    account.status = 'throttled';
    account.rateLimitedUntil = Date.now() + (retryAfter * 1000);
    account.lastError = 'rate_limited';
    account.lastErrorAt = Date.now();
    account.consecutiveFailures++;
    console.log(`[TeamClaude] Account "${account.name}" rate limited for ${retryAfter}s`);
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
    console.log(`[TeamClaude] Account "${account.name}" cooling down for ${Math.ceil(cooldown / 1000)}s after ${reason}`);
  }

  /**
   * Ensure an OAuth account's token is fresh, refreshing if needed.
   * Pass force=true to refresh regardless of expiry (e.g. after a 401).
   * Concurrent calls for the same account coalesce into a single refresh.
   */
  async ensureTokenFresh(accountIndex, force = false) {
    const account = this.accounts[accountIndex];
    if (!account || account.type !== 'oauth' || !account.refreshToken) return;

    if (!force && !isTokenExpiringSoon(account.expiresAt)) return;

    // Coalesce concurrent refreshes
    if (account._refreshPromise) return account._refreshPromise;

    account._refreshPromise = (async () => {
      console.log(`[TeamClaude] Refreshing token for account "${account.name}"...`);
      try {
        const newTokens = await refreshAccessToken(account.refreshToken);
        account.credential = newTokens.accessToken;
        account.refreshToken = newTokens.refreshToken;
        account.expiresAt = newTokens.expiresAt;
        console.log(`[TeamClaude] Token refreshed for account "${account.name}"`);
        this._onTokenRefresh?.(accountIndex, newTokens);
      } catch (err) {
        console.error(`[TeamClaude] Token refresh failed for "${account.name}": ${err.message}`);
        // Only mark as error if the access token is actually expired;
        // a failed proactive refresh shouldn't kill a still-valid token
        if (!account.expiresAt || Date.now() >= account.expiresAt) {
          account.status = 'error';
        }
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
    console.log(`[TeamClaude] Updated tokens for account "${account.name}"`);
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
      accountUuid: acctData.accountUuid || null,
      credential: acctData.accessToken || acctData.apiKey,
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
      consecutiveFailures: 0,
      lastError: null,
      lastErrorAt: null,
      cooldownUntil: null,
      rateLimitedUntil: null,
    });
    return index;
  }

  /**
   * Remove an account by index.
   */
  removeAccount(index) {
    if (index < 0 || index >= this.accounts.length) return;
    this.accounts.splice(index, 1);
    this.accounts.forEach((a, i) => a.index = i);
    if (this.currentIndex >= this.accounts.length) {
      this.currentIndex = Math.max(0, this.accounts.length - 1);
    } else if (this.currentIndex > index) {
      this.currentIndex--;
    }
  }

  /**
   * Return a status summary of all accounts (safe to expose, no credentials).
   */
  getStatus() {
    return {
      currentAccount: this.accounts[this.currentIndex]?.name,
      switchThreshold: this.switchThreshold,
      accounts: this.accounts.map(a => ({
        name: a.name,
        type: a.type,
        status: a.status,
        inFlight: a.inFlight,
        activeWeight: a.activeWeight,
        completedRequests: a.completedRequests,
        failedRequests: a.failedRequests,
        consecutiveFailures: a.consecutiveFailures,
        lastError: a.lastError,
        lastErrorAt: a.lastErrorAt ? new Date(a.lastErrorAt).toISOString() : null,
        cooldownUntil: a.cooldownUntil ? new Date(a.cooldownUntil).toISOString() : null,
        quota: { ...a.quota },
        usage: { ...a.usage },
        rateLimitedUntil: a.rateLimitedUntil
          ? new Date(a.rateLimitedUntil).toISOString()
          : null,
      })),
      scheduler: {
        mode: 'adaptive-least-loaded',
        globalInFlight: this.getGlobalInFlight(),
        safetyMaxActivePerAccount: this.scheduler.safetyMaxActivePerAccount,
        safetyMaxGlobalActive: this.scheduler.safetyMaxGlobalActive,
      },
    };
  }
}
