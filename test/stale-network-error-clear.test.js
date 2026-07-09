import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function manager(count = 2, opts = {}) {
  const accounts = [];
  for (let i = 0; i < count; i++) {
    accounts.push({ name: `a${i + 1}`, type: 'oauth', accessToken: `t${i}`, refreshToken: `r${i}`, expiresAt: Date.now() + 3600_000 });
  }
  if (opts.provider) accounts.push({ name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zt', upstream: 'https://api.z.ai/api/anthropic' });
  return new AccountManager(accounts, 0.90);
}

// ── the reported symptom: a healed network blip keeps showing "Err fetch failed" ──

test('a recovered network blip clears lastError on the next refresh (no phantom Err)', () => {
  const am = manager(2);
  am.markTransientFailure(0, 'fetch failed', { network: true }); // sets lastError, 5s cooldown, NO consecFail bump
  assert.equal(am.accounts[0].lastError, 'fetch failed');
  assert.equal(am.accounts[0].consecutiveFailures, 0, 'a network blip is not the account\'s fault');

  // The 5s cooldown elapses (simulate).
  am.accounts[0].cooldownUntil = Date.now() - 1000;
  am.accounts[0].lastErrorAt = Date.now() - 60_000;

  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].lastError, null, 'a long-healed network blip must not linger as a phantom Err');
  assert.equal(am.accounts[0].lastErrorAt, null);
});

test('the error is RETAINED while the account is still cooling down', () => {
  const am = manager(2);
  am.markTransientFailure(0, 'fetch failed', { network: true });
  am.accounts[0].cooldownUntil = Date.now() + 4000; // still cooling
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].lastError, 'fetch failed', 'still impaired → keep showing why');
});

test('idle provider case: a recovered blip on an unselected provider still clears', () => {
  const am = manager(2, { provider: true });
  const gi = am.accounts.findIndex(a => a.name === 'glm-fallback');
  am.markTransientFailure(gi, 'fetch failed', { network: true });
  am.accounts[gi].cooldownUntil = Date.now() - 1000;
  am.accounts[gi].lastErrorAt = Date.now() - 90 * 60_000; // 90 min ago, exactly the reported case
  am.refreshExpiredQuotas(); // runs for ALL accounts, incl. never-selected providers
  assert.equal(am.accounts[gi].lastError, null, 'an idle provider never gets a new request — refresh must clear it');
});

// ── a genuine per-account fault must STILL show its error ──────────────────────

test('a real per-account failure (consecutiveFailures>0) KEEPS its error after cooldown', () => {
  const am = manager(2);
  am.markTransientFailure(0, 'proxy_error'); // non-network → bumps consecutiveFailures
  assert.ok(am.accounts[0].consecutiveFailures > 0);
  am.accounts[0].cooldownUntil = Date.now() - 1000; // cooldown elapsed
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].lastError, 'proxy_error', 'a flaky account keeps its error visible (ongoing trouble)');
});

test('an auth-dead account (status=error) KEEPS its error', () => {
  const am = manager(2);
  am.accounts[0].status = 'error';
  am.accounts[0].lastError = 'auth_failed';
  am.accounts[0].lastErrorAt = Date.now() - 60_000;
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].lastError, 'auth_failed', 'a real fault is not a healed blip');
});

test('a still-throttled (rate-limited) account keeps its error until its own recovery path clears it', () => {
  const am = manager(2);
  am.markRateLimited(0, 300, { status: 429 });
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].status, 'throttled');
  assert.notEqual(am.accounts[0].lastError, null, 'throttled → not a healed network blip');
});
