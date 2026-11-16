// A request that waits in the queue and is refused by the same cloud row on every
// release is ONE bounced request, not one per release. 2026-11-16 (Mac pool, GLM out of
// weekly room on 9 of 11 accounts): 509 served vs 1,095 bounces in 15 minutes made the
// dashboard read "bounced 69%" although far fewer requests were ever refused, and one
// 575 KB request logged "conversation moved: glm3 ☁ → max ☁" 29 times in 27 minutes.
// Owner: "red team and go".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function pool() {
  return new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 36e5 },
    { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
}
const lease = (account, requestInfo) => { account.inFlight++; return { account, weight: 1, startedAt: Date.now() - 50, requestInfo }; };
const bounce = { bounced: true, status: 503, error: 'remote_pinned_busy', refusal: 'busy' };

test('one request refused three times by the same row counts as ONE bounce', () => {
  const am = pool(); const a = am.accounts[0];
  const ri = { path: '/v1/messages' };
  for (let i = 0; i < 3; i++) am.releaseAccount(lease(a, ri), bounce);
  assert.equal(a.inFlight, 0, 'every lease is still released');
  assert.equal(am._loadSummary(a, 15 * 60_000).bounced, 1, 'per-row bounced');
  assert.equal(am._efficiencySummary(a, 15 * 60_000).bounced, 1, 'efficiency bounced');
});

test('two different requests refused by the same row count as TWO bounces', () => {
  const am = pool(); const a = am.accounts[0];
  am.releaseAccount(lease(a, { path: '/v1/messages' }), bounce);
  am.releaseAccount(lease(a, { path: '/v1/messages' }), bounce);
  assert.equal(am._loadSummary(a, 15 * 60_000).bounced, 2);
  assert.equal(am._efficiencySummary(a, 15 * 60_000).bounced, 2);
});

test('one request refused by two different rows counts once on EACH row', () => {
  const am = pool(); const [a, b] = am.accounts;
  const ri = { path: '/v1/messages' };
  am.releaseAccount(lease(a, ri), bounce);
  am.releaseAccount(lease(b, ri), bounce);
  am.releaseAccount(lease(a, ri), bounce);
  assert.equal(am._loadSummary(a, 15 * 60_000).bounced, 1);
  assert.equal(am._loadSummary(b, 15 * 60_000).bounced, 1);
});

test('a lease with no request info still counts its bounce (unit callers, old paths)', () => {
  const am = pool(); const a = am.accounts[0];
  am.releaseAccount(lease(a, undefined), bounce);
  am.releaseAccount(lease(a, undefined), bounce);
  assert.equal(am._loadSummary(a, 15 * 60_000).bounced, 2, 'no identity → nothing to dedupe on');
});

test('the refused (non-busy) count follows the same once-per-request rule', () => {
  const am = pool(); const a = am.accounts[0];
  const ri = { path: '/v1/messages' };
  const thr = { bounced: true, status: 503, error: 'remote_pinned_throttled', refusal: 'throttled' };
  for (let i = 0; i < 4; i++) am.releaseAccount(lease(a, ri), thr);
  const e = am._efficiencySummary(a, 15 * 60_000);
  assert.equal(e.bounced, 1);
  assert.equal(e.refused, 1);
});

// ── the move log: once per request, not once per queue release ────────────────
import { test as test2 } from 'node:test';
const capture = (fn) => {
  const logs = []; const orig = console.log;
  console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  try { fn(); } finally { console.log = orig; }
  return logs;
};

// The live shape (2026-11-16): conversation-keyed requests with no session binding, each
// held in the queue and re-routed on every release after the cloud row refused it busy.
const acctN = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}` });
const mkRi = (bodyBytes = 575_446) => ({ affinityKey: 'cv:h', model: 'claude-opus-5-5', weight: 10, bodyBytes, profile: 'all' });
const busy = { bounced: true, status: 503, error: 'remote_pinned_busy', refusal: 'busy' };
function homeThenThrottled() {
  const am = new AccountManager([acctN('glm3'), acctN('max')], 0.9);
  am._noteConversationAccount(mkRi(), am.accounts[0]);
  am.noteConversationServed(mkRi(), am.accounts[0]);
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 60_000;
  return am;
}
const reroute = (am, ri) => capture(() => {
  const lease = am.acquireAccount(ri, new Set());
  if (lease) am.releaseAccount(lease, busy);
}).filter(x => x.includes('conversation moved:'));

test2('one queued request re-routed four times logs its move ONCE', () => {
  const am = homeThenThrottled();
  const ri = mkRi();
  const lines = [];
  for (let i = 0; i < 4; i++) lines.push(...reroute(am, ri));
  assert.equal(lines.length, 1, `one move line for one request: ${JSON.stringify(lines)}`);
  assert.match(lines[0], /conversation moved: glm3 → max \(575446B\)/);
});

test2('two different queued requests of the conversation each log their own move', () => {
  const am = homeThenThrottled();
  const a = mkRi(575_446), b = mkRi(627_848);
  const lines = [...reroute(am, a), ...reroute(am, b), ...reroute(am, a), ...reroute(am, b)];
  assert.equal(lines.length, 2, `one line per request: ${JSON.stringify(lines)}`);
});
