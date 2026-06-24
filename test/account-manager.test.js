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
