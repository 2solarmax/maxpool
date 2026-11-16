// Route EXISTENCE must not be decided by the stale 30s-poll depth snapshot. A cloud row
// at limit-1 still has a free slot (the cloud refuses only at >= limit), so a row whose
// _remoteInflightCount reads limit-1 is still a ROUTE — depth belongs to placement
// RANKING only. hasAvailableRoute must use only the time-capped pinBusyUntil signal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function build() {
  const am = new AccountManager([
    { name: 'cloud-a ☁', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'cloud-b ☁', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
  for (const a of am.accounts) {
    a.remote = { linkName: 'team', link: { lastOkAt: Date.now() } };
    a._remotePinLimit = 6;
    a._remoteInflightCount = 5; // limit-1: one slot still free on the cloud
  }
  return am;
}

test('a mirror row at limit-1 depth is still a route (one free slot)', () => {
  const am = build();
  assert.equal(am.hasAvailableRoute({ profile: 'claude', path: '/v1/messages' }, new Set()), true,
    'hasAvailableRoute must not call depth-limit-1 rows "no route"');
});

test('a fresh busy refusal (pinBusyUntil) still closes the route for non-holders', () => {
  const am = build();
  const ri = { profile: 'claude', path: '/v1/messages' };
  am.accounts[0].pinBusyUntil = Date.now() + 3000;
  // Row A closed by its own refusal, row B still a route at limit-1 depth.
  assert.equal(am.hasAvailableRoute(ri, new Set()), true);
  am.accounts[1].pinBusyUntil = Date.now() + 3000;
  // Both refused within their 1-5s busy window: no route until one clears.
  assert.equal(am.hasAvailableRoute(ri, new Set()), false,
    'the time-capped pinBusyUntil branch still blocks the sub-second spin');
});

test('the holder still sees its busy row as a route; a non-holder does not', () => {
  const am = build();
  // Both rows just refused busy, so ONLY the holder path can make a route exist.
  for (const a of am.accounts) a.pinBusyUntil = Date.now() + 3000;
  am.conversationLastAccount.set('k1', am.accounts[0].name);
  const holder = { profile: 'claude', path: '/v1/messages', affinityKey: 'k1' };
  const stranger = { profile: 'claude', path: '/v1/messages', affinityKey: 'k2' };
  assert.equal(am.hasAvailableRoute(holder, new Set()), true,
    'the conversation holding the row keeps it as a route while it waits');
  assert.equal(am.hasAvailableRoute(stranger, new Set()), false,
    'a non-holder sees no route while every row is inside its busy window');
  holder._busyExcluded = new Set([am.accounts[0].name]);
  assert.equal(am.hasAvailableRoute(holder, new Set()), false,
    'once the holder gave up waiting on it (_busyExcluded), it is no route either');
});

// Review 2026-11-16, 2c: the poll snapshot counted this pool's own leases at poll time,
// and a refusal's depth overwrote it until the next poll (~30 s).
test('our own finished requests stop counting against a cloud row before the next poll', () => {
  const am = build();
  const a = am.accounts[0];
  a.inFlight = 4;                 // 4 of the 5 at poll time are ours
  a._remoteOwnAtSync = 4;
  assert.equal(am._pinBusyForNew(a), true, 'at poll time: 5 of 6, skipped by new placements');
  a.inFlight = 0;                 // ours finished
  assert.equal(am._remoteDepthEstimate(a), 1, 'only the teammate request remains');
  assert.equal(am._pinBusyForNew(a), false, 'the row is open to new placements again');
});

test('a refusal depth repels only within its busy window, not until the next poll', () => {
  const am = build();
  const a = am.accounts[1];
  a._remoteInflightCount = 0; a._remoteOwnAtSync = 0;
  am.noteRemoteDepth(a.name, 6, 6);
  assert.equal(am._pinBusyForNew(a), true, 'fresh refusal depth repels');
  a._refusalDepthUntil = Date.now() - 1;   // the window passed
  assert.equal(am._pinBusyForNew(a), false, 'the poll snapshot (0) rules again');
  assert.equal(a._remoteInflightCount, 0, 'the refusal never overwrote the snapshot');
});
