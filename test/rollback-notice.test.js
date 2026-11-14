// Red-team round 1 on the terminal-not-reading fix (2026-11-13), unit half.
// The new code is imported dynamically so a missing export fails only its own test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const P = () => import('../src/reload-protocol.js');

function fakeChild({ exited = false } = {}) {
  const c = new EventEmitter();
  c.exitCode = exited ? 1 : null;
  c.signalCode = null;
  c.send = () => {};
  return c;
}

// ── finding 2: WHY a wait failed decides the rollback reason ──

test('waitFor tags a timer expiry as "timeout"', async () => {
  const { makeWorkerChannel } = await P();
  const ch = makeWorkerChannel(fakeChild());
  const keepAlive = setTimeout(() => {}, 1000);   // the channel's timer is unref'd
  try { await assert.rejects(ch.waitFor(['ready'], 20), err => err.reason === 'timeout'); } finally { clearTimeout(keepAlive); }
});

test('waitFor tags a child that exits as "exited"', async () => {
  const { makeWorkerChannel } = await P();
  const child = fakeChild();
  const ch = makeWorkerChannel(child);
  const p = ch.waitFor(['ready'], 5000);
  child.emit('exit', 1, null);
  await assert.rejects(p, err => err.reason === 'exited');
});

test('waitFor tags a spawn error as "spawn-error"', async () => {
  const { makeWorkerChannel } = await P();
  const child = fakeChild();
  const ch = makeWorkerChannel(child);
  const p = ch.waitFor(['ready'], 5000);
  child.emit('error', new Error('EAGAIN'));
  await assert.rejects(p, err => err.reason === 'spawn-error');
});

test('waitFor on a child that ALREADY exited rejects at once (no wait for the timer)', async () => {
  const { makeWorkerChannel } = await P();
  const ch = makeWorkerChannel(fakeChild({ exited: true }));
  const t0 = Date.now();
  await assert.rejects(ch.waitFor(['released'], 5000), err => err.reason === 'exited');
  assert.ok(Date.now() - t0 < 1000, 'rejected without waiting for the timeout');
});

function scriptedWorker(replies) {
  const sent = [];
  return { sent, send(m) { sent.push(m); }, waitFor() {
    const r = replies.shift();
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  } };
}
const tagged = reason => Object.assign(new Error(reason), { reason });

for (const [why, err, expected] of [
  ['the new worker exited during boot', tagged('exited'), 'failed'],
  ['the new worker could not be spawned', tagged('spawn-error'), 'failed'],
  ['the readiness timer expired', tagged('timeout'), 'timeout'],
  ['an untagged rejection (unknown cause)', new Error('?'), 'failed'],
]) {
  test(`baton: ${why} → rollback reason "${expected}"`, async () => {
    const { runReloadBaton, RELOAD_ROLLED_BACK } = await P();
    const oldWorker = scriptedWorker([]);
    const outcome = await runReloadBaton({ oldWorker, newWorker: scriptedWorker([err]), handle: {} });
    assert.equal(outcome, RELOAD_ROLLED_BACK);
    assert.equal(oldWorker.sent[0]?.reason, expected);
  });
}

// ── finding 1: a rollback notice names the reload it is about ──

test('baton: the rollback notice echoes the reload id it was started for', async () => {
  const { runReloadBaton, MSG_ROLLED_BACK } = await P();
  for (const reply of [tagged('timeout'), { type: 'failed', reason: 'x' }]) {
    const oldWorker = scriptedWorker([]);
    await runReloadBaton({ oldWorker, newWorker: scriptedWorker([reply]), handle: {}, reloadId: 'r-7' });
    assert.deepEqual(oldWorker.sent.map(m => [m.type, m.reloadId]), [[MSG_ROLLED_BACK, 'r-7']]);
  }
});

test('rollbackNoticeAction: settle only a notice for the open reload; an id-less one settles too, flagged', async () => {
  const { rollbackNoticeAction } = await P();
  assert.equal(typeof rollbackNoticeAction, 'function', 'rollbackNoticeAction is exported');
  assert.equal(rollbackNoticeAction({ noticeId: 'r-2', currentId: 'r-2', open: true }), 'settle', 'the open reload: act now');
  assert.equal(rollbackNoticeAction({ noticeId: 'r-1', currentId: 'r-2', open: true }), 'ignore', 'a stale notice for an earlier reload');
  assert.equal(rollbackNoticeAction({ noticeId: 'r-2', currentId: 'r-2', open: false }), 'ignore', 'nothing open: never act');
  // Red-team round 2: an old supervisor's id-less notice settles the open reload at once
  // (no 50s of 503s) — flagged, so its reason never authorizes a cold restart — and is
  // never recorded for later (a stale record fed the next reload's self-heal).
  assert.equal(rollbackNoticeAction({ noticeId: undefined, currentId: 'r-2', open: true }), 'settle-idless');
  assert.equal(rollbackNoticeAction({ noticeId: null, currentId: 'r-2', open: true }), 'settle-idless');
  assert.equal(rollbackNoticeAction({ noticeId: undefined, currentId: null, open: false }), 'ignore', 'old supervisor, nothing open: nothing to settle, nothing kept');
  assert.equal(rollbackNoticeAction({ noticeId: null, currentId: 'r-2', open: false }), 'ignore');
});

// ── finding 7: an exit path writes the terminal synchronously ──

test('setConsoleBlocking turns the switched terminal streams blocking again', async () => {
  const E = await import('../src/event-log.js');
  assert.equal(typeof E.setConsoleBlocking, 'function', 'setConsoleBlocking is exported');
  E.__resetEventLogForTest();
  const calls = [];
  const term = { fd: 2, _handle: { setBlocking: v => calls.push(v) } };
  try {
    E.setConsoleNonBlocking({ streams: [term], isTTY: () => true });
    E.setConsoleBlocking();
    assert.deepEqual(calls, [false, true]);
    E.reassertConsoleNonBlocking();
    assert.deepEqual(calls, [false, true], 'a stream turned back to blocking for exit stays blocking');
  } finally { E.__resetEventLogForTest(); }
});

test('printFatal: a non-blocking terminal gets the lines by a blocking direct write; any other stderr via console.error', async () => {
  const E = await import('../src/event-log.js');
  E.__resetEventLogForTest();
  const calls = [];
  const writes = [];
  const term = { fd: 2, _handle: { setBlocking: v => calls.push(v) } };
  const origError = console.error;
  const printed = [];
  console.error = (...a) => printed.push(a.join(' '));
  try {
    E.printFatal(['plain'], { stream: term, write: (fd, s) => writes.push([fd, s]) });
    assert.deepEqual(printed, ['plain'], 'a stream we never switched prints as usual');
    assert.deepEqual(writes, []);
    E.setConsoleNonBlocking({ streams: [term], isTTY: () => true });
    E.printFatal(['[Maxpool] 127.0.0.1:1 is already in use.', 'second'], { stream: term, write: (fd, s) => writes.push([fd, s]) });
    assert.deepEqual(calls, [false, true], 'blocking again before writing');
    assert.deepEqual(writes, [[2, '[Maxpool] 127.0.0.1:1 is already in use.\n'], [2, 'second\n']]);
    assert.deepEqual(printed, ['plain'], 'not also printed through the (droppable) console path');
  } finally { console.error = origError; E.__resetEventLogForTest(); }
});

test('WIRING: a failed bind prints its reason through printFatal before exiting', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('function handleServerListenError('));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /printFatal\(lines\);\s*process\.exit\(1\);/);
  assert.doesNotMatch(fn, /console\.error/, 'no droppable console path left in the bind-failure exit');
});
