// Red-team round 2 on the terminal-not-reading fix (2026-11-13), real-pty half
// (harness: test/fixtures/reload-pty-harness.js + pty-run.py; throwaway configs, fake
// key, local stub upstream; each test kills only the process group it spawned).
//
//   finding 3: the raw-mode helper must never hold an exiting process. A helper THREAD
//              blocked in tcsetattr(TCSADRAIN) is joined by process.exit, so a worker
//              with a pending switch lived until the terminal read — still holding the
//              port on the abrupt-restart path (Worker.terminate() cannot interrupt it)
//   finding 4: a supervised worker quits on SIGTERM while the terminal is not reading
//   finding 6: a respawned worker takes raw mode off its serving thread
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HAVE_PTY, Terminal, bootPool, stopTheTerminal, pressRestart, watch, describe, proxyRequest, sleep,
} from './fixtures/reload-pty-harness.js';

const skip = HAVE_PTY ? false : 'python3 with pty not available';
const MARKS = ['cutover complete', 'Restarting server now', 'keyboard ready after the terminal caught up', 'Draining shutdown'];
const TERMINAL_MODE = new URL('../src/terminal-mode.js', import.meta.url).href;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function onceFile(name) {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-r2-'));
  const f = join(dir, name);
  await writeFile(f, '');
  return f;
}

// ── finding 3, the mechanism: a process with a pending switch exits at once ──

for (const close of [true, false]) {
  test(`terminal-mode: a process whose raw-mode switch waits for a terminal that is not reading exits at once${close ? ' (after close())' : ' (no close() — the exit path still is not held)'}`, { skip, timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'maxpool-tm-'));
    const report = join(dir, 'report.json');
    const script = join(dir, 'child.mjs');
    await writeFile(script, `
      import { createTerminalModeSwitcher } from ${JSON.stringify(TERMINAL_MODE)};
      import { writeFileSync } from 'node:fs';
            const sw = createTerminalModeSwitcher();
      process.stdout._handle.setBlocking(false);
      process.stdout.write('x'.repeat(20000));   // the terminal is not reading: its queue fills
      let settled = null;
      sw.setRaw(true).then(r => { settled = r; });
      setTimeout(() => {
        const helpers = (spawnSync('pgrep', ['-P', String(process.pid)], { encoding: 'utf8' }).stdout || '').split('\\n').filter(Boolean).map(Number);
        writeFileSync(${JSON.stringify(report)}, JSON.stringify({ settled, helpers }));
        ${close ? 'sw.close();' : ''}
        process.exit(75);
      }, 3000);
    `);
    const term = new Terminal({ cli: script, args: [], cols: 80, rows: 24, env: process.env });
    try {
      await term.next('PID ');
      // The terminal stays paused for the whole wait.
      term.cmd('wait 8');
      const exit = await term.next('EXIT ', 20_000);
      const r = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(r.settled, null, 'precondition: the switch was still waiting for the terminal');
      assert.equal(exit, 'EXIT 75', 'the process exited (code 75) while its terminal was not reading');
      // The helper never outlives the process: it would apply a stale mode later.
      await sleep(500);
      assert.deepEqual(r.helpers.filter(alive), [], `the helper outlived its process (${r.helpers})`);
    } finally { term.close(); }
  });
}

// ── finding 3, the exit paths of a worker that took over with the terminal not reading ──

for (const [label, coldRestart] of [
  ['the abrupt restart (restartWorkerNow)', true],
  ['a released worker (exitAfterMergeFlush)', false],
]) {
  test(`a worker whose raw-mode switch is still waiting leaves promptly on ${label}`, { skip, timeout: 180_000 }, async () => {
    const env = { MAXPOOL_TEST_RESTART_SIGNAL: '1' };
    if (coldRestart) env.MAXPOOL_TEST_SIGNAL_COLD_RESTART = await onceFile('cold-restart');
    const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ env });
    try {
      await stopTheTerminal(term, port);
      const logFrom = (await log()).length;
      await pressRestart(term);   // takeover with the terminal not reading: the new worker's switch waits
      const took = await watch({ port, pid, log, logFrom, ms: 45_000, timeoutMs: 1500, stepMs: 300, pred: r => r.status === 200 && r.worker && r.worker !== oldWorker });
      assert.ok(took.ok, `precondition: the reload handed over:\n${describe(took.timeline, MARKS)}`);
      const second = took.row.worker;
      await sleep(1500);
      process.kill(second, 'SIGUSR2');   // cold restart / a second seamless reload
      const gone = await watch({ port, pid, log, logFrom, ms: 30_000, timeoutMs: 1000, stepMs: 300, pred: r => !r.kids.includes(second) });
      // Bound: the cold path's own 2s flush race / the released worker's hand-off
      // (1.5s + 1.5s) plus a 1s merge flush, with margin — never "until the terminal reads".
      const firstGoneAt = gone.ok ? gone.row.t : null;
      assert.ok(gone.ok && firstGoneAt < (coldRestart ? 8 : 20), `the worker stayed ${firstGoneAt ?? '30+'}s while the terminal was not reading:\n${describe(gone.timeline, MARKS)}`);
      term.cmd('read');
      const back = await watch({ port, pid, log, logFrom, ms: 30_000, pred: r => r.status === 200 && r.worker && r.worker !== second });
      assert.ok(back.ok, `the pool did not come back:\n${describe(back.timeline, MARKS)}`);
    } finally { cleanup(); }
  });
}

// ── finding 4: SIGTERM while the terminal is not reading ──

test('a supervised worker quits on SIGTERM while the terminal is not reading', { skip, timeout: 120_000 }, async () => {
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool();
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    process.kill(oldWorker, 'SIGTERM');
    const gone = await watch({ port, pid, log, logFrom, ms: 20_000, timeoutMs: 500, stepMs: 300, pred: () => !alive(oldWorker) });
    assert.ok(gone.ok && gone.row.t < 6, `the worker was still alive ${gone.row?.t}s after SIGTERM:\n${describe(gone.timeline, MARKS)}`);
  } finally { cleanup(); }
});

// ── finding 6: a respawned worker never switches raw mode on its serving thread ──

test('a respawned worker serves before its raw-mode switch completes on a terminal that reads in bursts', { skip, timeout: 180_000 }, async () => {
  // r with the cold path forced: the old worker exits 75 and the supervisor respawns a
  // cold worker, onto a terminal that is behind and reads 300 bytes every 2.5s.
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ env: { MAXPOOL_TEST_FORCE_COLD_RESTART: '1' } });
  try {
    await stopTheTerminal(term, port);
    term.cmd('read-slow 300 2500');
    const logFrom = (await log()).length;
    await pressRestart(term);
    const back = await watch({ port, pid, log, logFrom, ms: 60_000, timeoutMs: 1500, stepMs: 300, pred: r => r.status === 200 && r.worker && r.worker !== oldWorker && /keyboard ready after the terminal caught up/.test(r.since) });
    const since = back.row?.since || '';
    assert.ok(back.ok, `the respawned worker never took raw mode off its serving thread (no helper switch logged):\n${describe(back.timeline, MARKS)}\n--- event log ---\n${since.slice(-3000)}`);
    // It answered requests while its switch still waited: the first request it served is
    // logged before the switch completed.
    const restartAt = since.indexOf('Restarting server now');
    const servedAt = since.indexOf('POST /v1/messages', restartAt);
    const readyAt = since.indexOf('keyboard ready after the terminal caught up', restartAt);
    assert.ok(restartAt >= 0 && servedAt > restartAt && servedAt < readyAt, `the respawned worker waited for the terminal before serving:\n${since.slice(Math.max(0, restartAt)).slice(0, 3000)}`);
    term.cmd('read');
    assert.equal((await proxyRequest(port, 2000)).status, 200);
  } finally { cleanup(); }
});

