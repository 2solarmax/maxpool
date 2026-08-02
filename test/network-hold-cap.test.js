import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';
const { computeQueueWindowMs } = __serverTest;

const base = {
  stream: true, maxWaitMs: 24 * 3600_000, capacityMaxWaitMs: 15 * 60_000,
  nonStreamMaxWaitMs: 300_000, streamHoldMaxMs: 7 * 24 * 3600_000,
  streamClientToleranceMs: 3 * 3600_000,          // the `cc` alias raises the client watchdog to 3h
  networkMaxWaitMs: 120_000,
};

test('a NETWORK-cause hold now gets the SAME ceiling as any other cause', () => {
  // REVERSED on evidence 2026-08-02. The 2-minute cap was "make the wait visible"
  // implemented as "make it fail": maxpool already re-polls ~1s and issues a FRESH fetch
  // each retry, so a hold IS "keep probing, resume the moment a route returns". Failing
  // fast handed the turn to Claude Code's retry loop — which is exactly what loses an
  // unattended agent's accumulated work.
  const w = computeQueueWindowMs({ ...base, cause: 'network', retryPlanCause: 'network' });
  assert.equal(w, base.streamClientToleranceMs,
    'a network wait is bounded by what the CLIENT will tolerate, not by an arbitrary 2min');
  assert.ok(w > 120_000, 'no longer truncated to the old 2-minute cap');
});

test('a CAPACITY/quota hold is NOT shortened — a real reset is worth waiting for', () => {
  const w = computeQueueWindowMs({ ...base, cause: 'capacity', retryPlanCause: 'capacity' });
  assert.ok(w > 120_000, `quota holds keep their long window (got ${w})`);
  assert.equal(w, base.streamClientToleranceMs, 'still bounded by what the client will wait');
});

test('the network cap never EXTENDS a window that is already shorter', () => {
  const w = computeQueueWindowMs({
    ...base, cause: 'network', retryPlanCause: 'network',
    streamClientToleranceMs: 30_000,             // an impatient client
  });
  assert.equal(w, 30_000, 'takes the minimum, never the larger of the two');
});

test('non-streaming requests are unaffected by the network cap path', () => {
  const w = computeQueueWindowMs({ ...base, stream: false, cause: 'network', retryPlanCause: 'network' });
  assert.ok(w <= base.nonStreamMaxWaitMs);
});
