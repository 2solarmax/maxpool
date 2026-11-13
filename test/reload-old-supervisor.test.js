// A seamless update never replaces the SUPERVISOR: a Mac that updates from v1.24.92
// runs the OLD supervisor with NEW workers until a full relaunch (red-team round 1,
// 2026-11-13, finding 4). This runs exactly that mix on a real pty: the v1.24.92
// supervisor (= 845bae4 src: no reload ids, blocking terminal writes) with HEAD
// workers, while the terminal is not reading.
//
// How: the supervisor spawns its workers by re-running its own entry file, so the
// entry is a small dispatcher — supervisor → the extracted old src, worker → HEAD src.
// Throwaway config, fake key, local stub upstream; kills only the process group it
// spawned. Skips when the baseline commit is not in this clone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  HAVE_PTY, HEAD_CLI, bootPool, stopTheTerminal, pressRestart, watch, describe, proxyRequest, sleep, childPids,
} from './fixtures/reload-pty-harness.js';

const BASELINE = '845bae409382d812782515790e6810fafa425055';   // == v1.24.92 src
const repo = fileURLToPath(new URL('..', import.meta.url));
const haveBaseline = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${BASELINE}^{commit}`], { stdio: 'ignore' }).status === 0;
const skip = !HAVE_PTY ? 'python3 with pty not available' : !haveBaseline ? `baseline ${BASELINE.slice(0, 7)} not in this clone` : false;
const MARKS = ['readiness wait failed', 'Reload rolled back', 'Applying the update', 'cutover complete', 'will finish with a full restart', 'did not hand over'];

async function oldSupervisorEntry() {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-oldsup-'));
  const tar = spawnSync('sh', ['-c', `git -C "${repo}" archive ${BASELINE} src package.json | tar -x -C "${dir}"`], { encoding: 'utf8' });
  assert.equal(tar.status, 0, `extracting the baseline: ${tar.stderr}`);
  const entry = join(dir, 'dispatch.mjs');
  await writeFile(entry, [
    "// Supervisor: the old build. Worker (cold or reload): HEAD.",
    `if (process.env.MAXPOOL_SERVER_WORKER === '1') await import(${JSON.stringify(pathToFileURL(HEAD_CLI).href)});`,
    `else await import(${JSON.stringify(pathToFileURL(join(dir, 'src', 'index.js')).href)});`,
  ].join('\n') + '\n');
  return entry;
}

const eventLines = since => since.split('\n').filter(l => !l.includes('POST /v1/messages')).join('\n').slice(-5000);

/** Once any request is answered by a newer worker, the earlier one must never answer again. */
function servingOrder(timeline) {
  const order = [];
  for (const r of timeline) if (r.worker && order.at(-1) !== r.worker) order.push(r.worker);
  return order;
}

for (const [label, env] of [
  ['an update', { MAXPOOL_TEST_RELOAD_IS_UPDATE: '1' }],
  // The new build never reports ready: the old supervisor's rollback notice carries no
  // reload id (and, behind its own blocked terminal writes, may come late or never).
  ['an update whose new build never reports ready', { MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_NEVER_READY: '1' }],
]) test(`old (v1.24.92) supervisor + HEAD workers: ${label}, with the terminal not reading, lands or rolls back cleanly — one primary, the port never frozen`, { skip, timeout: 240_000 }, async () => {
  const cli = await oldSupervisorEntry();
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ cli, env });
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    await pressRestart(term);
    // 45s with the terminal not reading: past the readiness budget (10s) AND the HEAD
    // worker's self-heal (15s) — whatever the old supervisor manages to do meanwhile.
    const stalled = await watch({ port, pid, log, logFrom, ms: 45_000, timeoutMs: 2000, stepMs: 400 });
    // Frozen = a request that hangs, or a stretch of refused connections (two polls in
    // a row). A lone refusal is the hand-off's instant between the old worker closing
    // and the supervisor re-arming — clients retry it.
    const frozen = stalled.timeline.filter((r, i) => /timeout/.test(String(r.status))
      || (!r.worker && i > 0 && !stalled.timeline[i - 1].worker));
    assert.deepEqual(frozen.map(r => `+${r.t}s ${r.status}`), [], `the port stopped answering while the terminal was not reading:\n${describe(stalled.timeline, MARKS)}\n--- event log ---\n${eventLines(stalled.row.since)}`);
    // The terminal reads again: within 30s the pool settles on ONE worker that serves.
    term.cmd('read');
    const settled = await watch({ port, pid, log, logFrom, ms: 30_000, timeoutMs: 2000, pred: r => r.status === 200 && r.kids.length === 1 && r.kids[0] === r.worker });
    const all = [...stalled.timeline, ...settled.timeline];
    assert.ok(settled.ok, `the pool never settled on one serving worker:\n${describe(all, MARKS)}`);
    const order = servingOrder(all);
    assert.equal(new Set(order).size, order.length, `two workers took turns answering (two primaries): ${order.join(' → ')}\n${describe(all, MARKS)}`);
    const final = settled.row.worker;
    const outcome = final === oldWorker ? 'rolled back' : 'landed';
    // Serving keeps working afterwards, on that same single worker.
    await sleep(1500);
    const after = await proxyRequest(port, 2000);
    assert.equal(after.status, 200);
    assert.equal(after.worker, final, `after settling (${outcome}), a different worker answered`);
    assert.deepEqual(childPids(pid), [final], `after settling (${outcome}), extra workers are still alive`);
  } finally { cleanup(); }
});
