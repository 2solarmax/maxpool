// A reload worker that dies before it ever took the terminal must leave the terminal to
// the dashboard that owns it (red-team round 2, 2026-11-13). Its exit path used to
// write the exit sequence (leave the alternate screen, show the cursor) synchronously
// over the old worker's live dashboard — and, with the terminal not reading, block on it.
// Real pty (test/fixtures/pty-run.py), throwaway config, fake key, local stub upstream;
// kills only the process group it spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HAVE_PTY, bootPool, pressRestart, watch, describe, sleep } from './fixtures/reload-pty-harness.js';

const skip = HAVE_PTY ? false : 'python3 with pty not available';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

test('a reload worker that exits before ready writes nothing to the live dashboard\'s terminal', { skip, timeout: 150_000 }, async () => {
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ env: { MAXPOOL_TEST_RELOAD_EXIT_BEFORE_READY: '1' } });
  try {
    term.cmd('dump');
    const before = Buffer.from((await term.next('OUT ')).slice(4), 'base64').toString('latin1');
    const logFrom = (await log()).length;
    await pressRestart(term);
    const rolled = await watch({ port, pid, log, logFrom, ms: 60_000, stepMs: 300, pred: r => /readiness wait failed/.test(r.since) && r.status === 200 });
    assert.ok(rolled.ok, `precondition: the reload rolled back and the pool serves:\n${describe(rolled.timeline, ['readiness wait failed', 'Reload rolled back'])}`);
    await sleep(1000);
    term.cmd('dump');
    const after = Buffer.from((await term.next('OUT ')).slice(4), 'base64').toString('latin1').slice(before.length);
    assert.equal(after.includes(LEAVE_ALT_SCREEN), false, 'the dying reload worker left the alternate screen under the live dashboard');
    assert.equal(rolled.row.worker, oldWorker, 'the old worker still serves');
  } finally { cleanup(); }
});
