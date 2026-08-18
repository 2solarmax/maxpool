import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Reproduced 2026-08-18: a weekly-EXHAUSTED provider (GLM/Kimi) returned
// retryAt:null from _retryInfo because the branch read `unified7dReset`, an
// ANTHROPIC-only field. Providers store their weekly reset in `providerWkReset`
// (applyProviderUsage). null → weeklyUnknownReset → nextRetryForRequest returns
// retryAfterMs:Infinity → server.js error-fasts → the live session is KILLED,
// even though the real reset time was known the whole time.
//
// Not hypothetical: on 2026-08-17 both `kimi max@` and `glm glm1@` sat at 100%
// weekly in the user's pool.

const providerFleet = () => new AccountManager([
  { name: 'glm', type: 'provider', provider: 'zai', apiKey: 'k', profiles: ['all'] },
], 0.90, { routingMode: 'balance' });

test('a weekly-exhausted PROVIDER holds finite on its own reset field', () => {
  const am = providerFleet();
  const a = am.accounts[0];
  a.quota.providerWk = 0.9995;
  a.quota.providerWkReset = Date.now() + 3 * 86400_000;
  a.quota.unified7dReset = null;            // providers never populate this

  const info = am._retryInfo(a, null);
  assert.equal(info.cause, 'weekly_exhausted');
  assert.ok(info.retryAt, 'retryAt must come from providerWkReset, not be null');

  const plan = am.nextRetryForRequest({ profile: 'all' }, new Set());
  assert.ok(Number.isFinite(plan.retryAfterMs),
    `oracle must hold FINITE (got ${plan.retryAfterMs}) — Infinity kills the session`);
  assert.ok(plan.retryAfterMs > 2.9 * 86400_000 && plan.retryAfterMs < 3.1 * 86400_000,
    'hold equals the real weekly reset distance');
});

test('an Anthropic account still keys on unified7dReset (no regression)', () => {
  const am = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90, { routingMode: 'balance' });
  const a = am.accounts[0];
  a.quota.unified7d = 0.9995;
  a.quota.unified7dReset = Date.now() + 2 * 86400_000;

  const info = am._retryInfo(a, null);
  assert.equal(info.cause, 'weekly_exhausted');
  assert.ok(info.retryAt, 'Anthropic path unchanged');
  assert.ok(Number.isFinite(am.nextRetryForRequest({}, new Set()).retryAfterMs));
});

test('genuinely-unknown reset still reports Infinity (the honest case survives)', () => {
  const am = providerFleet();
  const a = am.accounts[0];
  a.quota.providerWk = 0.9995;
  a.quota.providerWkReset = null;           // truly unknown
  a.quota.unified7dReset = null;

  const plan = am.nextRetryForRequest({ profile: 'all' }, new Set());
  assert.equal(plan.retryAfterMs, Infinity,
    'an UNKNOWN reset must still be honestly Infinity — the fix must not fabricate a time');
  assert.equal(plan.cause, 'weekly_reset_unknown');
});
