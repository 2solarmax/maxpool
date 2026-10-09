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

test('a NETWORK-cause hold is capped below the CLI 30-min stream ceiling', () => {
  // REVERSED AGAIN on evidence 2026-10-07. The 2026-08-02 reversal licensed network holds
  // as long as the client's idle env (3h via the cc alias) — but that env only raises the
  // IDLE watchdog. Claude Code ALSO carries an absolute per-stream ceiling of 1800000ms
  // (binary-verified) that no bytes reset: 49 held streams measured dying at 30-33 min
  // with only ping bytes sent, each surfacing as "Waiting for API response · will retry"
  // with the client already gone. So a network hold past 25 min is a guaranteed orphan:
  // cap it, and let the CLI's own outage-surviving retry loop take over after our error.
  const w = computeQueueWindowMs({ ...base, cause: 'network', retryPlanCause: 'network' });
  assert.equal(w, 25 * 60_000,
    'network holds capped at 25 min, below the CLI 30-min absolute ceiling');
  assert.ok(w > 120_000, 'still generous vs the pre-2026-08-02 2-minute cap');
});

test('a CAPACITY/quota hold keeps a long window, bounded by the CLI stream ceiling', () => {
  // REVISED 2026-10-09: 'still bounded by what the client will wait' was the intent;
  // the client's absolute stream ceiling (30 min) is the real bound, not the 3h idle
  // tolerance — capacity holds measured dying at 1820-1848s with only pings sent.
  const w = computeQueueWindowMs({ ...base, cause: 'capacity', retryPlanCause: 'capacity' });
  assert.ok(w > 120_000, `quota holds keep a long window (got ${w})`);
  assert.equal(w, 25 * 60_000, 'bounded by the CLI ceiling, not the 3h idle tolerance');
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


test('a CAPACITY-cause streaming hold ALSO stays under the CLI ceiling (2026-10-09 orphans)', () => {
  // Five capacity holds from the 05:30 network switch died client-side at
  // 1820-1848s — the ceiling does not care WHY the pool is holding.
  const w = computeQueueWindowMs({ ...base, cause: 'capacity', retryPlanCause: 'capacity' });
  assert.ok(w <= 25 * 60_000, `capacity hold capped below 30-min ceiling (got ${w})`);
});
