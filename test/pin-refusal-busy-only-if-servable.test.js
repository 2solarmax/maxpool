// Review 2026-11-16, 2d: the serving pool checked the pin busy cap BEFORE availability,
// so a rate-limited account with >= limit streams still running answered 'busy' — and
// the edge's warm conversation waited (up to the 60 s budget) on an account that could
// not serve for hours. 'busy' must mean "servable once a slot frees"; an unavailable
// account refuses 'unavailable' (the edge moves at once), a throttled egress 'throttled'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function cloud() {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
  ], 0.9);
  const a = am.accounts[0];
  a.inFlight = am._pinBusyLimit(a); // at the pin cap
  return { am, a };
}
const pinned = () => ({ profile: 'claude', pinAccount: 'a', path: '/v1/messages', model: 'claude-opus-5-5' });

test('an available account at its pin cap refuses busy', () => {
  const { am } = cloud();
  const ri = pinned();
  assert.equal(am.acquireAccount(ri), null);
  assert.equal(ri.pinRefusal, 'busy');
  assert.equal(ri.pinRefusedBusy, true);
});

test('a rate-limited account at its pin cap is NOT reported busy', () => {
  const { am, a } = cloud();
  a.status = 'throttled';
  a.rateLimitedUntil = Date.now() + 3 * 3600_000;
  const ri = pinned();
  assert.equal(am.acquireAccount(ri), null);
  assert.notEqual(ri.pinRefusal, 'busy', 'unservable for hours is not "busy"');
  assert.ok(!ri.pinRefusedBusy, 'the edge must not wait on it');
});

test('a cooling-down account at its pin cap is NOT reported busy', () => {
  const { am, a } = cloud();
  a.cooldownUntil = Date.now() + 120_000;
  const ri = pinned();
  assert.equal(am.acquireAccount(ri), null);
  assert.ok(!ri.pinRefusedBusy);
});

test('below the cap an available account is served', () => {
  const { am, a } = cloud();
  a.inFlight = 0;
  const l = am.acquireAccount(pinned());
  assert.equal(l?.account.name, 'a');
  am.releaseAccount(l);
});
