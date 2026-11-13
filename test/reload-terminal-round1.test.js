// Red-team round 1 on the terminal-not-reading fix (2026-11-13), real-pty half
// (harness: test/fixtures/reload-pty-harness.js; throwaway config, fake key, local
// stub upstream; kills only the process group it spawned).
//
//   finding 3: an UPDATE-driven reload that times out while the terminal is not
//              reading must not freeze the port (the cold-restart fallback used to
//              switch raw mode — TCSADRAIN — and its respawn switched it again)
//   finding 6: the takeover worker must not take raw mode on a weak "the terminal is
//              reading" signal: a frame under the pty's 1 KB queue, or a terminal that
//              reads in short bursts, blocked it after it had become the only acceptor
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HAVE_PTY, bootPool, stopTheTerminal, pressRestart, watch, describe, proxyRequest, sleep,
} from './fixtures/reload-pty-harness.js';

const skip = HAVE_PTY ? false : 'python3 with pty not available';
const MARKS = ['readiness wait failed', 'Reload rolled back', 'Applying the update', 'cutover complete', 'Restarting server now'];

test('an update reload that times out with the terminal not reading keeps the port answering, and lands once it reads', { skip, timeout: 150_000 }, async () => {
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({
    env: { MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_NEVER_READY: '1' },
  });
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    await pressRestart(term);
    // Readiness budget (10s) + 8s with the terminal still not reading: every request
    // answered within 1.5s, by the worker that was serving before.
    const w = await watch({ port, pid, log, logFrom, ms: 18_000, timeoutMs: 1500, stepMs: 300 });
    const stalled = w.timeline.filter(r => !r.worker);
    assert.deepEqual(stalled, [], `the port stopped answering while the terminal was not reading:\n${describe(w.timeline, MARKS)}`);
    assert.ok(w.timeline.every(r => r.worker === oldWorker),
      `the pool restarted while the terminal was not reading:\n${describe(w.timeline, MARKS)}`);
    assert.match(w.row.since, /readiness wait failed/, 'precondition: the reload timed out');
    // The terminal reads again → the update still lands (cold restart into the new build).
    term.cmd('read');
    const landed = await watch({ port, pid, log, logFrom, ms: 25_000, pred: r => r.status === 200 && r.worker && r.worker !== oldWorker });
    assert.ok(landed.ok, `the update never landed after the terminal read again:\n${describe(landed.timeline, MARKS)}`);
  } finally { cleanup(); }
});

test('a takeover on a small terminal that reads in bursts never stalls the new worker', { skip, timeout: 150_000 }, async () => {
  // 30x8: a whole dashboard frame fits in the pty's 1 KB output queue.
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ cols: 30, rows: 8 });
  try {
    await stopTheTerminal(term, port);
    term.cmd('read-slow 300 2500');      // bursts: 300 bytes, then nothing for 2.5s
    const logFrom = (await log()).length;
    await pressRestart(term);
    // From the key press through 12s after the hand-off, every request is answered
    // within 1s — by either worker. (Timing starts at the press: a stall right after
    // the takeover would otherwise hide inside "waiting for the new worker".)
    let cutAt = null;
    const w = await watch({ port, pid, log, logFrom, ms: 40_000, timeoutMs: 1000, stepMs: 200, pred: r => {
      if (cutAt == null && r.status === 200 && r.worker && r.worker !== oldWorker) cutAt = r.t;
      return cutAt != null && r.t - cutAt >= 12;
    } });
    assert.ok(cutAt != null, `precondition: the reload handed over:\n${describe(w.timeline, MARKS)}`);
    const stalled = w.timeline.filter(r => !r.worker);
    assert.deepEqual(stalled.map(r => `+${r.t}s ${r.status}`), [], `a request went unanswered for 1s around the takeover:\n${describe(w.timeline, MARKS)}\n--- event log ---\n${w.row.since.split('\n').filter(l => !l.includes('POST /v1/messages')).join('\n').slice(-4000)}`);
    term.cmd('read');
    await sleep(500);
    assert.equal((await proxyRequest(port, 2000)).status, 200);
  } finally { cleanup(); }
});

test('after a takeover the new worker takes single keys (raw mode, set off its serving thread)', { skip, timeout: 150_000 }, async () => {
  // In cooked mode the terminal holds a lone `r` until Enter, so a second reload that
  // starts from a key press proves the new worker's terminal really is in raw mode.
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool();
  try {
    await pressRestart(term);
    const first = await watch({ port, pid, log, ms: 30_000, pred: r => r.status === 200 && r.worker && r.worker !== oldWorker && r.kids.length === 1 });
    assert.ok(first.ok, `precondition: the first reload handed over:\n${describe(first.timeline, MARKS)}`);
    const second = first.row.worker;
    await sleep(2500);                    // the old worker's exit re-asserts the terminal (MSG_TTY_REASSERT)
    await pressRestart(term);
    const again = await watch({ port, pid, log, ms: 30_000, pred: r => r.status === 200 && r.worker && r.worker !== second && r.worker !== oldWorker });
    assert.ok(again.ok, `the new worker never acted on r (its terminal is not in raw mode):\n${describe(again.timeline, MARKS)}`);
  } finally { cleanup(); }
});
