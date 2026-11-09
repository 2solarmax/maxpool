// D3 / pre-mortem P1: the retry-same hint is a HINT through the normal acquire path —
// never a lease bypass. It passes the same fairness gate and availability checks as any
// pick and falls through to normal selection when either refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function manager(n = 2) {
  return new AccountManager(Array.from({ length: n }, (_, i) => ({
    name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
  })), 0.90);
}

// Make a2 the natural pick so the hint is the ONLY reason a1 could win.
function preferA2(am) { am.accounts[0].activeWeight = 20; am.accounts[0].inFlight = 0; }

test('hint honored: the timed-out account is re-picked through acquireAccount (lease counted)', () => {
  const am = manager();
  preferA2(am);
  assert.equal(am.acquireAccount({ profile: 'claude' }).account.name, 'a2', 'control: a2 is the natural pick');
  am.accounts[1].inFlight = 0; am.accounts[1].activeWeight = 0;
  const lease = am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' });
  assert.equal(lease.account.name, 'a1');
  assert.equal(am.accounts[0].inFlight, 1, 'normal lease accounting');
});

test('hint refused by the in-flight cap → falls through to normal selection', () => {
  const am = manager();
  am.accounts[0].inFlight = am.scheduler.safetyMaxActivePerAccount;
  const lease = am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' });
  assert.equal(lease.account.name, 'a2');
});

test('hint refused by the queue-fairness gate: a waiter ahead keeps the account', () => {
  const am = manager(1);
  am.queueState.waiting.push({ sessionKey: 'someone-else' });
  const lease = am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' });
  assert.equal(lease, null, 'the hint does not jump the FIFO');
  am.queueState.waiting.length = 0;
});

test('hint refused while the account cools down or is rate-limited', () => {
  const am = manager();
  am.accounts[0].cooldownUntil = Date.now() + 10_000;
  assert.equal(am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' }).account.name, 'a2');
  am.accounts[0].cooldownUntil = null;
  am.markRateLimited(0, 60);
  assert.equal(am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' }).account.name, 'a2');
});

test('hint never overrides an exclusion', () => {
  const am = manager();
  preferA2(am);
  const lease = am.acquireAccount({ profile: 'claude', retrySameAccountName: 'a1' }, new Set([0]));
  assert.equal(lease.account.name, 'a2');
});

test('the hint is one-shot: consumed by the acquire, honored or not', () => {
  const am = manager();
  const ri = { profile: 'claude', retrySameAccountName: 'a1' };
  am.acquireAccount(ri);
  assert.equal(ri.retrySameAccountName, null, 'cleared after an honored acquire');
  am.accounts[0].inFlight = am.scheduler.safetyMaxActivePerAccount;
  const ri2 = { profile: 'claude', retrySameAccountName: 'a1' };
  assert.equal(am.acquireAccount(ri2).account.name, 'a2');
  assert.equal(ri2.retrySameAccountName, null, 'cleared after a refused one too');
});

// No knob env is set in this file, so the module constants are the shipped defaults.
test('M05 pin: msPerByte 0 disables scaling (max(floor, 0) = floor), flat floor survives', async () => {
  const { __serverTest } = await import('../src/server.js');
  assert.equal(__serverTest.scaledTtfbMs(5000, 0, 1_000_000, 600_000), 5000);
  assert.equal(__serverTest.scaledTtfbMs(5000, 0, 0, 600_000), 5000);
});

test('shipped defaults: 0.6 ms/byte on both paths, 250KB retry-same threshold', async () => {
  const { __serverTest } = await import('../src/server.js');
  const k = __serverTest.ttfbKnobs();
  assert.equal(k.TTFB_MS_PER_BYTE, 0.6);
  assert.equal(k.LINK_TTFB_MS_PER_BYTE, 0.6);
  assert.equal(k.BIG_PROMPT_BYTES, 250_000);
});
