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

test('a request HELD on the keepalive is still reaped — our own pings are not progress', () => {
  // THE BUG (2026-07-29): the reaper watched bytesWritten, which includes maxpool's own
  // 10s keepalive. A stuck request therefore reset the watchdog forever with our noise.
  // Result: 50 requests pinned "in-flight" on one account for up to 6.7h, serving zero,
  // which distorted the load balancer into avoiding a perfectly healthy account.
  const h = harness({ held: true });
  for (let i = 0; i < 4; i++) h.advance(30_000);   // 2 min of keepalive-only "progress"
  assert.equal(h.res.destroyed, true, 'reaped despite continuous keepalive writes');
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
