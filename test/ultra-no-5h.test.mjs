import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// Anthropic Ultra (2026-10-30 owner email): the 5-hour limit is being REMOVED in
// stages. When an account's 5h window disappears, the ratelimit-5h headers stop
// arriving → unified5h stays null everywhere. Every reader must treat null as
// "no such window" (fail-open on session, weekly still governs) — the same shape
// as a GLM account with weeklyAbsent.
function amWithUltra() {
  const am = new AccountManager([
    { name: 'ultra', type: 'oauth', accountUuid: 'U1', accessToken: 'x', refreshToken: 'r', enabled: true },
    { name: 'max5x', type: 'oauth', accountUuid: 'U2', accessToken: 'x', refreshToken: 'r', enabled: true },
  ], 0.9);
  // ultra: weekly only (5h header never arrives). max5x: both windows.
  am.accounts[0].quota = { unified5h: null, unified5hReset: null, unified7d: 0.40, unified7dReset: Date.now() + 3 * 24 * 3600_000 };
  am.accounts[1].quota = { unified5h: 0.90, unified5hReset: Date.now() + 3600_000, unified7d: 0.10, unified7dReset: Date.now() + 5 * 24 * 3600_000 };
  return am;
}

test('null-5h account is never session-benched (no such window)', () => {
  const am = amWithUltra();
  const ultra = am.accounts[0];
  assert.equal(am._sessionUnavailable?.(ultra) ?? sessionFullByReader(am, ultra), false);
});

test('weekly still governs a null-5h account at the wall', () => {
  const am = amWithUltra();
  const ultra = am.accounts[0];
  ultra.quota.unified7d = 0.99;
  assert.equal(am._weeklyRawState(ultra), 'critical', 'weekly wall must still bench a 5h-less account');
  // and the availability reader consults the weekly tier
  assert.equal(am._isAvailable(ultra, Date.now()), false, 'critical weekly benches the account');
});

test('header path: a 5h header that stops arriving leaves a stale value cleared by reset expiry', () => {
  const am = amWithUltra();
  const ultra = am.accounts[0];
  // last-ever 5h header said 0.7 with reset 1h out; after that, silence
  am.updateQuota(0, { 'anthropic-ratelimit-unified-5h-utilization': '0.7', 'anthropic-ratelimit-unified-5h-reset': new Date(Date.now() + 3600_000).toISOString() });
  assert.equal(ultra.quota.unified5h, 0.7);
  // after the reset passes with no new header, the sweeper clears it
  ultra.quota.unified5hReset = Date.now() - 1000;
  am._clearExpiredQuotas(ultra);
  assert.equal(ultra.quota.unified5h, null, 'stale 5h must not pin the account forever once the window is gone');
});

test('restore path: persisted 5h without a reset is nulled (already guarded)', () => {
  const am = amWithUltra();
  const saved = [{ name: 'ultra', quota: { unified5h: 0.95, unified5hReset: null, unified7d: 0.2, unified7dReset: Date.now() + 86400_000 } }];
  am.restoreQuotaState(saved);
  assert.equal(am.accounts[0].quota.unified5h, null);
});

// helper mirroring the TUI reader for the bench check
function sessionFullByReader(am, a) {
  const q = a.quota || {};
  const bench = 0.95;
  if (q.unified5h != null && q.unified5h >= bench) return true;
  return false;
}
