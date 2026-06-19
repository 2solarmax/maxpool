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
