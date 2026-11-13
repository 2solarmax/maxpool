import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';
const { startIdleRequestReaper } = __serverTest;

// Fake clock + a socket whose bytesWritten only WE move (the keepalive).
function harness({ held }) {
  let t = 0, ticks = [];
  const res = { socket: { bytesWritten: 0 }, writableEnded: false, destroyed: false,
    destroy() { this.destroyed = true; } };
  const timer = startIdleRequestReaper(res, 'req1', 60_000, {
    now: () => t,
    setIntervalFn: fn => { ticks.push(fn); return { unref() {} }; },
    getRequestInfo: () => ({ queueHeartbeatActive: held }),
  });
  return {
    res, timer,
    advance(ms, { keepaliveWrites = true } = {}) {
      t += ms;
      if (keepaliveWrites) res.socket.bytesWritten += 20;   // a ': ping' frame
      ticks.forEach(fn => fn());
    },
  };
}

test('a request HELD on the queue is EXEMPT — reaping it would free nothing', () => {
  // REVERSED on evidence 2026-08-02. A queue-held request has ALREADY released its account
  // lease before queueing, so destroying it frees no capacity — the only thing this reaper
  // exists to protect. Worse, it capped every hold at 20 minutes with no error frame, which
  // made a longer hold window inert. The 2026-07-29 case this reaper legitimately caught
  // (50 requests pinned on one account for 6.7h) were IN-FLIGHT holding leases — still
  // reaped, see the tests below.
  const h = harness({ held: true });
  for (let i = 0; i < 8; i++) h.advance(30_000);   // 4 minutes of holding
  assert.equal(h.res.destroyed, false, 'a held request is never reaped by the idle backstop');
});

test('a NORMAL streaming request is never reaped while real bytes flow', () => {
  const h = harness({ held: false });
  for (let i = 0; i < 10; i++) h.advance(30_000);  // upstream chunks arriving
  assert.equal(h.res.destroyed, false, 'real upstream progress keeps it alive');
});

test('a silent request with no writes at all is still reaped', () => {
  const h = harness({ held: false });
  for (let i = 0; i < 4; i++) h.advance(30_000, { keepaliveWrites: false });
  assert.equal(h.res.destroyed, true, 'the original backstop behaviour is preserved');
});

test('an already-finished response is never destroyed', () => {
  const h = harness({ held: true });
  h.res.writableEnded = true;
  for (let i = 0; i < 6; i++) h.advance(30_000);
  assert.equal(h.res.destroyed, false);
});

// Release B, red-team round 2 (R2-1): with per-hop first-byte waits up to 290s, a legitimate
// non-streaming chain inside a 1h client patience can stay silent longer than the backstop ceiling
// (queue hold 300s + 2×290s timeouts + 290s TTFB + 300s body ≈ 1470s). Such a request is bounded by
// its own deadline (504 at deadlineAt), so the backstop waits for deadline + grace instead of cutting
// an answer the client is still waiting for. No deadline → the ceiling is unchanged.
function deadlineHarness(info) {
  let t = 0; const ticks = [];
  const res = { socket: { bytesWritten: 0 }, writableEnded: false, destroyed: false, destroy() { this.destroyed = true; } };
  startIdleRequestReaper(res, 'req-dl', 1_200_000, {
    now: () => t, setIntervalFn: fn => { ticks.push(fn); return { unref() {} }; }, getRequestInfo: () => info,
  });
  return { res, advanceTo(ms) { while (t < ms) { t = Math.min(ms, t + 60_000); ticks.forEach(fn => fn()); } } };
}

test('R2-1: a silent non-streaming request inside its deadline outlives the 1200s ceiling, then is reaped after deadline + grace', () => {
  const h = deadlineHarness({ stream: false, deadlineAt: 3_000_000 });
  h.advanceTo(1_500_000);   // 1500s silent: past the 1200s ceiling, well inside the deadline
  assert.equal(h.res.destroyed, false, 'a request still inside its deadline is not cut by the backstop');
  h.advanceTo(3_000_000 + 60_000 + 60_000);
  assert.equal(h.res.destroyed, true, 'past deadline + grace the backstop still fires');
});

test('R2-1 control: a deadline SHORTER than the ceiling never shortens it, and no deadline keeps today\'s 1200s', () => {
  const short = deadlineHarness({ stream: false, deadlineAt: 100_000 });
  short.advanceTo(1_140_000);
  assert.equal(short.res.destroyed, false, 'the ceiling stays the floor');
  short.advanceTo(1_260_000);
  assert.equal(short.res.destroyed, true);
  const none = deadlineHarness({ stream: false });
  none.advanceTo(1_260_000);
  assert.equal(none.res.destroyed, true, 'no deadline: reaped at the ceiling as before');
  const streaming = deadlineHarness({ stream: true, deadlineAt: 3_000_000 });
  streaming.advanceTo(1_260_000);
  assert.equal(streaming.res.destroyed, true, 'a streaming request never borrows the deadline extension');
});
