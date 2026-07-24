import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// Build a fleet of OAuth (Claude) accounts and stamp each one's weekly quota so we can
// drive _weeklyRawState / _windowScarcity deterministically. resetInMs from "now".
function fleet(specs) {
  const am = new AccountManager(
    specs.map((s, i) => ({
      name: s.name, type: 'oauth', accessToken: `t${i}`, refreshToken: `r${i}`,
      expiresAt: Date.now() + HOUR,
    })),
    0.90,
  );
  specs.forEach((s, i) => {
    am.accounts[i].quota.unified7d = s.weekly;
    am.accounts[i].quota.unified7dReset = s.resetInMs != null ? Date.now() + s.resetInMs : Date.now() + 3 * DAY;
  });
  return am;
}

// ── _reserveCost: 0 for every tier except reserve ─────────────────────────────

test('_reserveCost is 0 for normal/soft/critical/exhausted, non-zero only in the reserve band', () => {
  const am = fleet([
    { name: 'normal', weekly: 0.30 },
    { name: 'soft', weekly: 0.70 },
    { name: 'reserve', weekly: 0.88, resetInMs: 2 * DAY },
    { name: 'critical', weekly: 0.96 },
    { name: 'exhausted', weekly: 0.9995 },   // >= 0.999 exhausted threshold
  ]);
  const [normal, soft, reserve, critical, exhausted] = am.accounts;
  assert.equal(am._reserveCost(normal), 0, 'normal not softened');
  assert.equal(am._reserveCost(soft), 0, 'soft not softened');
  assert.ok(am._reserveCost(reserve) > 0, 'reserve carries an overflow cost');
  assert.equal(am._reserveCost(critical), 0, 'critical is hard-benched, never softened');
  assert.equal(am._reserveCost(exhausted), 0, 'exhausted is hard-benched, never softened');
});

// ── use-it-or-lose-it: the soonest-to-reset reserve account is the cheapest ────

test('a near-reset reserve account is cheaper than a far-from-reset one at the same utilization', () => {
  const am = fleet([
    { name: 'near', weekly: 0.88, resetInMs: 2 * HOUR },     // resets soon → quota would be wasted → use freely
    { name: 'far', weekly: 0.88, resetInMs: 6.5 * DAY },     // fresh window → preserve
  ]);
  const [near, far] = am.accounts;
  assert.ok(am._reserveCost(near) < am._reserveCost(far),
    `near-reset (${am._reserveCost(near).toFixed(2)}) must cost less than far-from-reset (${am._reserveCost(far).toFixed(2)})`);
});

test('deeper into the reserve band costs more (preserve accounts nearing critical)', () => {
  const am = fleet([
    { name: 'shallow', weekly: 0.86, resetInMs: 3 * DAY },
    { name: 'deep', weekly: 0.94, resetInMs: 3 * DAY },
  ]);
  assert.ok(am._reserveCost(am.accounts[0]) < am._reserveCost(am.accounts[1]), 'band term makes the near-critical account costlier');
});

// ── selection: healthy first, but reserve is OVERFLOW (not benched behind a wall) ─

test('an idle healthy account is preferred over an idle reserve account', () => {
  const am = fleet([
    { name: 'healthy', weekly: 0.30 },
    { name: 'reserve', weekly: 0.88, resetInMs: 2 * DAY },
  ]);
  const lease = am.acquireAccount({});
  assert.equal(lease.account.name, 'healthy', 'healthy wins when both are idle');
});

test('a RESERVE account IS selected (not benched) once every healthy account is slammed past its cap', () => {
  const am = fleet([
    { name: 'healthy', weekly: 0.30 },
    { name: 'reserve', weekly: 0.88, resetInMs: 2 * DAY },
  ]);
  // Pile concurrency onto the healthy account so its capPenalty (unbounded) exceeds the
  // reserve floor — the overflow the reserve account exists to absorb.
  am.accounts[0].activeWeight = 8;
  const lease = am.acquireAccount({});
  assert.equal(lease.account.name, 'reserve', 'reserve absorbs overflow instead of dogpiling the slammed healthy account');
});

test('the near-reset reserve account is chosen over the far-from-reset one when reserve is used', () => {
  const am = fleet([
    { name: 'healthy', weekly: 0.30 },
    { name: 'reserve-near', weekly: 0.88, resetInMs: 2 * HOUR },
    { name: 'reserve-far', weekly: 0.88, resetInMs: 6.5 * DAY },
  ]);
  am.accounts[0].activeWeight = 8;   // healthy slammed → fall to reserve
  const lease = am.acquireAccount({});
  assert.equal(lease.account.name, 'reserve-near', 'use-it-or-lose-it picks the soonest-to-reset reserve account');
});

// ── critical stays benched behind reserve (only reached when healthy+reserve empty) ─

test('a critical account is NOT used while a reserve account is available (pass-2 fallback preserved)', () => {
  const am = fleet([
    { name: 'reserve', weekly: 0.90, resetInMs: 2 * DAY },
    { name: 'critical', weekly: 0.96 },
  ]);
  const lease = am.acquireAccount({});
  assert.equal(lease.account.name, 'reserve', 'reserve (pass 1) is chosen before critical (pass 2)');
});

test('a critical account IS still reachable when it is the only option (2nd pass intact)', () => {
  const am = fleet([{ name: 'critical', weekly: 0.96 }]);
  const lease = am.acquireAccount({});
  assert.equal(lease.account.name, 'critical', 'the hard fallback still serves when nothing healthier exists');
});

// ── A1 tail case (pre-mortem): leaving a reserve account with all-healthy-slammed ─

test('A1 tail: a session leaving a reserve account MAY re-home onto a lightly-loaded reserve over a slammed healthy one', () => {
  // The whole point of the model is to USE reserve accounts — so when the only healthy
  // account is slammed, re-homing onto a fresh reserve account is correct load-spread,
  // not the "never re-pick the reserve" invariant the old healthy-only pass enforced.
  const am = fleet([
    { name: 'healthy', weekly: 0.30 },
    { name: 'reserve', weekly: 0.88, resetInMs: 2 * DAY },
  ]);
  am.accounts[0].activeWeight = 10;                 // healthy hammered
  const lease = am.acquireAccount({ sessionKey: 's1' });
  assert.equal(lease.account.name, 'reserve', 'reserve is a legitimate overflow target, not walled off');
});
