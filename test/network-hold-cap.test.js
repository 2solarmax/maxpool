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

test('a NETWORK-cause hold is capped short even when the client is patient', () => {
  // 2026-07-28: a request was held 10,445s (2h54m) with ZERO bytes produced because a raised
  // CLAUDE_STREAM_IDLE_TIMEOUT_MS licensed a multi-hour hold on a dead route. Nothing aborted
  // it until the user touched the keyboard. A dead route is not a scheduled reset.
  const w = computeQueueWindowMs({ ...base, cause: 'network', retryPlanCause: 'network' });
  assert.equal(w, 120_000, 'capped at the network ceiling, not the 3h client tolerance');
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
