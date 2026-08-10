import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function makeFleet(opts = {}) {
  const am = new AccountManager(
    [{ name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }],
    0.90, opts,
  );
  am.loadConfigProviders([
    { name: 'glm', provider: 'zai', token: 'k1' },
    { name: 'kimi', provider: 'kimi', token: 'k2' },
  ]);
  return am;
}

function dist(am, n = 20, profile = 'all') {
  const c = {};
  for (let i = 0; i < n; i++) {
    const l = am.acquireAccount({ profile, sessionKey: 's' + i }, new Set());
    c[l?.account?.name] = (c[l?.account?.name] || 0) + 1;
    am.releaseAccount(l, { success: true });
  }
  return c;
}

// ── mode migration ────────────────────────────────────────────────────────────

test('legacy always → balance', () => {
  assert.equal(makeFleet({ crossProviderFallbackPolicy: 'always' }).scheduler.routingMode, 'balance');
});

test('legacy when-exhausted → prefer-claude', () => {
  assert.equal(makeFleet({ crossProviderFallbackPolicy: 'when-exhausted' }).scheduler.routingMode, 'prefer-claude');
});

test('legacy never / default → sticky', () => {
  assert.equal(makeFleet({ crossProviderFallbackPolicy: 'never' }).scheduler.routingMode, 'sticky');
  assert.equal(makeFleet().scheduler.routingMode, 'sticky', 'no options → sticky');
});

test('explicit routingMode wins over legacy policy', () => {
  assert.equal(makeFleet({ routingMode: 'balance', crossProviderFallbackPolicy: 'never' }).scheduler.routingMode, 'balance');
});

// ── balance ───────────────────────────────────────────────────────────────────

test('balance: one session spreads across multiple accounts', () => {
  const am = makeFleet({ routingMode: 'balance' });
  const c = {};
  for (let i = 0; i < 9; i++) {
    const l = am.acquireAccount({ profile: 'all', sessionKey: 'SAME' }, new Set());
    c[l?.account?.name] = (c[l?.account?.name] || 0) + 1;
    am.releaseAccount(l, { success: true });
  }
  assert.ok(Object.keys(c).length > 1, `balance must spread: ${JSON.stringify(c)}`);
});

test('balance: an account at 80% session loses to one at 10%', () => {
  const am = makeFleet({ routingMode: 'balance' });
  am.accounts[0].quota.unified5h = 0.80; am.accounts[0].quota.unified5hReset = Date.now() + 2 * 3600_000;
  am.accounts[1].quota.providerSes = 0.10;
  am.accounts[2].quota.providerSes = 0.10; // kimi also cheap — so cc should get least
  const c = {};
  for (let i = 0; i < 20; i++) {
    const l = am.acquireAccount({ profile: 'all', sessionKey: 's' }, new Set());
    c[l?.account?.name] = (c[l?.account?.name] || 0) + 1;
    am.releaseAccount(l, { success: true });
  }
  assert.ok((c['cc'] || 0) < (c['glm'] || 0), `cc at 80% should get less than glm at 10%: ${JSON.stringify(c)}`);
});

test('balance: equal-utilization accounts split evenly', () => {
  const am = makeFleet({ routingMode: 'balance' });
  const c = dist(am, 30);
  const vals = Object.values(c);
  assert.ok(Math.max(...vals) - Math.min(...vals) <= 2, `roughly even: ${JSON.stringify(c)}`);
});

// ── prefer-claude ─────────────────────────────────────────────────────────────

test('prefer-claude: healthy Claude gets all traffic', () => {
  const am = makeFleet({ routingMode: 'prefer-claude' });
  const c = dist(am, 20);
  assert.equal(c['cc'], 20, `all to Claude: ${JSON.stringify(c)}`);
});

test('prefer-claude: providers serve when Claude is exhausted', () => {
  const am = makeFleet({ routingMode: 'prefer-claude' });
  am.accounts[0].quota.unified5h = 0.999;
  am.accounts[0].quota.unifiedStatus = 'rejected';
  const c = dist(am, 20);
  assert.equal(c['cc'] || 0, 0);
  assert.ok((c['glm'] || 0) + (c['kimi'] || 0) === 20);
});

// ── sticky ────────────────────────────────────────────────────────────────────

test('sticky: a session stays on its first account', () => {
  const am = makeFleet({ routingMode: 'sticky', crossProviderFallbackPolicy: 'always' });
  const first = am.acquireAccount({ profile: 'all', sessionKey: 's1' }, new Set());
  am.releaseAccount(first, { success: true });
  const names = new Set();
  for (let i = 0; i < 10; i++) {
    const l = am.acquireAccount({ profile: 'all', sessionKey: 's1' }, new Set());
    names.add(l?.account?.name);
    am.releaseAccount(l, { success: true });
  }
  assert.equal(names.size, 1, `sticky stays on one: ${[...names]}`);
});

// ── setProviderRoutingMode ────────────────────────────────────────────────────

test('setProviderRoutingMode updates the mode', () => {
  const am = makeFleet({ routingMode: 'sticky' });
  assert.equal(am.setProviderRoutingMode('balance'), true);
  assert.equal(am.scheduler.routingMode, 'balance');
  assert.equal(am.setProviderRoutingMode('invalid'), false);
});
