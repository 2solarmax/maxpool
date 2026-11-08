// Cache-affinity routing (owner 2026-11-08): in balance mode a conversation stays
// on the account it used last unless real pressure (load gap, quota wall,
// exclusion, failure) says move — because the prompt cache is per account and a
// hop re-writes the whole prefix (72% of all Anthropic cache writes over 24h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const acct = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const am = (n = 3, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => acct(`a${i + 1}`)), 0.9,
  { routingMode: 'balance', ...opts });
const release = (l) => am_ref.releaseAccount(l, { status: 200, success: true });
let am_ref;
const acquire = (mgr, sessionKey = 'sess-x', excluded) => mgr.acquireAccount({ sessionKey, model: 'claude-opus-5-5', weight: 10 }, excluded);
// provider rows are plain-balance (no affinity)

test('balance: consecutive turns stay on the same account at comparable load', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); assert.ok(first, 'first acquire');
  const name1 = first.account.name; release(first);
  const second = acquire(m);
  assert.equal(second.account.name, name1, 'second turn stays on the first account');
  release(second);
});

test('balance: a major load gap moves the session (two large turns of extra depth)', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const sibling = m.accounts.find(a => a.name !== name1);
  sibling.activeWeight = 0; sibling.inFlight = 0;
  // ~3 large turns (weight 30 each ≈ 1080 score points) past the affinity bonus:
  const next = acquire(m, 'sess-x', new Set(), { forceLoad: 100 });
  first.account.activeWeight = 1200;
  const moved = acquire(m, 'sess-x');
  assert.notEqual(moved.account.name, name1, 'session moved off the heavily loaded account');
  release(moved);
});

test('balance: exclusion of the last-used account fails over immediately', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const second = acquire(m, 'sess-x', new Set([first.account.index]));
  assert.ok(second && second.account.name !== name1, 'served by another account');
  release(second);
});

test('bonus is configurable: 0 restores pure balancing (turn can hop)', () => {
  const m = am(2, { cacheAffinityBonus: 0 }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  m.accounts.forEach(a => { a.activeWeight = 0; });
  // Without the bonus the sibling is now strictly lighter → pure balancing hops.
  const sibling = m.accounts.find(a => a.name !== name1); sibling.activeWeight = 0;
  first.account.activeWeight = 20;
  const second = acquire(m);
  assert.notEqual(second.account.name, name1, 'no bonus → hops to the lighter account');
  release(second);
});

test('sticky mode: binding path unchanged (returns the bound account regardless of siblings)', () => {
  const m = am(2, { routingMode: 'sticky' }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.activeWeight = 500; // heavy home still returned in sticky mode
  const second = acquire(m);
  assert.equal(second.account.name, name1);
  release(second);
});
