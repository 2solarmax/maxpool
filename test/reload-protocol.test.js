// Baton sequencing unit tests (no real processes). Drive runReloadBaton against
// fake worker channels to prove: clean cutover, full rollback when the new
// worker fails readiness, and fallback when the old worker won't release or the
// new worker won't take over. The key invariant: the old worker RELEASES before
// the new worker ACQUIRES — never both accepting, never both writing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  runReloadBaton,
  RELOAD_SWAPPED, RELOAD_ROLLED_BACK, RELOAD_FALLBACK,
  MSG_PROBE_READY, MSG_READY, MSG_FAILED, MSG_RELEASE, MSG_RELEASED,
  MSG_TAKEOVER, MSG_PRIMARY, MSG_ROLLED_BACK,
} from '../src/reload-protocol.js';

// A scripted fake worker: records sent messages, and answers waitFor() from a
// queue of canned replies keyed by the message type the supervisor will send.
function fakeWorker(script) {
  const sent = [];                       // full messages (type + reason)
  return {
    sent,
    // Type-only view, so the ordering/inclusion assertions below stay readable.
    get types() { return sent.map(m => m.type); },
    send(msg) { sent.push(msg); },
    waitFor(types, _timeoutMs) {
      const want = Array.isArray(types) ? types : [types];
      const reply = script.shift();
      if (reply === 'TIMEOUT') return Promise.reject(new Error('timed out'));
      if (reply === 'EXIT') return Promise.reject(new Error('worker exited'));
      if (!want.includes(reply.type)) {
        return Promise.reject(new Error(`unexpected ${reply.type}`));
      }
      return Promise.resolve(reply);
    },
  };
}

test('clean cutover: ready → release → takeover → SWAPPED, ordering correct', async () => {
  const newWorker = fakeWorker([{ type: MSG_READY }, { type: MSG_PRIMARY }]);
  const oldWorker = fakeWorker([{ type: MSG_RELEASED }]);

  const order = [];
  const wrap = (w, label) => ({
    ...w,
    send(msg) { order.push(`${label}:${msg.type}`); w.send(msg); },
  });

  const outcome = await runReloadBaton({
    oldWorker: wrap(oldWorker, 'old'),
    newWorker: wrap(newWorker, 'new'),
    handle: {},
  });

  assert.equal(outcome, RELOAD_SWAPPED);
  // Probe-ready first, THEN old release happens BEFORE new takeover.
  assert.deepEqual(order, [
    `new:${MSG_PROBE_READY}`,
    `old:${MSG_RELEASE}`,
    `new:${MSG_TAKEOVER}`,
  ], 'old must release before new takes over');
});

test('new worker fails readiness → ROLLED_BACK; old is never told to release', async () => {
  const newWorker = fakeWorker([{ type: MSG_FAILED, reason: 'boom' }]);
  const oldWorker = fakeWorker([]); // should receive nothing

  const outcome = await runReloadBaton({ oldWorker, newWorker, handle: {} });
  assert.equal(outcome, RELOAD_ROLLED_BACK);
  // The property that matters: the old worker is never told to give up primary. It DOES
  // receive an advisory rollback notice carrying the reason ('failed' vs 'timeout'), which
  // decides whether a cold-restart retry is safe — that must not be mistaken for a release.
  assert.ok(oldWorker.sent.every(m => m.type !== MSG_RELEASE && m.type !== MSG_TAKEOVER),
    'old worker stays fully primary — never released');
  assert.deepEqual(oldWorker.sent.map(m => m.type), [MSG_ROLLED_BACK], 'only the advisory notice');
  assert.equal(oldWorker.sent[0].reason, 'failed', 'a build that cannot boot is reported as failed');
});

test('readiness timeout → ROLLED_BACK (old untouched)', async () => {
  const newWorker = fakeWorker(['TIMEOUT']);
  const oldWorker = fakeWorker([]);
  const outcome = await runReloadBaton({ oldWorker, newWorker, handle: {} });
  assert.equal(outcome, RELOAD_ROLLED_BACK);
  assert.ok(oldWorker.sent.every(m => m.type !== MSG_RELEASE && m.type !== MSG_TAKEOVER),
    'old worker stays primary');
  assert.equal(oldWorker.sent[0]?.reason, 'timeout',
    'a merely-slow swap is reported as timeout — the only class that earns a cold retry');
});

test('old worker will not release → FALLBACK (never hand socket to new)', async () => {
  const newWorker = fakeWorker([{ type: MSG_READY }]);
  const oldWorker = fakeWorker(['TIMEOUT']);
  const outcome = await runReloadBaton({ oldWorker, newWorker, handle: {} });
  assert.equal(outcome, RELOAD_FALLBACK);
  // New worker was asked to confirm readiness but NOT to take over.
  assert.ok(!newWorker.types.includes(MSG_TAKEOVER), 'socket never handed to new after old failed to release');
});

test('new worker will not take over after old released → FALLBACK', async () => {
  const newWorker = fakeWorker([{ type: MSG_READY }, 'TIMEOUT']);
  const oldWorker = fakeWorker([{ type: MSG_RELEASED }]);
  const outcome = await runReloadBaton({ oldWorker, newWorker, handle: {} });
  assert.equal(outcome, RELOAD_FALLBACK);
  assert.ok(oldWorker.types.includes(MSG_RELEASE), 'old did release');
  assert.ok(newWorker.types.includes(MSG_TAKEOVER), 'new was asked to take over but timed out');
});
