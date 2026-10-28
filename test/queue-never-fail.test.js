import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';
import { EventEmitter } from 'node:events';

const { waitForAvailableRoute, computeQueueWindowMs } = __serverTest;

// ── owner directive 2026-10-28: "zero reason to drop those requests… even when
// I'm out of accounts completely — I buy new ones." A hold must survive a plan
// with NO finite reset (no_eligible_route / weekly_reset_unknown / all-terminal)
// and keep polling until a route appears — including one that appears WITHOUT any
// scheduled reset (config auto-sync adopts a newly bought account). ──

const fakeAM = (hasRoute) => ({
  hasAvailableRoute: () => hasRoute(),
  canAdmitQueuedRequest: () => true,
  // nextRetryForRequest returns the WORST CASE: Infinity, no eligible route ever
  nextRetryForRequest: () => ({ retryAfterMs: Infinity, cause: 'no_eligible_route' }),
});

function fakeReqRes() {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.destroyed = false;
  return { req, res };
}

test('waitForAvailableRoute keeps polling through an Infinity plan and returns when a NEW account appears', async () => {
  let route = false;
  const am = fakeAM(() => route);
  const { req, res } = fakeReqRes();
  // route appears 400ms in — simulating auto-sync adopting a freshly bought account
  setTimeout(() => { route = true; }, 400);
  const ok = await waitForAvailableRoute(req, res, am, {}, {}, 5000);
  assert.equal(ok, true, 'hold survived the Infinity plan and picked up the new route');
});

test('waitForAvailableRoute returns false at window expiry with NO route (bounded, not spinning)', async () => {
  const am = fakeAM(() => false); // never recovers
  const { req, res } = fakeReqRes();
  const ok = await waitForAvailableRoute(req, res, am, {}, {}, 300);
  assert.equal(ok, false, 'expired cleanly at the window bound');
});

test('computeQueueWindowMs still caps every hold at the client ceilings (no regression)', () => {
  const w = computeQueueWindowMs({
    cause: 'quota', stream: true,
    maxWaitMs: 86400000, capacityMaxWaitMs: 900000, nonStreamMaxWaitMs: 300000,
    streamHoldMaxMs: 604800000, streamClientToleranceMs: 10800000,
  });
  assert.equal(w, 25 * 60 * 1000, 'stream hold capped at the 25m CLI ceiling');
  const w2 = computeQueueWindowMs({
    cause: 'quota', stream: false,
    maxWaitMs: 86400000, capacityMaxWaitMs: 900000, nonStreamMaxWaitMs: 300000,
    streamHoldMaxMs: 604800000, streamClientToleranceMs: 0,
  });
  assert.equal(w2, 300000, 'non-stream hold capped at nonStreamMaxWaitMs');
});
