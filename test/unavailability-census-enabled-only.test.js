import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Reported 2026-08-13: "all 9 Claude accounts are momentarily busy" while only ONE
// account was enabled (the other 8 disabled with dead tokens after an Aug-6 token
// expiry). The user read 9-busy as fleet saturation; the truth was 1-busy + 8-off.
// Root cause: unavailabilityCensus and claudeCount counted DISABLED accounts in the
// total, and the transient-dominant branch amplified it to "all N busy".

const mkAccounts = (n, { enabledFirst = 1 } = {}) => Array.from({ length: n }, (_, i) => ({
  name: `acct${i}`,
  type: 'oauth',
  enabled: i < enabledFirst,
  accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000,
  quota: {},
  status: 'active',
  inFlight: 0,
}));

test('census EXCLUDES disabled accounts from total (the "all 9 busy" bug)', () => {
  const am = new AccountManager(mkAccounts(9, { enabledFirst: 1 }), 0.90);
  // Put the ONE enabled account into a short network cooldown.
  am.accounts[0].cooldownUntil = Date.now() + 3000;
  const c = am.unavailabilityCensus();
  assert.equal(c.total, 1, 'only the enabled account is in the serving pool');
  assert.equal(c.disabled, 8, 'disabled accounts are tracked separately');
  assert.equal(c.transient, 1, 'the cooldown reads as transient');
  assert.equal(c.network, 1, 'and as a network blip (window ≈ networkCooldownMs)');
});

test('census with all enabled still counts every account', () => {
  const am = new AccountManager(mkAccounts(4, { enabledFirst: 4 }), 0.90);
  const c = am.unavailabilityCensus();
  assert.equal(c.total, 4);
  assert.equal(c.disabled, 0);
});

test('disabled accounts do not flip the dominant cause', () => {
  const am = new AccountManager(mkAccounts(5, { enabledFirst: 1 }), 0.90);
  // The one enabled account is FINE (no blocker). Without the fix, 4 disabled
  // accounts made eligible = 1 and could misclassify; now they're simply absent.
  const c = am.unavailabilityCensus();
  assert.equal(c.dominant, 'other', 'a healthy lone account is not transient/quota');
});

test('quota-dominant classification uses enabled accounts only', () => {
  const am = new AccountManager(mkAccounts(3, { enabledFirst: 2 }), 0.90);
  // Both enabled accounts weekly-exhausted; one disabled.
  for (const a of am.accounts.slice(0, 2)) {
    a.quota.unified7d = 0.999;
    a.quota.unified7dReset = Date.now() + 5 * 86400_000;
  }
  const c = am.unavailabilityCensus();
  assert.equal(c.quota, 2);
  assert.equal(c.dominant, 'quota');
});
