import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { ensureQueueHeartbeat, clearQueueHeartbeat, commitStreamGraceHeartbeat } = __serverTest;

// W1 — proactive streaming keep-alive during the forward window. The grace timer in
// forwardRequest calls ensureQueueHeartbeat from an ASYNC context (no synchronous
// res.destroyed precondition, unlike the queue caller). These tests lock the
// crash-safety the pre-mortem flagged: an unguarded initial write to a socket that
// died mid-window would throw ERR_STREAM_DESTROYED → uncaughtException → the worker
// process.exits and bounces EVERY in-flight stream. ensureQueueHeartbeat must be safe
// from ANY caller.

function liveRes() {
  const writes = [];
  return {
    headersSent: false, destroyed: false, writableEnded: false, writes,
    writeHead(status, headers) { this.headersSent = true; this._status = status; this._headers = headers; },
    flushHeaders() { this._flushed = true; },
    write(s) { writes.push(s); return true; },
    end() { this.writableEnded = true; },
  };
}

test('W1 crash-safe: a throwing writeHead (socket died mid-window) is caught, not propagated', () => {
  const res = liveRes();
  res.writeHead = () => { throw Object.assign(new Error('write after end'), { code: 'ERR_STREAM_DESTROYED' }); };
  const requestInfo = { stream: true };
  let reaped = 0;
  const am = { removeQueuedRequest: () => { reaped++; } };
  assert.doesNotThrow(
    () => ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, am),
    'a throwing initial commit must be caught — an uncaught throw here bounces the worker',
  );
  assert.ok(!requestInfo.queueHeartbeatActive, 'must NOT mark the heartbeat active after a failed commit');
  assert.equal(requestInfo.queueHeartbeatTimer, null, 'no interval left running after a failed commit');
  assert.equal(reaped, 1, 'must reap the queue slot when the commit fails');
});

test('W1 crash-safe: a throwing write() after writeHead is also caught + reaped', () => {
  const res = liveRes();
  res.write = () => { throw Object.assign(new Error('EPIPE'), { code: 'EPIPE' }); };
  const requestInfo = { stream: true };
  let reaped = 0;
  assert.doesNotThrow(
    () => ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest: () => { reaped++; } }),
  );
  assert.ok(!requestInfo.queueHeartbeatActive, 'a failed initial write leaves the heartbeat inactive');
  assert.equal(reaped, 1, 'reaped the slot');
});

test('W1 happy path: a live socket commits the SSE stream + starts the heartbeat', () => {
  const res = liveRes();
  const requestInfo = { stream: true };
  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(res._status, 200, 'commits 200');
  assert.equal(res._headers['Content-Type'], 'text/event-stream', 'as an SSE stream');
  assert.equal(res._flushed, true, 'flushes headers so the client sees bytes immediately');
  assert.ok(res.writes[0].includes('event: ping'), 'sends an immediate keep-alive EVENT (a comment would not reset the client watchdog)');
  assert.equal(requestInfo.queueHeartbeatActive, true, 'marks the heartbeat active');
  clearQueueHeartbeat(requestInfo);
  assert.ok(!requestInfo.queueHeartbeatActive, 'clearQueueHeartbeat tears it down');
});

test('W1 no-op for a NON-streaming request (never commits an SSE stream to a JSON caller)', () => {
  const res = liveRes();
  const requestInfo = { stream: false };
  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(res.headersSent, false, 'a non-streaming request must not be committed as a stream');
  assert.ok(!requestInfo.queueHeartbeatActive);
});

test('W1 no-op when headers are already committed (idempotent / no double-commit)', () => {
  const res = liveRes();
  res.headersSent = true;
  const requestInfo = { stream: true };
  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(res.writes.length, 0, 'must not write again once headers are sent');
});

test('W1 no-op on a second call while already active (no duplicate heartbeat)', () => {
  const res = liveRes();
  const requestInfo = { stream: true };
  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  const firstTimer = requestInfo.queueHeartbeatTimer;
  ensureQueueHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(requestInfo.queueHeartbeatTimer, firstTimer, 'the second call is a no-op (same timer)');
  clearQueueHeartbeat(requestInfo);
});

// ── the grace-timer callback logic itself (the W1 feature, extracted for testing) ──

test('W1 grace callback: a live streaming socket → commits the SSE stream + heartbeat', () => {
  const res = liveRes();
  const requestInfo = { stream: true };
  commitStreamGraceHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(res._status, 200, 'a slow upstream past the grace commits the stream');
  assert.equal(requestInfo.queueHeartbeatActive, true);
  assert.ok(res.writes[0].includes('event: ping'));
  clearQueueHeartbeat(requestInfo);
});

test('W1 grace callback: a client that vanished mid-window → reaps the slot, never touches the dead socket', () => {
  const res = liveRes();
  res.destroyed = true;                 // the async-race the pre-mortem flagged
  res.writeHead = () => { throw new Error('must not be called on a destroyed socket'); };
  const requestInfo = { stream: true };
  let reaped = 0;
  assert.doesNotThrow(
    () => commitStreamGraceHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest: () => { reaped++; } }),
    'the callback must guard destroyed BEFORE any write — this is the worker-bounce race',
  );
  assert.ok(!requestInfo.queueHeartbeatActive, 'no commit on a dead socket');
  assert.equal(reaped, 1, 'reaps the queue slot instead');
});

test('W1 grace callback: an already-committed stream → no double-commit, reaps stale slot', () => {
  const res = liveRes();
  res.headersSent = true;               // a re-forward after an earlier commit
  const requestInfo = { stream: true };
  commitStreamGraceHeartbeat(res, requestInfo, { heartbeatMs: 10_000 }, { removeQueuedRequest() {} });
  assert.equal(res.writes.length, 0, 'must not write again once headers are committed');
});
