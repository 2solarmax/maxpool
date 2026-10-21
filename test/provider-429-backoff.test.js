// GLM "slow down" backoff (owner 2026-10-21, after z.ai's 2026-10-18 risk notice on
// max+1): a provider 429 must bench the account for a meaningful time, not the
// 3-12s hint z.ai returns — the pool re-selected max+1 seconds after each refusal
// and drew ~200 refusals on 2026-10-16/17. Repeats escalate; a success resets.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const glm = (name) => ({ name, type: 'provider', provider: 'zai', authToken: 'k', upstream: 'http://glm', profiles: ['all'] });
const benchSeconds = (a) => Math.round((a.rateLimitedUntil - Date.now()) / 1000);

test('B1: a GLM 429 with a 5s hint benches the account for at least 60s', () => {
  const am = new AccountManager([glm('g1'), glm('g2')], 0.9);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.ok(benchSeconds(am.accounts[0]) >= 59, `benched ${benchSeconds(am.accounts[0])}s`);
});

// The account is let back in (bench expired) and refused again.
const readmit = (a) => { a.status = 'active'; a.rateLimitedUntil = Date.now() - 1; };

test('B2: back-to-back GLM 429s double the bench, capped at 15 minutes', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  const seen = [];
  for (let i = 0; i < 6; i++) {
    readmit(am.accounts[0]);
    am.markRateLimited(0, 5, { status: 429, recordFailure: false });
    seen.push(benchSeconds(am.accounts[0]));
  }
  assert.deepEqual(seen, [60, 120, 240, 480, 900, 900]);
});

test('B3: a success resets the escalation back to 60s', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  readmit(am.accounts[0]);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  readmit(am.accounts[0]);
  // A served request on this account (the lease shape acquireAccount hands out).
  am.releaseAccount({ account: am.accounts[0], weight: 1, startedAt: Date.now() }, { success: true, status: 200 });
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 60);
});

test('B4: a longer provider hint (weekly reset) is honoured, never shortened', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  am.markRateLimited(0, 3600, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 3600);
});

test('B5: Claude accounts keep the exact retry-after (no floor)', () => {
  const am = new AccountManager([{ name: 'c', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 5);
});

test('B6: a burst of parallel 429s while already benched counts once, not five times', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  for (let i = 0; i < 5; i++) am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 60);
  readmit(am.accounts[0]);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 120, 'next real repeat is step 2, not step 6');
});

test('B7: the escalation forgets after an hour with no refusals', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  readmit(am.accounts[0]);
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  readmit(am.accounts[0]);
  am.accounts[0].providerRateLimitAt = Date.now() - 61 * 60 * 1000;
  am.markRateLimited(0, 5, { status: 429, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 60);
});

test('B8: a provider 403 bench is untouched by the 429 escalation', () => {
  const am = new AccountManager([glm('g1')], 0.9);
  am.markRateLimited(0, 1800, { status: 403, recordFailure: false });
  assert.equal(benchSeconds(am.accounts[0]), 1800);
  assert.equal(am.accounts[0].providerRateLimitStreak || 0, 0);
});
