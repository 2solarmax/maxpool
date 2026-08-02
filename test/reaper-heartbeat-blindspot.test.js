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
