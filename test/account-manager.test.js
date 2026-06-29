import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function manager(count = 3) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`,
      type: 'oauth',
      accessToken: `t${i + 1}`,
      refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

test('adaptive scheduler distributes concurrent leases across healthy accounts', () => {
  const am = manager(3);
  const leases = [];

  for (let i = 0; i < 15; i++) {
    leases.push(am.acquireAccount({ weight: 1 }));
  }

  assert.deepEqual(
    am.accounts.map(a => a.inFlight),
    [5, 5, 5],
  );

  for (const lease of leases) am.releaseAccount(lease, { success: true });
  assert.deepEqual(am.accounts.map(a => a.inFlight), [0, 0, 0]);
});

test('preferred routing uses selected account, fails over, and returns after recovery', () => {
  const am = manager(3);
  am.setRoutingMode('preferred', 'a2');

  const preferred = am.acquireAccount({ profile: 'claude' });
  assert.equal(preferred.account.name, 'a2');
  am.releaseAccount(preferred, { success: true, status: 200 });

  am.markRateLimited(1, 60);
  const fallback = am.acquireAccount({ profile: 'claude' });
  assert.notEqual(fallback.account.name, 'a2');
  am.releaseAccount(fallback, { success: true, status: 200 });

  am.accounts[1].rateLimitedUntil = Date.now() - 1;
  const recovered = am.acquireAccount({ profile: 'claude' });
  assert.equal(recovered.account.name, 'a2');
});

test('disabled account is excluded without being removed', () => {
  const am = manager(2);
  am.setAccountEnabled(0, false);

  assert.equal(am.accounts.length, 2);
  assert.equal(am.accounts[0].enabled, false);
  assert.equal(am.acquireAccount({ profile: 'claude' }).account.name, 'a2');
});

test('disabling an in-flight account survives its late successful response', () => {
  const am = manager(2);
  const lease = am.acquireAccount({ profile: 'claude' });
  am.setAccountEnabled(lease.account.index, false);
  am.releaseAccount(lease, { success: true, status: 200 });

  assert.equal(lease.account.enabled, false);
  assert.notEqual(am.acquireAccount({ profile: 'claude' }).account.name, lease.account.name);
});

test('active lease releases correctly after an earlier idle account is removed', () => {
  const am = manager(3);
  am.setRoutingMode('preferred', 'a3');
  const lease = am.acquireAccount({ profile: 'claude' });

  assert.equal(lease.account.name, 'a3');
  assert.equal(am.removeAccount(0), true);
  am.releaseAccount(lease, { success: true, status: 200 });

  assert.equal(lease.account.inFlight, 0);
  assert.equal(lease.account.completedRequests, 1);
});

test('scheduler skips throttled accounts and resumes them after retry window', () => {
  const am = manager(2);
  am.markRateLimited(0, 60);

  const lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a2');
  am.releaseAccount(lease, { success: true });

  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  const laterLeases = Array.from({ length: 8 }, () => am.acquireAccount({ weight: 1 }));
  assert.ok(laterLeases.some(l => l.account.name === 'a1'));
});

test('shared upstream throttle allows one recovery probe and self-clears on success', () => {
  const am = manager(2);
  am.markUpstreamThrottled(60, 'temporary server limit');
  assert.equal(am.acquireAccount({ weight: 1 }), null);
  assert.equal(am.nextRetryForRequest().cause, 'upstream_throttle');

  am.upstreamThrottle.until = Date.now() - 1;
  const probe = am.acquireAccount({ weight: 1 });
  assert.ok(probe);
  assert.equal(probe.upstreamThrottleProbe, true);
  assert.equal(am.acquireAccount({ weight: 1 }), null);
  assert.equal(am.nextRetryForRequest().cause, 'upstream_probe');

  am.releaseAccount(probe, { success: true, status: 200 });
  assert.equal(am.getStatus().upstreamThrottle.active, false);
  assert.ok(am.acquireAccount({ weight: 1 }));
});

test('recent Claude success vetoes request-wide 529 promotion', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
    { name: 'a2', type: 'oauth', accessToken: 't2' },
  ]);
  const firstAt = Date.now();
  am.accounts[1].lastSuccessAt = firstAt + 1;
  assert.equal(am.shouldPromoteUpstreamFailure({
    accounts: new Set([0, 1]),
    firstAt,
  }, { profile: 'claude' }), false);
});

test('untried eligible Claude account vetoes request-wide 529 promotion', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
    { name: 'a2', type: 'oauth', accessToken: 't2' },
    { name: 'a3', type: 'oauth', accessToken: 't3' },
  ]);
  assert.equal(am.shouldPromoteUpstreamFailure({
    accounts: new Set([0, 1]),
    firstAt: Date.now(),
  }, { profile: 'claude' }), false);
});

test('provisional overload telemetry clears when cooldown expires', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
  ]);
  am.markProvisionalUpstreamFailure(0, 529, 'fingerprint', 1);
  am.accounts[0].provisionalUpstreamUntil = Date.now() - 1;
  assert.equal(am.hasAvailableRoute({ profile: 'claude' }), true);
  assert.equal(am.accounts[0].lastError, null);
  assert.equal(am.accounts[0].provisionalUpstreamFingerprint, null);
});

test('queued work does not hide an untried Claude account from promotion checks', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
    { name: 'a2', type: 'oauth', accessToken: 't2' },
    { name: 'a3', type: 'oauth', accessToken: 't3' },
  ]);
  am.queueState.waiting.push({ id: 1 });
  assert.equal(am.shouldPromoteUpstreamFailure({
    accounts: new Set([0, 1]),
    firstAt: Date.now(),
  }, { profile: 'claude' }), false);
});

test('promotion cleanup preserves an unrelated transient cooldown', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
  ], 0.90, { cooldownMs: 30_000 });
  am.markProvisionalUpstreamFailure(0, 529, 'fingerprint', 10);
  am.markTransientFailure(0, 'HTTP 503');
  const transientCooldown = am.accounts[0].cooldownUntil;
  am.clearProvisionalUpstreamFailures('fingerprint', new Set([0]));
  assert.equal(am.accounts[0].cooldownUntil, transientCooldown);
  assert.equal(am.accounts[0].provisionalUpstreamUntil, null);
});

test('accepted Claude response vetoes promotion before its stream finishes', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1' },
    { name: 'a2', type: 'oauth', accessToken: 't2' },
  ]);
  const firstAt = Date.now();
  am.markUpstreamAccepted(1);
  assert.equal(am.shouldPromoteUpstreamFailure({
    accounts: new Set([0, 1]),
    firstAt: firstAt - 1,
  }, { profile: 'claude' }), false);
});

test('shared upstream throttle re-arms when recovery probe is throttled again', () => {
  const am = manager(2);
  am.markUpstreamThrottled(60, 'temporary server limit');
  am.upstreamThrottle.until = Date.now() - 1;
  const probe = am.acquireAccount({ weight: 1 });

  am.markUpstreamThrottled(60, 'still limited');
  am.releaseAccount(probe, { upstreamThrottled: true, neutral: true });

  assert.equal(am.getStatus().upstreamThrottle.active, true);
  assert.equal(am.accounts[probe.account.index].status, 'active');
  assert.equal(am.accounts[probe.account.index].failedRequests, 0);
});

test('unrelated in-flight success does not clear a shared upstream throttle', () => {
  const am = manager(2);
  const lease = am.acquireAccount({ weight: 1 });
  am.markUpstreamThrottled(60, 'temporary server limit');

  am.releaseAccount(lease, { success: true, status: 200 });

  assert.equal(am.getStatus().upstreamThrottle.active, true);
});

test('failed recovery probe schedules another probe instead of getting stuck half-open', () => {
  const am = manager(2);
  am.markUpstreamThrottled(60, 'temporary server limit');
  am.upstreamThrottle.until = Date.now() - 1;
  const probe = am.acquireAccount({ weight: 1 });

  am.releaseAccount(probe, { status: 400, error: 'HTTP 400' });

  const status = am.getStatus().upstreamThrottle;
  assert.equal(status.active, true);
  assert.equal(status.probeInFlight, false);
  assert.ok(Date.parse(status.until) > Date.now());
});

test('queued requests are admitted FIFO and ramped after recovery', () => {
  const am = manager(2);
  const first = {};
  const second = {};
  am.registerQueuedRequest(first);
  am.registerQueuedRequest(second);

  assert.equal(am.canAdmitQueuedRequest(second), false);
  assert.equal(am.canAdmitQueuedRequest(first), true);

  am.queueState.rampUntil = Date.now() + 5000;
  am.queueState.lastAdmissionAt = Date.now();
  assert.equal(am.canAdmitQueuedRequest(second), false);
  am.queueState.lastAdmissionAt = Date.now() - 300;
  assert.equal(am.canAdmitQueuedRequest(second), true);
});

test('fresh requests cannot bypass queued recovery work', () => {
  const am = manager(2);
  am.markUpstreamThrottled(60, 'temporary server limit');
  am.upstreamThrottle.until = Date.now() - 1;
  const queued = {};
  am.registerQueuedRequest(queued);

  assert.equal(am.getActiveAccount({}), null);
  assert.ok(am.getActiveAccount(queued));
});

test('admitted queue head remains routable while later tickets are waiting', () => {
  const am = manager(2);
  const first = {};
  const second = {};
  am.registerQueuedRequest(first);
  am.registerQueuedRequest(second);
  assert.equal(am.canAdmitQueuedRequest(first), true);

  assert.equal(am.queueState.waiting.length, 1);
  assert.ok(am.getActiveAccount(first));
  assert.equal(am.getActiveAccount({}), null);
});

test('fresh requests remain behind queued work after breaker clears', () => {
  const am = manager(2);
  am.markUpstreamThrottled(60, 'temporary server limit');
  const queued = {};
  am.registerQueuedRequest(queued);
  am.clearUpstreamThrottle('test recovery');

  assert.equal(am.getActiveAccount({}), null);
  am.queueState.lastAdmissionAt = Date.now() - 300;
  assert.equal(am.canAdmitQueuedRequest(queued), true);
  assert.ok(am.getActiveAccount(queued));
});

test('availability checks do not mutate account selection state', () => {
  const am = manager(3);
  const beforeCurrent = am.currentIndex;
  const beforeNext = am.nextIndex;

  for (let i = 0; i < 20; i++) assert.equal(am.hasAvailableRoute({ weight: 1 }), true);

  assert.equal(am.currentIndex, beforeCurrent);
  assert.equal(am.nextIndex, beforeNext);
});

test('restart admission barrier lets existing leases finish but blocks new leases', () => {
  const am = manager(2);
  const existing = am.acquireAccount({ weight: 1 });
  assert.ok(existing);
  am.setAdmissionPaused(true);

  assert.equal(am.getGlobalInFlight(), 1);
  assert.equal(am.acquireAccount({ weight: 1 }), null);
  assert.equal(am.hasAvailableRoute({ weight: 1 }), false);
  assert.equal(am.getStatus().scheduler.admissionPaused, true);

  am.releaseAccount(existing, { success: true, status: 200 });
  assert.equal(am.getGlobalInFlight(), 0);
  assert.equal(am.acquireAccount({ weight: 1 }), null);
});

test('shared Anthropic throttle leaves eligible providers available', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);
  am.markUpstreamThrottled(60, 'temporary server limit');

  assert.equal(am.acquireAccount({ profile: 'claude' }), null);
  const fallback = am.acquireAccount({ profile: 'all' });
  assert.equal(fallback.account.name, 'glm-fallback');
});

test('provider traffic cannot claim or clear the Anthropic recovery probe', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);
  am.markUpstreamThrottled(60, 'temporary server limit');
  am.upstreamThrottle.until = Date.now() - 1;
  am.registerQueuedRequest({});

  const fallback = am.acquireAccount({ profile: 'all' });
  assert.equal(fallback.account.name, 'glm-fallback');
  assert.equal(fallback.upstreamThrottleProbe, false);
  am.releaseAccount(fallback, { success: true, status: 200 });
  assert.ok(am.upstreamThrottle.until);
});

test('shared Anthropic throttle keeps thinking-protected sessions queued', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);
  am.markUpstreamThrottled(60, 'temporary server limit');

  assert.equal(am.acquireAccount({
    profile: 'all',
    sessionKey: 'thinking-session',
    requiresAnthropicThinkingIntegrity: true,
  }), null);
  assert.equal(am.nextRetryForRequest({
    profile: 'all',
    sessionKey: 'thinking-session',
    requiresAnthropicThinkingIntegrity: true,
  }).cause, 'upstream_throttle');
});

test('temporary expired-token refresh failure cools down and remains retryable', async () => {
  let attempts = 0;
  const refreshAccessToken = async () => {
    attempts++;
    if (attempts === 1) {
      const error = new Error('Token refresh failed (429)');
      error.status = 429;
      error.retryable = true;
      throw error;
    }
    return { accessToken: 'fresh', refreshToken: 'fresh-r', expiresAt: Date.now() + 3600_000 };
  };
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 'expired', refreshToken: 'r1', expiresAt: Date.now() - 1000 },
  ], 0.90, { cooldownMs: 10, maxCooldownMs: 10 }, { refreshAccessToken });

  assert.equal(await am.ensureTokenFresh(0), false);
  assert.equal(am.accounts[0].status, 'active');
  assert.ok(am.accounts[0].cooldownUntil > Date.now());
  assert.equal(am.nextRetryForRequest().cause, 'cooldown');

  am.accounts[0].cooldownUntil = Date.now() - 1;
  assert.equal(await am.ensureTokenFresh(0), true);
  assert.equal(am.accounts[0].credential, 'fresh');
});

test('invalid expired-token refresh marks account as requiring login', async () => {
  const refreshAccessToken = async () => {
    const error = new Error('Token refresh failed (400)');
    error.status = 400;
    error.retryable = false;
    throw error;
  };
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 'expired', refreshToken: 'r1', expiresAt: Date.now() - 1000 },
  ], 0.90, {}, { refreshAccessToken });

  assert.equal(await am.ensureTokenFresh(0), false);
  assert.equal(am.accounts[0].status, 'error');
  assert.equal(am.accounts[0].lastError, 'token_refresh_failed');
  assert.equal(am.nextRetryForRequest().cause, 'unavailable');
});

test('session affinity keeps a session on the same available account', () => {
  const am = manager(3);

  const s1First = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(s1First.account.name, 'a1');
  am.releaseAccount(s1First, { success: true, status: 200 });

  const s2 = am.acquireAccount({ weight: 1, sessionKey: 'session-2' });
  assert.equal(s2.account.name, 'a2');
  am.releaseAccount(s2, { success: true, status: 200 });

  const s1Second = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(s1Second.account.name, 'a1');
  am.releaseAccount(s1Second, { success: true, status: 200 });
  assert.equal(am.getStatus().sessions.stickyBindings, 2);
});

test('session affinity rebinds when the bound account is unavailable', () => {
  const am = manager(3);

  const first = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(first.account.name, 'a1');
  am.releaseAccount(first, { success: true, status: 200 });

  am.markRateLimited(0, 60);
  const moved = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.notEqual(moved.account.name, 'a1');
  am.releaseAccount(moved, { success: true, status: 200 });

  const next = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(next.account.name, moved.account.name);
});

test('session affinity returns to the home Claude account after it recovers', () => {
  const am = manager(3);

  const first = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(first.account.name, 'a1');
  am.releaseAccount(first, { success: true, status: 200 });

  am.markRateLimited(0, 60);
  const moved = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(moved.account.name, 'a2');
  am.releaseAccount(moved, { success: true, status: 200 });

  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  const recovered = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(recovered.account.name, 'a1');
});

test('session affinity survives account index changes', () => {
  const am = manager(3);

  const s1 = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  am.releaseAccount(s1, { success: true, status: 200 });
  const s2 = am.acquireAccount({ weight: 1, sessionKey: 'session-2' });
  assert.equal(s2.account.name, 'a2');
  am.releaseAccount(s2, { success: true, status: 200 });

  am.removeAccount(0);
  const s2Again = am.acquireAccount({ weight: 1, sessionKey: 'session-2' });
  assert.equal(s2Again.account.name, 'a2');
});

test('session affinity returns fallback sessions to higher-priority routes', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
    { name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'kk', upstream: 'http://kimi', profiles: ['all'], priority: 20 },
  ], 0.90);

  am.markRateLimited(0, 60);
  const fallback = am.acquireAccount({ profile: 'all', sessionKey: 'session-1' });
  assert.equal(fallback.account.name, 'glm-fallback');
  am.releaseAccount(fallback, { success: true, status: 200 });

  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  const recovered = am.acquireAccount({ profile: 'all', sessionKey: 'session-1' });
  assert.equal(recovered.account.name, 'claude');
});

test('thinking-protected sessions do not stay bound to provider fallback', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);

  am.markRateLimited(0, 60);
  const fallback = am.acquireAccount({ profile: 'all', sessionKey: 'session-1' });
  assert.equal(fallback.account.name, 'glm-fallback');
  am.releaseAccount(fallback, { success: true, status: 200 });

  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  const protectedLease = am.acquireAccount({
    profile: 'all',
    sessionKey: 'session-1',
    requiresAnthropicThinkingIntegrity: true,
  });
  assert.equal(protectedLease.account.name, 'claude');
  assert.equal(am.getStatus().sessions.thinkingProtected, 1);
});

test('weekly soft pressure penalizes new placement but does not block', () => {
  const am = manager(2);
  am.accounts[0].quota.unified7d = 0.70;
  am.accounts[1].quota.unified7d = 0.10;

  let lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a2');
  am.releaseAccount(lease, { success: true, status: 200 });

  lease = am.acquireAccount({ weight: 1 }, new Set([1]));
  assert.equal(lease.account.name, 'a1');
  assert.equal(am.getStatus().accounts[0].weekly.state, 'soft');
});

test('weekly reserve blocks new sessions but permits sticky sessions', () => {
  const am = manager(2);
  const first = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(first.account.name, 'a1');
  am.releaseAccount(first, { success: true, status: 200 });

  am.accounts[0].quota.unified7d = 0.86;
  am.accounts[1].quota.unified7d = 0.10;

  const sticky = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(sticky.account.name, 'a1');
  am.releaseAccount(sticky, { success: true, status: 200 });

  const newSession = am.acquireAccount({ weight: 1, sessionKey: 'session-2' });
  assert.equal(newSession.account.name, 'a2');
  assert.equal(am.getStatus().accounts[0].weekly.state, 'reserve');
});

test('weekly critical breaks sticky affinity', () => {
  const am = manager(2);
  const first = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(first.account.name, 'a1');
  am.releaseAccount(first, { success: true, status: 200 });

  am.accounts[0].quota.unified7d = 0.96;
  am.accounts[1].quota.unified7d = 0.10;

  const moved = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(moved.account.name, 'a2');
  assert.equal(am.getStatus().accounts[0].weekly.state, 'critical');
});

test('weekly critical is used as last resort instead of failing request', () => {
  const am = manager(2);
  am.accounts[0].quota.unified7d = 0.96;
  am.accounts[1].quota.unified7d = 0.97;

  const lease = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.ok(lease);
  assert.match(lease.account.name, /^a[12]$/);
  assert.equal(am.nextRetryForRequest({ sessionKey: 'session-2' }).available, true);
});

test('weekly pace pressure does not masquerade as actual exhaustion', () => {
  const am = manager(1);
  am.accounts[0].quota.unified7d = 0.70;
  am.accounts[0].quota.unified7dReset = Date.now() + 6 * 24 * 60 * 60 * 1000;

  const status = am.getStatus().accounts[0].weekly;
  assert.equal(status.rawState, 'soft');
  assert.equal(status.state, 'critical');
  assert.equal(status.paceState, 'exhausted');
  assert.equal(am.nextRetryForRequest({ sessionKey: 'session-1' }).available, true);
});

test('upstream weekly overage is clamped for routing and display quota', () => {
  const am = manager(1);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-7d-utilization': '1.39',
    'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 4 * 24 * 60 * 60 * 1000) / 1000)),
  });

  assert.equal(am.accounts[0].quota.unified7d, 1);
  assert.equal(am.accounts[0].quota.unified7dRaw, 1.39);
  assert.equal(am.getStatus().accounts[0].quota.unified7d, 1);
  assert.equal(am.getStatus().accounts[0].weekly.state, 'exhausted');
});

test('unified reset headers accept epoch milliseconds and date strings', () => {
  const am = manager(1);
  const fiveHourReset = Date.now() + 2 * 60 * 60 * 1000;
  const weeklyReset = new Date(Math.floor((Date.now() + 3 * 24 * 60 * 60 * 1000) / 1000) * 1000);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-5h-utilization': '0.54',
    'anthropic-ratelimit-unified-5h-reset': String(fiveHourReset),
    'anthropic-ratelimit-unified-7d-utilization': '0.85',
    'anthropic-ratelimit-unified-7d-reset': weeklyReset.toUTCString(),
  });

  assert.equal(am.accounts[0].quota.unified5h, 0.54);
  assert.ok(Math.abs(am.accounts[0].quota.unified5hReset - fiveHourReset) < 1000);
  assert.equal(am.accounts[0].quota.unified7d, 0.85);
  assert.ok(Math.abs(am.accounts[0].quota.unified7dReset - weeklyReset.getTime()) < 1000);
});

test('near-quota logging is de-duplicated for unchanged quota state', () => {
  const am = manager(1);
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const headers = {
      'anthropic-ratelimit-unified-7d-utilization': '0.86',
      'anthropic-ratelimit-unified-7d-reset': String(Math.floor((Date.now() + 5 * 24 * 60 * 60 * 1000) / 1000)),
    };
    am.updateQuota(0, headers);
    am.updateQuota(0, headers);
  } finally {
    console.log = originalLog;
  }

  assert.equal(lines.filter(line => line.includes('limiting new placement')).length, 1);
});

test('5h quota threshold blocks sticky affinity', () => {
  const am = manager(2);
  const first = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(first.account.name, 'a1');
  am.releaseAccount(first, { success: true, status: 200 });

  am.accounts[0].quota.unified5h = 0.91;
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7d = 0.10;

  const moved = am.acquireAccount({ weight: 1, sessionKey: 'session-1' });
  assert.equal(moved.account.name, 'a2');
});

test('scheduler keeps provider fallbacks out of claude-only profile', () => {
  const am = new AccountManager([
    {
      name: 'claude',
      type: 'oauth',
      accessToken: 'tc',
      refreshToken: 'rc',
      expiresAt: Date.now() + 3600_000,
      profiles: ['claude', 'all'],
      priority: 0,
    },
    {
      name: 'glm-fallback',
      type: 'provider',
      provider: 'zai',
      authToken: 'zg',
      upstream: 'http://glm',
      profiles: ['all'],
      priority: 10,
    },
  ], 0.90);

  am.markRateLimited(0, 60);
  assert.equal(am.acquireAccount({ profile: 'claude' }), null);
  assert.equal(am.acquireAccount({ profile: 'all' }).account.name, 'glm-fallback');
});

test('all profile only uses lower-priority providers after higher-priority accounts are unavailable', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
    { name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'kk', upstream: 'http://kimi', profiles: ['all'], priority: 20 },
  ], 0.90);

  let lease = am.acquireAccount({ profile: 'all' });
  assert.equal(lease.account.name, 'claude');
  am.releaseAccount(lease, { success: true });

  am.markRateLimited(0, 60);
  lease = am.acquireAccount({ profile: 'all' });
  assert.equal(lease.account.name, 'glm-fallback');
  am.releaseAccount(lease, { success: true });

  am.markRateLimited(1, 60);
  lease = am.acquireAccount({ profile: 'all' });
  assert.equal(lease.account.name, 'kimi-fallback');
});

test('all profile uses provider before weekly-critical Claude account', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);
  am.accounts[0].quota.unified7d = 0.96;

  const lease = am.acquireAccount({ profile: 'all' });
  assert.equal(lease.account.name, 'glm-fallback');
});

test('provider telemetry parses standard rate limit headers', () => {
  const am = new AccountManager([
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'] },
  ], 0.90);

  am.updateQuota(0, {
    'x-ratelimit-limit': '100',
    'x-ratelimit-remaining': '72',
    'x-ratelimit-reset': '60',
  });

  assert.equal(am.accounts[0].quota.genericLimit, 100);
  assert.equal(am.accounts[0].quota.genericRemaining, 72);
  assert.ok(am.accounts[0].quota.genericReset > Date.now());
});

test('load telemetry tracks current and rolling account usage', () => {
  const am = manager(1);
  const lease = am.acquireAccount({ weight: 3 });
  let status = am.getStatus().accounts[0];
  assert.equal(status.load.current.inFlight, 1);
  assert.equal(status.load.current.activeWeight, 3);
  assert.equal(status.load.last15m.requests, 0);

  am.releaseAccount(lease, { success: true, status: 200 });
  status = am.getStatus().accounts[0];
  assert.equal(status.load.current.inFlight, 0);
  assert.equal(status.load.current.activeWeight, 0);
  assert.equal(status.load.last15m.requests, 1);
  assert.equal(status.load.last15m.weight, 3);
  assert.equal(status.load.last1h.requests, 1);
  assert.equal(status.load.last15m.failed, 0);
  assert.ok(status.load.last15m.avgMs >= 0);
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('near-reset account with quota left is preferred (use-it-or-lose-it)', () => {
  const am = manager(2);
  const now = Date.now();
  // a1: high weekly use but resets in 2h -> the remaining quota is about to
  // refresh, so it is cheap to spend. a2: lower weekly use but resets in 6 days.
  am.accounts[0].quota.unified7d = 0.79;
  am.accounts[0].quota.unified7dReset = now + 2 * HOUR;
  am.accounts[1].quota.unified7d = 0.40;
  am.accounts[1].quota.unified7dReset = now + 6 * DAY;

  // Scarcity (pace overage) is lower for the near-reset account despite higher %.
  assert.ok(am._accountScarcity(am.accounts[0], now) < am._accountScarcity(am.accounts[1], now));

  const lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a1');
});

test('early-week account burning quota fast is avoided as genuinely scarce', () => {
  const am = manager(2);
  const now = Date.now();
  // Both reset in 6 days, but a1 has already burned 80% this early in the week
  // (ahead of pace -> scarce). a2 is at 30%.
  am.accounts[0].quota.unified7d = 0.80;
  am.accounts[0].quota.unified7dReset = now + 6 * DAY;
  am.accounts[1].quota.unified7d = 0.30;
  am.accounts[1].quota.unified7dReset = now + 6 * DAY;

  assert.ok(am._accountScarcity(am.accounts[0], now) > am._accountScarcity(am.accounts[1], now));

  const lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a2');
});

test('recent-load share spreads sequential traffic across equal accounts', () => {
  const am = manager(2);
  const now = Date.now();
  // Identical quota state -> identical scarcity. Without a recent-load term,
  // sequential traffic would funnel onto whichever account is encountered first.
  for (const a of am.accounts) {
    a.quota.unified7d = 0.50;
    a.quota.unified7dReset = now + 3 * DAY;
    a.quota.unified5h = 0.20;
    a.quota.unified5hReset = now + 4 * HOUR;
    a.probing = false;
  }

  const counts = { a1: 0, a2: 0 };
  for (let i = 0; i < 20; i++) {
    const lease = am.acquireAccount({ weight: 1 });
    counts[lease.account.name]++;
    am.releaseAccount(lease, { success: true, status: 200 });
  }
  // Neither account should be starved; sequential traffic rotates.
  assert.ok(counts.a1 >= 6, `a1 got ${counts.a1}`);
  assert.ok(counts.a2 >= 6, `a2 got ${counts.a2}`);
});

test('recovery ramp eases a just-recovered account back in', () => {
  const am = manager(2);
  const now = Date.now();
  // a1 just recovered from a park; a2 has been idle. The ramp should make the
  // freshly-recovered account temporarily less attractive so it is not slammed.
  am.accounts[0].recoveredAt = now;
  const lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a2');
  am.releaseAccount(lease, { success: true, status: 200 });

  // Once the ramp window has elapsed, the recovered account is no longer penalized.
  am.accounts[0].recoveredAt = now - am.scheduler.recoveryRampMs - 1;
  assert.equal(am._recoveryRamp(am.accounts[0], Date.now()), 0);
});

test('preferring a provider, disabled, or missing account is rejected and stays automatic', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'http://glm', profiles: ['all'], priority: 10 },
    { name: 'off', type: 'oauth', accessToken: 'to', refreshToken: 'ro', expiresAt: Date.now() + 3600_000, profiles: ['claude', 'all'], priority: 0, enabled: false },
  ], 0.90);

  assert.equal(am.setRoutingMode('preferred', 'glm'), false);      // provider
  assert.equal(am.routingMode, 'automatic');
  assert.equal(am.setRoutingMode('preferred', 'off'), false);      // disabled
  assert.equal(am.routingMode, 'automatic');
  assert.equal(am.setRoutingMode('preferred', 'missing'), false);  // missing
  assert.equal(am.routingMode, 'automatic');

  assert.equal(am.setRoutingMode('preferred', 'claude'), true);    // valid
  assert.equal(am.routingMode, 'preferred');
  assert.equal(am.preferredAccountName, 'claude');
});

// ── queue backpressure + reaper (queue redesign 2026-06-26) ──────────────

test('registerQueuedRequest enforces maxConcurrentQueued (rejects overflow)', () => {
  const am = manager(1);
  const limits = { maxConcurrentQueued: 2 };
  const a = am.registerQueuedRequest({}, limits);
  const b = am.registerQueuedRequest({}, limits);
  const c = am.registerQueuedRequest({}, limits);
  assert.ok(a && b, 'first two should register');
  assert.equal(c, null, 'third should be rejected at the tail');
  assert.equal(am.queueState.waiting.length, 2);
});

test('registerQueuedRequest enforces maxQueuedBytes aggregate budget', () => {
  const am = manager(1);
  const limits = { maxQueuedBytes: 1000 };
  const a = am.registerQueuedRequest({}, { ...limits, bytes: 600 });
  const b = am.registerQueuedRequest({}, { ...limits, bytes: 600 }); // 600+600 > 1000, queue non-empty
  assert.ok(a, 'first fits');
  assert.equal(b, null, 'second exceeds aggregate budget');
  assert.equal(am.queueState.bytes, 600);
});

test('queue byte accounting is released on remove and on admit', () => {
  const am = manager(1);
  const r1 = {}; const r2 = {};
  am.registerQueuedRequest(r1, { bytes: 100 });
  am.registerQueuedRequest(r2, { bytes: 250 });
  assert.equal(am.queueState.bytes, 350);
  am.removeQueuedRequest(r2);
  assert.equal(am.queueState.bytes, 100);
  // r1 is now head; admit it (no ramp gate active) and bytes should release
  const admitted = am.canAdmitQueuedRequest(r1);
  assert.equal(admitted, true);
  assert.equal(am.queueState.bytes, 0);
});

test('stale head ticket (deadline passed) is reaped and does not wedge the queue', () => {
  const am = manager(1);
  const dead = {}; const live = {};
  am.registerQueuedRequest(dead, {});
  am.registerQueuedRequest(live, {});
  assert.equal(am.queueState.waiting.length, 2);
  // The head goes stale after the fact (e.g. its socket died mid-wait and the
  // normal removal was missed). The next admit must reap it, not wedge.
  am.queueState.waiting[0].deadlineAt = Date.now() - 1;
  const admitted = am.canAdmitQueuedRequest(live);
  assert.equal(admitted, true, 'live ticket admits after the dead head is reaped');
  assert.equal(am.queueState.waiting.length, 0);
});

test('nextRetryForRequest returns weekly_reset_unknown when reset time is unknown', () => {
  const am = manager(1);
  am.accounts[0].quota.unified7d = 1;
  am.accounts[0].quota.unified7dReset = null; // unknown
  const plan = am.nextRetryForRequest({ profile: 'claude' }, new Set());
  assert.equal(plan.available, false);
  assert.equal(plan.cause, 'weekly_reset_unknown');
  assert.equal(plan.retryAfterMs, Infinity);
});

// ── routing redesign: spread-to-stay-healthy (2026-06-26) ────────────────

test('load spreads across healthy accounts instead of concentrating on the near-reset one', () => {
  // Reproduces the 2026-06-26 screenshot: max@dubner.io is near its 7d reset
  // with quota left; mk@gomokka has real raw headroom but is burning fast;
  // partnerships/personal are near-empty. 6 concurrent requests should FAN OUT
  // across the two healthy accounts, not pile onto max@dubner.io.
  const now = Date.now();
  const am = new AccountManager([
    { name: 'partnerships', type: 'oauth', accessToken: 'tp', refreshToken: 'rp', expiresAt: now + 3600_000 },
    { name: 'personal', type: 'oauth', accessToken: 'tu', refreshToken: 'ru', expiresAt: now + 3600_000 },
    { name: 'mk@gomokka', type: 'oauth', accessToken: 'tm', refreshToken: 'rm', expiresAt: now + 3600_000 },
    { name: 'max@dubner.io', type: 'oauth', accessToken: 'td', refreshToken: 'rd', expiresAt: now + 3600_000 },
  ], 0.90);
  // weekly utilisation + reset horizons from the screenshot
  am.accounts[0].quota.unified7d = 0.96; am.accounts[0].quota.unified7dReset = now + 4 * 24 * 3600_000;
  am.accounts[1].quota.unified7d = 0.99; am.accounts[1].quota.unified7dReset = now + 2.4 * 24 * 3600_000;
  am.accounts[2].quota.unified7d = 0.69; am.accounts[2].quota.unified7dReset = now + 5.3 * 24 * 3600_000; // raw-healthy, fast-burning
  am.accounts[3].quota.unified7d = 0.26; am.accounts[3].quota.unified7dReset = now + 15 * 3600_000;        // near reset, quota left

  const picks = {};
  const leases = [];
  for (let i = 0; i < 6; i++) {
    const lease = am.acquireAccount({ weight: 1 });
    assert.ok(lease, `request ${i} should get an account`);
    picks[lease.account.name] = (picks[lease.account.name] || 0) + 1;
    leases.push(lease);
  }

  // mk@gomokka must NOT be benched (the core gate fix) and load must spread.
  assert.ok(picks['mk@gomokka'] > 0, `mk@gomokka must be used, got: ${JSON.stringify(picks)}`);
  assert.ok(picks['max@dubner.io'] > 0, `max@dubner.io should also be used, got: ${JSON.stringify(picks)}`);
  // No single account absorbs the whole 6-deep burst (the old bug).
  const maxOnOne = Math.max(...Object.values(picks));
  assert.ok(maxOnOne <= 4, `no account should absorb the whole burst; got: ${JSON.stringify(picks)}`);

  leases.forEach(l => am.releaseAccount(l, { success: true, status: 200 }));
});

// ── routing oracle + hold-vs-error + ghost guard (2026-06-26, issue #2) ──

test('raw-healthy but pace-critical account stays available (routing consistency, R1)', () => {
  const am = manager(1);
  // 74% raw weekly = "soft", but resets in 5 days → pace burn-debt flips the
  // PACE state to critical. The fix: gates use RAW state, so it stays usable.
  am.accounts[0].quota.unified7d = 0.74;
  am.accounts[0].quota.unified7dReset = Date.now() + 5 * 24 * 3600_000;
  assert.equal(am._weeklyRawState(am.accounts[0]), 'soft');
  assert.equal(am._isAvailable(am.accounts[0], { allowWeeklyReserve: true }), true);
  assert.equal(am.hasAvailableRoute({ profile: 'claude' }), true);
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, true, 'oracle no longer benches it on pace');
  assert.equal(plan.cause, 'available');
});

test('hold-vs-error oracle: all weekly-exhausted with KNOWN reset → finite retry (HOLD)', () => {
  const am = manager(2);
  for (const a of am.accounts) {
    a.quota.unified7d = 0.99;
    a.quota.unified7dReset = Date.now() + 51 * 3600_000; // 51h out — the case the old kill rejected
  }
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.cause, 'weekly_exhausted');
  assert.ok(Number.isFinite(plan.retryAfterMs) && plan.retryAfterMs > 0, 'finite reset → holdable');
});

test('hold-vs-error oracle: all accounts auth-dead → Infinity retry (ERROR FAST, never hold)', () => {
  const am = manager(2);
  for (const a of am.accounts) a.status = 'error';
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.retryAfterMs, Infinity, 'permanent → server errors fast, never parks the session');
});

test('sessionKey supersede: a client retry evicts its own prior ghost ticket', () => {
  const am = manager(1);
  am.registerQueuedRequest({}, { sessionKey: 'S', bytes: 100 });
  assert.equal(am.queueState.waiting.length, 1);
  assert.equal(am.queueState.bytes, 100);
  am.registerQueuedRequest({}, { sessionKey: 'S', bytes: 250 }); // retry for same session
  assert.equal(am.queueState.waiting.length, 1, 'old same-session ticket evicted, not stacked');
  assert.equal(am.queueState.bytes, 250);
  assert.equal(am.queueState.waiting[0].sessionKey, 'S');
});

test('ghost guard: a fresh session is not blocked by a superseded same-session ghost', () => {
  const am = manager(1);
  const lim = { maxConcurrentQueued: 2 };
  am.registerQueuedRequest({}, { ...lim, sessionKey: 'S', bytes: 1 });
  am.registerQueuedRequest({}, { ...lim, sessionKey: 'S', bytes: 1 }); // supersedes → still 1 in queue
  const fresh = am.registerQueuedRequest({}, { ...lim, sessionKey: 'T', bytes: 1 });
  assert.ok(fresh, 'distinct fresh session admitted (not rejected by a dead same-session duplicate)');
  assert.equal(am.queueState.waiting.length, 2);
});

// ── council fixes: bug B (weekly-critical+5h hold) + bug C (ghost-only evict) ──

test('bug B: weekly-critical + 5h-capped fleet HOLDS for the SOON 5h reset, not the far weekly reset', () => {
  // The MAJOR oracle defect: _retryInfo keyed the hold on the 40h weekly reset
  // even though the real blocker (the 5h cap) clears in 2h. A weekly-critical
  // account is last-resort usable, so it frees the moment the 5h cap clears.
  const am = manager(2);
  const fiveHReset = Date.now() + 2 * 3600_000;
  for (const a of am.accounts) {
    a.quota.unified7d = 0.96;                          // raw weekly critical [0.95,0.985)
    a.quota.unified7dReset = Date.now() + 40 * 3600_000;
    a.quota.unified5h = 0.95;                          // ALSO 5h-capped (>= switchThreshold)
    a.quota.unified5hReset = fiveHReset;
  }
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.ok(Number.isFinite(plan.retryAfterMs), 'must HOLD (finite), not error-fast on Infinity');
  // Holds for ~2h (the 5h cap), NOT ~40h (the weekly reset).
  assert.ok(plan.retryAfterMs <= 2 * 3600_000 + 5000, `retry-after ${plan.retryAfterMs}ms must track the 2h 5h-cap, not the 40h weekly reset`);
  assert.ok(plan.retryAfterMs >= 2 * 3600_000 - 60_000, 'retry-after must be ~2h, the real near-term recovery');
  assert.equal(plan.cause, 'session_limit', 'reports the REAL short-term blocker, not weekly_critical');
});

test('bug B (blocker): weekly-critical + 5h-capped with UNKNOWN resets HOLDS finite, never Infinity-kills', () => {
  // The BLOCKER: on cold-start / post-reset, a weekly-critical account can be
  // 5h-capped with NO learned reset (unified5hReset null AND unified7dReset null).
  // The old bucket gated on retry.retryAt being truthy → fell through to
  // {retryAfterMs: Infinity} → killed the session — the exact regression this work
  // set out to fix. A critical account is recoverable by definition: hold finite.
  const am = manager(2);
  for (const a of am.accounts) {
    a.quota.unified7d = 0.96;            // raw weekly critical
    a.quota.unified7dReset = null;       // reset time unknown
    a.quota.unified5h = 0.95;            // ALSO 5h-capped
    a.quota.unified5hReset = null;       // 5h reset unknown too
  }
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.ok(Number.isFinite(plan.retryAfterMs), 'MUST HOLD finite — never collapse to Infinity and kill the session');
  assert.equal(plan.cause, 'weekly_critical');
  assert.ok(plan.retryAfterMs > 0 && plan.retryAfterMs <= 60_000, 'bounded re-poll hold so the poll loop re-checks real availability');
});

test('bug (fairness): re-queuing clears a stale queueAdmitted so a resumed request cannot bypass the gate forever', () => {
  // BLOCKER: queueAdmitted was set once at admission and never cleared. A resumed
  // request that admitted (ticket consumed) but lost the race for the freed slot
  // re-queues — and kept queueAdmitted=true forever, permanently bypassing the
  // fairness gate and starving every other waiter. Re-queuing must consume it.
  const am = manager(1);
  const X = {};
  am.registerQueuedRequest(X, { sessionKey: 'X', bytes: 1, res: { destroyed: false, writableEnded: false } });
  assert.equal(am.canAdmitQueuedRequest(X), true, 'X at head is admitted');
  assert.equal(X.queueTicket, null, 'admission consumes the ticket');
  assert.equal(X.queueAdmitted, true, 'admission flag set');

  // X failed to acquire the freed slot (lost the race) and RE-QUEUES.
  am.registerQueuedRequest(X, { sessionKey: 'X', bytes: 1, res: { destroyed: false, writableEnded: false } });
  assert.equal(X.queueAdmitted, false, 're-queue consumed the stale admission — X is a fair FIFO waiter again');

  // Behavioural proof: a ticketless, un-admitted X must be BLOCKED by the fairness
  // gate while other waiters are queued (no permanent bypass).
  X.queueTicket = null;
  am.registerQueuedRequest({}, { sessionKey: 'Y', bytes: 1, res: { destroyed: false, writableEnded: false } });
  assert.equal(am._matchesRequest(am.accounts[0], 'claude', X), false, 'ticketless un-admitted X gated behind the waiter');
});

test('major: an auth-dead account with a STALE critical quota error-fasts (Infinity), not a 60s spin', () => {
  // A terminal account (status='error' / disabled) is NOT recoverable-by-definition.
  // Its stale weekly-critical QUOTA reading must not shadow the terminal check into a
  // finite weeklyCritical hold — that would spin the session up to streamHoldMaxMs (7d)
  // instead of returning 429. _retryInfo must evaluate terminal status BEFORE weekly.
  const am = manager(2);
  for (const a of am.accounts) {
    a.status = 'error';               // auth-dead (e.g. refresh failed)
    a.lastError = 'invalid_grant';
    a.quota.unified7d = 0.96;         // STALE raw-critical reading lingers
    a.quota.unified7dReset = Date.now() + 40 * 3600_000;
  }
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.retryAfterMs, Infinity, 'auth-dead fleet must ERROR FAST (Infinity), never hold finite');
});

test('minor: weekly-critical blocked only by the in-flight cap holds a bounded re-poll, not the 7d reset', () => {
  // A weekly-critical account whose ONLY block is the per-account in-flight cap
  // frees in seconds when a sibling completes — it must NOT report the ~7d weekly
  // reset as its hold (which would error-fast a non-stream request for days).
  const am = manager(1);
  const a = am.accounts[0];
  a.quota.unified7d = 0.96;                       // weekly critical, last-resort usable
  a.quota.unified7dReset = Date.now() + 40 * 3600_000;
  a.inFlight = am.scheduler.safetyMaxActivePerAccount; // sole block: concurrency cap
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.cause, 'weekly_critical');
  assert.ok(plan.retryAfterMs <= 60_000, `bounded re-poll (~60s), got ${plan.retryAfterMs}ms — must NOT be the 40h weekly reset`);
});

test('major: a HEALTHY account blocked only by the concurrency cap HOLDS finite, not Infinity error-fast', () => {
  // Symmetry fix: a weekly-critical account at the in-flight cap already holds a
  // bounded re-poll; a HEALTHY account in the identical concurrency-capped state
  // used to fall through to Infinity and error-fast the request to 429 — even
  // though a slot frees in seconds when a sibling completes.
  const am = manager(2);
  for (const a of am.accounts) {
    a.quota.unified7d = 0.10;        // healthy weekly
    a.quota.unified5h = 0.10;        // healthy session
    a.inFlight = am.scheduler.safetyMaxActivePerAccount; // sole block: per-account cap
  }
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.ok(Number.isFinite(plan.retryAfterMs), 'concurrency-capped healthy fleet must HOLD, not error-fast on Infinity');
  assert.equal(plan.cause, 'concurrency_cap');
  assert.ok(plan.retryAfterMs <= 60_000, 'bounded re-poll hold');
});

test('minor (min-merge): a sibling weekly-exhausted 30min reset wins over a weekly-critical 3h short-term hold', () => {
  // soonestTemporary must NOT hard-win over the weekly buckets: A is weekly-critical
  // with a queueable 3h session_limit (→ soonestTemporary=3h); B is weekly-exhausted
  // resetting in 30min. The emitted Retry-After must reflect B's sooner 30min recovery.
  const am = manager(2);
  const A = am.accounts[0], B = am.accounts[1];
  A.quota.unified7d = 0.96;                       // critical
  A.quota.unified7dReset = Date.now() + 40 * 3600_000;
  A.quota.unified5h = 0.95;                       // queueable 3h session_limit
  A.quota.unified5hReset = Date.now() + 3 * 3600_000;
  B.quota.unified7d = 0.99;                       // exhausted
  B.quota.unified7dReset = Date.now() + 30 * 60_000;
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.cause, 'weekly_exhausted', 'the sooner sibling recovery (B) must win, not A 3h session_limit');
  assert.ok(plan.retryAfterMs <= 30 * 60_000 + 5000 && plan.retryAfterMs >= 30 * 60_000 - 60_000,
    `retry-after ${plan.retryAfterMs}ms must track B's ~30min reset, not A's 3h hold`);
});

test('bug B (masking): a sooner weekly-critical recovery wins over a far weekly-exhausted reset', () => {
  // Mixed fleet: account A is weekly-EXHAUSTED with a far 40h reset; account B is
  // weekly-CRITICAL (last-resort usable) recovering ~60s. The oracle used to
  // return weekly_exhausted (40h) first, masking B's sooner recovery → a non-
  // streaming request error-fasts (40h > its 5min window) and clients see a
  // multi-day Retry-After. Min-merge must surface the SOONER critical recovery.
  const am = manager(2);
  const A = am.accounts[0], B = am.accounts[1];
  A.quota.unified7d = 0.99;                       // exhausted (>= 0.985)
  A.quota.unified7dReset = Date.now() + 40 * 3600_000;
  B.quota.unified7d = 0.96;                       // critical [0.95, 0.985)
  B.quota.unified7dReset = null;                  // reset unknown
  B.quota.unified5h = 0.95;                       // ALSO 5h-capped, reset unknown
  B.quota.unified5hReset = null;                  // → bounded ~60s weekly-critical hold
  const plan = am.nextRetryForRequest({ profile: 'claude' });
  assert.equal(plan.available, false);
  assert.equal(plan.cause, 'weekly_critical', 'sooner critical recovery must win, not weekly_exhausted');
  assert.ok(plan.retryAfterMs <= 60_000, `retry-after ${plan.retryAfterMs}ms must be the ~60s critical recovery, not 40h`);
});

test('bug C: a LIVE concurrent same-session request is NOT evicted (no starve)', () => {
  const am = manager(1);
  const r1 = {}; const r2 = {};
  am.registerQueuedRequest(r1, { sessionKey: 'S', bytes: 1, res: { destroyed: false, writableEnded: false } });
  am.registerQueuedRequest(r2, { sessionKey: 'S', bytes: 1, res: { destroyed: false, writableEnded: false } });
  assert.equal(am.queueState.waiting.length, 2, 'both live concurrent siblings held');
  assert.ok(r1.queueTicket, 'first live sibling not orphaned');
});

test('bug C: an EPIPE half-dead ghost (socket destroyed, res not yet) IS superseded', () => {
  // After a client RST the ServerResponse hasn't flipped destroyed/writableEnded
  // yet (noticed only on the next write), but its socket is destroyed. The fast
  // same-session supersede must still detect it so a retry isn't backpressure-
  // rejected by its own undetected ghost before the heartbeat reaps it.
  const am = manager(1);
  const r1 = {}; const r2 = {};
  am.registerQueuedRequest(r1, { sessionKey: 'S', bytes: 7, res: { destroyed: false, writableEnded: false, socket: { destroyed: true } } });
  assert.equal(am.queueState.waiting.length, 1);
  am.registerQueuedRequest(r2, { sessionKey: 'S', bytes: 1, res: { destroyed: false, writableEnded: false } });
  assert.equal(am.queueState.waiting.length, 1, 'half-dead EPIPE ghost evicted, new live one remains');
  assert.equal(r1.queueTicket, null, 'orphaned half-dead waiter freed');
  assert.equal(am.queueState.bytes, 1, 'ghost bytes released');
});

test('bug C: a DEAD same-session hold IS superseded and its waiter freed', () => {
  const am = manager(1);
  const r1 = {}; const r2 = {};
  am.registerQueuedRequest(r1, { sessionKey: 'S', bytes: 1, res: { destroyed: true } }); // ghost
  assert.equal(am.queueState.waiting.length, 1);
  am.registerQueuedRequest(r2, { sessionKey: 'S', bytes: 1, res: { destroyed: false } });
  assert.equal(am.queueState.waiting.length, 1, 'dead ghost evicted, new live one remains');
  assert.equal(r1.queueTicket, null, 'orphaned waiter freed so its loop exits fast');
  assert.equal(am.queueState.bytes, 1, 'ghost bytes released');
});

// ── #1 session rebalancing: migrate a bound session off a HOT account onto fresh
//    capacity, but ONLY on a thinking-safe request, and only on a clear win. ──

function hot(account) {            // weekly reserve = hot but still usable
  account.quota.unified7d = 0.90;
  account.quota.unified7dReset = Date.now() + 2 * 24 * 3600 * 1000;
}
function fresh(account) {          // unknown weekly, idle = best migration target
  account.quota.unified7d = null;
  account.quota.unified7dReset = null;
  account.inFlight = 0;
}

test('rebalance: a thinking-SAFE request migrates a bound session off a HOT account to fresh capacity', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  assert.equal(first.account.name, 'a1');           // bound to a1
  am.releaseAccount(first, { success: true, status: 200 });
  hot(a1); a1.inFlight = 6;                          // a1 now hot + heavily loaded
  fresh(a2);
  const next = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  assert.equal(next.account.name, 'a2', 'safe + hot + much-healthier alt → migrates');
});

test('rebalance: a request carrying signed thinking NEVER migrates (no invalid-signature break)', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  am.releaseAccount(first, { success: true, status: 200 });
  hot(a1); a1.inFlight = 6; fresh(a2);
  // Body carries a signed thinking block → must stay on a1.
  const next = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true, requiresAnthropicThinkingIntegrity: true });
  assert.equal(next.account.name, 'a1', 'signed-thinking request stays put');
});

test('rebalance: an UNSCANNED body fails closed (no migration)', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  am.releaseAccount(first, { success: true, status: 200 });
  hot(a1); a1.inFlight = 6; fresh(a2);
  // No bodyThinkingScanned (e.g. non-JSON / parse failure) → treated as unsafe.
  const next = am.acquireAccount({ weight: 1, sessionKey: 's1' });
  assert.equal(next.account.name, 'a1', 'unparsed body never migrates (fail-closed)');
});

test('rebalance: a HEALTHY bound account is never migrated away from', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  am.releaseAccount(first, { success: true, status: 200 });
  // a1 healthy (not hot), a2 fresh + idle (cheaper score) — must NOT migrate.
  a1.quota.unified7d = 0.10; a1.inFlight = 2; fresh(a2);
  const next = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  assert.equal(next.account.name, 'a1', 'healthy bound account stays put (no churn)');
});

test('rebalance: suppressed while the request is consuming a queue admission', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  am.releaseAccount(first, { success: true, status: 200 });
  hot(a1); a1.inFlight = 6; fresh(a2);
  const next = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true, queueAdmitted: true });
  assert.equal(next.account.name, 'a1', 'no migration mid queue-admission');
});

test('rebalance: does not flap — once on the fresh account it stays (HOT gate + re-home)', () => {
  const am = manager(2);
  const a1 = am.accounts[0], a2 = am.accounts[1];
  const first = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  am.releaseAccount(first, { success: true, status: 200 });
  hot(a1); a1.inFlight = 6; fresh(a2);
  const moved = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  assert.equal(moved.account.name, 'a2');
  am.releaseAccount(moved, { success: true, status: 200 });
  // a2 now took load (higher concurrency score) but stays HEALTHY weekly; a1 still
  // hot. The session must NOT ping-pong back to a1.
  a2.inFlight = 6;
  const again = am.acquireAccount({ weight: 1, sessionKey: 's1', bodyThinkingScanned: true });
  assert.equal(again.account.name, 'a2', 'healthy current account is not hot → no migration back');
});

// --- Regression: FIFO-fairness newcomer must HOLD, never error-fast (session-kill) ---
// Reproduced bug (2026-06-27): a NEW request from a signed-thinking session arriving
// while a FIFO queue already exists got retryAfterMs=Infinity / no_eligible_route and
// the session was KILLED with "all N are at their 5h or weekly limit" — even with
// fully-healthy accounts idle behind the queue. The fairness gate is TRANSIENT (the
// newcomer queues the instant it registers a ticket); the hold-oracle wrongly read it
// as terminal. These lock the correct behavior + prove no over-correction.

function healthyPair() {
  return new AccountManager([
    { name: 'maxdubner', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: '2solarmax', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
}

test('FIFO-fairness: thinking newcomer behind a queue HOLDS finite, never error-fasts while healthy accounts idle', () => {
  const am = healthyPair();
  am.queueState.waiting.push({ id: 1 }); // an existing waiter ("queued 1")
  const newcomer = { profile: 'claude', stream: true, sessionKey: 'newcomer', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(newcomer);
  assert.equal(am.acquireAccount(newcomer), null, 'newcomer still cannot JUMP the queue (selection FIFO preserved)');
  assert.ok(Number.isFinite(plan.retryAfterMs), `must HOLD (finite), got ${plan.retryAfterMs}`);
  assert.equal(plan.cause, 'queued_behind_fairness');
  assert.ok(plan.retryAfterMs <= 60_000, 'bounded re-poll, not a multi-day hold');
});

test('FIFO-fairness: a registered thinking waiter advances via FIFO to served (forward progress, no hang)', () => {
  const am = healthyPair();
  const live = () => ({ destroyed: false, writableEnded: false });
  // A real waiter is already at the head of the FIFO (distinct ticket id).
  const ahead = { sessionKey: 'ahead' };
  am.registerQueuedRequest(ahead, { bytes: 0, deadlineAt: Date.now() + 60_000, res: live() });
  // Our thinking newcomer registers BEHIND it.
  const newcomer = { profile: 'claude', stream: true, sessionKey: 'newcomer', requiresAnthropicThinkingIntegrity: true };
  am.registerQueuedRequest(newcomer, { bytes: 0, deadlineAt: Date.now() + 60_000, res: live() });

  // Not the head yet → cannot admit, but is HELD (finite), never error-fasted.
  assert.equal(am.canAdmitQueuedRequest(newcomer), false, 'waits its FIFO turn behind the existing waiter');
  assert.notEqual(am.nextRetryForRequest(newcomer).retryAfterMs, Infinity, 'a registered waiter is never terminal-Infinity');

  // The waiter ahead drains (admitted) → the newcomer becomes head and is SERVED,
  // proving forward progress rather than a wedge.
  assert.equal(am.canAdmitQueuedRequest(ahead), true, 'head admits first (FIFO order preserved)');
  assert.equal(am.canAdmitQueuedRequest(newcomer), true, 'newcomer now advances to head');
  const lease = am.acquireAccount(newcomer);
  assert.ok(lease && lease.account, 'newcomer acquires a healthy account once at the head — served, not killed');
});

test('FIFO-fairness: NON-thinking newcomer behind a queue still uses the provider (unchanged)', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zg', upstream: 'http://glm', profiles: ['all'], priority: 10 },
  ], 0.90);
  am.queueState.waiting.push({ id: 1 });
  const newcomer = { profile: 'all', stream: true, sessionKey: 'nc' }; // NOT thinking; 'all' permits provider
  const plan = am.nextRetryForRequest(newcomer);
  assert.equal(plan.available, true, 'provider fallback still available for a non-thinking newcomer');
});

test('NOT over-corrected: admissionPaused (restart/shutdown shed) stays terminal, does not hold', () => {
  const am = healthyPair();
  am.setAdmissionPaused(true);
  const req = { profile: 'claude', stream: true, sessionKey: 's', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(req);
  assert.equal(plan.retryAfterMs, Infinity, 'restart/shutdown drain must shed new work, not hold it');
});

test('NOT over-corrected: a genuinely terminal fleet (all auth-dead) still error-fasts behind a queue', () => {
  const am = healthyPair();
  am.queueState.waiting.push({ id: 999 });
  am.accounts.forEach(a => { a.status = 'error'; });
  const req = { profile: 'claude', stream: true, sessionKey: 's', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(req);
  assert.equal(plan.retryAfterMs, Infinity, 'no healthy route exists → must still error-fast, not hold forever');
});

test('NOT over-corrected: thinking + ALL accounts weekly-exhausted behind a queue does not fake a 60s fairness hold', () => {
  const am = healthyPair();
  am.queueState.waiting.push({ id: 999 });
  const reset = Date.now() + 3 * 24 * 60 * 60 * 1000; // days away
  am.accounts.forEach(a => { a.quota = { unified7d: 0.99, unified7dReset: reset }; });
  const req = { profile: 'claude', stream: true, sessionKey: 's', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(req);
  // _isAvailable fails the weekly-exhausted gate, so the new branch must NOT fire:
  // promising a 60s "queued_behind_fairness" hold when the only reset is days away
  // would be the very false-near-term-recovery this oracle exists to avoid.
  assert.notEqual(plan.cause, 'queued_behind_fairness', 'must not fake a near-term fairness hold for a weekly-exhausted fleet');
  assert.equal(plan.retryAfterMs, Infinity, 'no eligible route behind the queue → error-fast (unchanged by the fix)');
});

// --- Regression: network blip cools EVERY account behind a FIFO queue (2026-06-27 v1.5.2) ---
// The complement of the 1.5.1 fix: when a VPN/internet drop cools down every account
// (markTransientFailure → finite cooldownUntil) AND a queue already formed, a thinking
// newcomer was still error-killed ("all N at their 5h or weekly limit") because the
// FIFO-fairness gate skipped the cooled accounts entirely, losing their real (finite)
// cooldown reset. A thinking request must now HOLD for the soonest real recovery.

test('network-blip: thinking newcomer behind a queue with ALL accounts network-cooled HOLDS for the real cooldown, never error-kills', () => {
  const am = healthyPair();
  am.accounts.forEach((_, i) => am.markTransientFailure(i, 'ECONNRESET', { network: true })); // VPN/internet drop → short fixed cooldown
  am.queueState.waiting.push({ id: 999 });
  const newcomer = { profile: 'claude', stream: true, sessionKey: 'nc', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(newcomer);
  assert.equal(plan.available, false);
  assert.ok(Number.isFinite(plan.retryAfterMs), `must HOLD, got ${plan.retryAfterMs}`);
  assert.equal(plan.cause, 'cooldown', 'holds on the REAL near-term cooldown reset, not a fake 60s fairness hold');
  assert.ok(plan.retryAfterMs <= 6_000, 'bounded by the SHORT network cooldown (~5s) → auto-recovers fast, not a 15-min bench');
});

test('network-blip: holds the SOONEST cooldown across mixed-cooldown accounts behind a queue', () => {
  const am = healthyPair();
  am.markTransientFailure(0, 'ECONNRESET', { network: true }); // ~5s network cooldown
  am.accounts[1].cooldownUntil = Date.now() + 12_000;          // a longer cooldown
  am.accounts[1].lastError = 'ECONNRESET';
  am.queueState.waiting.push({ id: 999 });
  const newcomer = { profile: 'claude', stream: true, sessionKey: 'nc', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(newcomer);
  assert.ok(Number.isFinite(plan.retryAfterMs));
  assert.ok(plan.retryAfterMs <= 6_000 && plan.retryAfterMs > 3_000, `min-merges to the soonest (~5s) account, got ${plan.retryAfterMs}`);
});

test('oracle/selector agree: a fairness-gated thinking account is NEVER reported available (no busy-spin)', () => {
  const am = healthyPair(); // both healthy
  am.queueState.waiting.push({ id: 999 });
  const newcomer = { profile: 'claude', stream: true, sessionKey: 'nc', requiresAnthropicThinkingIntegrity: true };
  const plan = am.nextRetryForRequest(newcomer);
  // The oracle must say "hold" (available:false) AND selection must refuse it — they
  // must agree, or the caller would loop forever (oracle says go, selector says no).
  assert.equal(plan.available, false, 'oracle never claims available for a gated account');
  assert.equal(am.acquireAccount(newcomer), null, 'selection refuses the gated newcomer (FIFO preserved)');
});

// --- Regression: network-class failures use a SHORT FIXED cooldown (2026-06-29 outage) ---
// A 5-6h hotel-network outage expired every OAuth access token; refreshes failed with
// `fetch failed`, and markTransientFailure's EXPONENTIAL backoff pinned every account at
// the 15-min cap → the fleet stayed benched long after connectivity returned and needed a
// manual restart. Network-class failures must instead recover automatically in seconds.

function oauthExpired(name = 'a1') {
  return { name, type: 'oauth', accessToken: 'at0', refreshToken: 'r0', expiresAt: Date.now() - 1000 };
}

test('network token-refresh failure → short FIXED cooldown, no escalation, no consecutiveFailures bump', async () => {
  const refreshAccessToken = async () => { const e = new Error('fetch failed'); e.retryable = true; throw e; }; // no .status → network
  const am = new AccountManager([oauthExpired()], 0.90,
    { networkCooldownMs: 5000, cooldownMs: 30_000, maxCooldownMs: 900_000 },
    { refreshAccessToken });
  am.setWriterLease(true);
  am.accounts[0].consecutiveFailures = 3; // a pre-existing REQUEST-health signal
  const ok = await am.ensureTokenFresh(0, true);
  const a = am.accounts[0];
  const dt = a.cooldownUntil - Date.now();
  assert.equal(ok, false);
  assert.ok(dt > 3000 && dt <= 5500, `~5s fixed cooldown, not the 15-min bench; got ${dt}ms`);
  assert.equal(a.consecutiveFailures, 3, 'a network blip must NOT poison the request-health counter');
  assert.notEqual(a.status, 'error');
});

test('5xx token-refresh failure stays on the EXPONENTIAL backoff (server-side, not network)', async () => {
  const refreshAccessToken = async () => { const e = new Error('Token refresh failed (503)'); e.status = 503; e.retryable = true; throw e; };
  const am = new AccountManager([oauthExpired()], 0.90,
    { networkCooldownMs: 5000, cooldownMs: 1000, maxCooldownMs: 900_000 },
    { refreshAccessToken });
  am.setWriterLease(true);
  await am.ensureTokenFresh(0, true);
  const a = am.accounts[0];
  const dt = a.cooldownUntil - Date.now();
  assert.equal(a.consecutiveFailures, 1, 'a real server error DOES count toward escalation');
  assert.ok(dt > 500 && dt <= 1200, `exponential base (~1s), distinct from the 5s network path; got ${dt}ms`);
});

test('non-retryable refresh failure (invalid_grant 400) still DISABLES the account, never a 5s loop', async () => {
  const refreshAccessToken = async () => { const e = new Error('invalid_grant'); e.status = 400; e.retryable = false; throw e; };
  const am = new AccountManager([oauthExpired()], 0.90, {}, { refreshAccessToken });
  am.setWriterLease(true);
  await am.ensureTokenFresh(0, true);
  assert.equal(am.accounts[0].status, 'error', 'a bricked/invalid grant must disable, not short-cool');
  assert.equal(am.accounts[0].lastError, 'token_refresh_failed');
});

test('network cooldown is finite even with an EMPTY scheduler config (no NaN strand)', () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.90, {});
  am.markTransientFailure(0, 'network_error', { network: true });
  const a = am.accounts[0];
  const dt = a.cooldownUntil - Date.now();
  assert.ok(Number.isFinite(a.cooldownUntil) && dt > 0 && dt <= 6000, `default networkCooldownMs applies (~5s), not NaN; got ${dt}`);
  assert.equal(a.status === 'throttled', false);
  assert.equal(am._isAvailable(a), false, 'cooled now');
  a.cooldownUntil = Date.now() - 1;
  assert.equal(am._isAvailable(a), true, 'auto-recovers the instant the short cooldown elapses');
});

test('brick-safety: concurrent network-cadence refreshes coalesce to ONE rotation (no single-use double-spend)', async () => {
  // The 5s cooldown narrows the gap between refresh attempts; the single-flight
  // _refreshPromise must still serialize them so the old single-use token is never
  // re-presented after a rotation (which Anthropic answers with invalid_grant → brick).
  let current = 'r0', rotations = 0; const invalidated = new Set();
  const refreshAccessToken = async (rt) => {
    await new Promise(r => setTimeout(r, 20)); // refresh latency > the tiny cooldown
    if (rt !== current || invalidated.has(rt)) { const e = new Error('invalid_grant'); e.status = 400; e.retryable = false; throw e; }
    invalidated.add(current); rotations++; current = `r${rotations}`;
    return { accessToken: `at${rotations}`, refreshToken: current, expiresAt: Date.now() + 3600_000 };
  };
  const am = new AccountManager([oauthExpired()], 0.90, { networkCooldownMs: 5 }, { refreshAccessToken });
  am.setWriterLease(true);
  const results = await Promise.all(Array.from({ length: 8 }, () => am.ensureTokenFresh(0, true)));
  assert.ok(results.every(r => r === true), 'all 8 coalesced refreshes succeed');
  assert.equal(rotations, 1, 'single-flight coalescing → exactly ONE rotation; old token never re-presented');
  assert.equal(am.accounts[0].refreshToken, 'r1');
  assert.notEqual(am.accounts[0].status, 'error', 'never bricked');
});
