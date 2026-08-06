import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const fleet = names => new AccountManager(
  names.map(n => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 })),
  0.90,
);
// Shape an account exactly as production does: utilization + the upstream's own verdict.
function setWeekly(am, name, used, unifiedStatus) {
  const a = am.accounts.find(x => x.name === name);
  a.quota.unified7d = used;
  a.quota.unified7dReset = Date.now() + 3 * 24 * 3600_000;
  a.quota.unifiedStatus = unifiedStatus;
  return a;
}

test('an account at 100% that the upstream still ALLOWS is routable', () => {
  // Measured 2026-08-06: max@gomokka.com sat benched at unified7d=1.00 with
  // unifiedStatus='allowed_warning' and returned 200 to a live request. maxpool let a
  // threshold outrank Anthropic's own verdict and withheld real capacity.
  const am = fleet(['solo']);
  setWeekly(am, 'solo', 1.0, 'allowed_warning');
  assert.notEqual(am._weeklyRawState(am.accounts[0]), 'exhausted', 'allowed ⇒ not benched');
  // Drive REAL selection, not just the predicate — the predicate alone proves nothing
  // about routing (that mistake hid a defect in the previous attempt at this fix).
  const lease = am.acquireAccount({ profile: 'claude' }, new Set());
  assert.ok(lease, 'selection actually returns it');
  assert.equal(lease.account.name, 'solo');
});

test('a genuinely REJECTED account is still benched', () => {
  const am = fleet(['solo']);
  setWeekly(am, 'solo', 1.0, 'rejected');
  assert.equal(am._weeklyRawState(am.accounts[0]), 'exhausted', 'the negative case is unchanged');
  assert.equal(am.acquireAccount({ profile: 'claude' }, new Set()), null, 'selection refuses it');
});

test('an account at 100% with NO upstream verdict is still benched (unchanged default)', () => {
  // Absence of a verdict is not permission — the threshold remains authoritative.
  const am = fleet(['solo']);
  setWeekly(am, 'solo', 1.0, null);
  assert.equal(am._weeklyRawState(am.accounts[0]), 'exhausted');
  assert.equal(am.acquireAccount({ profile: 'claude' }, new Set()), null);
});

test('the override is scoped to exhaustion — critical still applies its soft cost', () => {
  const am = fleet(['solo']);
  setWeekly(am, 'solo', 0.96, 'allowed_warning');
  assert.equal(am._weeklyRawState(am.accounts[0]), 'critical', 'critical is untouched by the override');
});

test('a healthy account is still preferred over an allowed-but-saturated one', () => {
  // The override makes a saturated account USABLE, not attractive — it must not steal
  // traffic from an account with real headroom.
  const am = fleet(['healthy', 'saturated']);
  setWeekly(am, 'healthy', 0.10, 'allowed');
  setWeekly(am, 'saturated', 1.0, 'allowed_warning');
  const lease = am.acquireAccount({ profile: 'claude' }, new Set());
  assert.equal(lease.account.name, 'healthy', 'headroom still wins');
});

test('when the healthy account is excluded, the allowed-saturated one takes over', () => {
  const am = fleet(['healthy', 'saturated']);
  setWeekly(am, 'healthy', 0.10, 'allowed');
  setWeekly(am, 'saturated', 1.0, 'allowed_warning');
  const hIdx = am.accounts.findIndex(a => a.name === 'healthy');
  const lease = am.acquireAccount({ profile: 'claude' }, new Set([hIdx]));
  assert.ok(lease, 'the fleet does not go dark');
  assert.equal(lease.account.name, 'saturated');
});
