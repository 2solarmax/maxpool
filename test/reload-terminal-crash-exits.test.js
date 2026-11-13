// Red-team round 5 on the terminal-not-reading fix (2026-11-14), real-pty half
// (harness: test/fixtures/reload-pty-harness.js; throwaway configs, fake key, local
// stub upstream; each test kills only the process group it spawned).
//
// MAJOR: the crash-class exit-75 paths of a supervised primary never handed the terminal
// off, so the 'exit' listener ran tui.stop({ exiting: true }): a BLOCKING write of the
// exit sequence plus a raw-mode switch (TCSADRAIN). With the terminal not reading, the
// worker hung there holding the only accepting socket (the supervisor closed its own
// accept loop at MSG_PRIMARY): the port was dead until the terminal read. The same
// defect class round 1/2 fixed for restartWorkerNow and shutdownGracefully.
//   - uncaughtException → exit 75                    (MAXPOOL_TEST_CRASH_SIGNAL)
//   - IPC handler: MSG_LISTEN with no handle → exit 75 (MAXPOOL_TEST_IPC_SIGNAL=listen-no-handle)
//   - IPC handler: a message that throws → exit 75     (MAXPOOL_TEST_IPC_SIGNAL=listen: a
//     second listen on the serving socket, a real ERR_SERVER_ALREADY_LISTEN)
// Each: the crashed worker must leave promptly while the terminal is not reading (the
// supervisor respawns a cold worker, which takes the terminal over), and the pool must
// come back once the terminal reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HAVE_PTY, bootPool, stopTheTerminal, watch, describe,
} from './fixtures/reload-pty-harness.js';

const skip = HAVE_PTY ? false : 'python3 with pty not available';
const MARKS = ['uncaughtException', 'MSG_LISTEN with no socket handle', 'Worker message error', 'Worker exited (code'];

// Each seam has exactly one way to make the worker leave: the exit-75 path named.
// (The worker's own log line about it is appended asynchronously and is lost to the
// immediate exit, so the precondition is the supervisor's side: no non-restart exit
// was logged — it logs "Worker exited (code N…" for those — and a cold worker came back.)
for (const [label, env] of [
  ['an uncaught exception', { MAXPOOL_TEST_CRASH_SIGNAL: '1' }],
  ['MSG_LISTEN without a socket handle', { MAXPOOL_TEST_IPC_SIGNAL: 'listen-no-handle' }],
  ['a worker message error', { MAXPOOL_TEST_IPC_SIGNAL: 'listen' }],
]) {
  test(`a supervised worker that exits for a restart on ${label} leaves promptly while the terminal is not reading`, { skip, timeout: 120_000 }, async () => {
    const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ env });
    try {
      await stopTheTerminal(term, port);
      const logFrom = (await log()).length;
      process.kill(oldWorker, 'SIGUSR2');
      // The crash exits at once; a worker that waits for the terminal on its way out
      // holds the listening socket for as long as the terminal does not read.
      const gone = await watch({ port, pid, log, logFrom, ms: 20_000, timeoutMs: 500, stepMs: 300, pred: r => !r.kids.includes(oldWorker) });
      const goneAt = gone.ok ? gone.row.t : null;
      assert.ok(gone.ok && goneAt < 6, `the crashed worker stayed ${goneAt ?? '20+'}s while the terminal was not reading:\n${describe(gone.timeline, MARKS)}`);
      term.cmd('read');
      const back = await watch({ port, pid, log, logFrom, ms: 30_000, pred: r => r.status === 200 && r.worker && r.worker !== oldWorker });
      assert.ok(back.ok, `the pool did not come back once the terminal read:\n${describe(back.timeline, MARKS)}`);
      assert.doesNotMatch(back.row.since, /Worker exited \(code/, `precondition: the worker left by exit 75 (a restart), not another exit:\n${back.row.since.slice(-1500)}`);
    } finally { cleanup(); }
  });
}
