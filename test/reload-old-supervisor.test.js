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
  HAVE_PTY, HEAD_CLI, bootPool, bootHeadless, until, stopTheTerminal, pressRestart, watch, describe, proxyRequest, sleep, childPids,
} from './fixtures/reload-pty-harness.js';

const BASELINE = '845bae409382d812782515790e6810fafa425055';   // == v1.24.92 src
const repo = fileURLToPath(new URL('..', import.meta.url));
const haveBaseline = spawnSync('git', ['-C', repo, 'cat-file', '-e', `${BASELINE}^{commit}`], { stdio: 'ignore' }).status === 0;
const skipHeadless = !haveBaseline ? `baseline ${BASELINE.slice(0, 7)} not in this clone` : false;
const skip = !HAVE_PTY ? 'python3 with pty not available' : skipHeadless;
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

for (const [label, env, expected] of [
  // A healthy new build: the hand-off completes once the terminal reads again.
  ['an update', { MAXPOOL_TEST_RELOAD_IS_UPDATE: '1' }, 'landed'],
  // The new build never reports ready: the old supervisor's rollback notice carries no
  // reload id (and, behind its own blocked terminal writes, may come late or never).
  // An id-less notice never authorizes a cold restart, so the current build stays.
  ['an update whose new build never reports ready', { MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_NEVER_READY: '1' }, 'rolled back'],
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
    assert.equal(outcome, expected, `the reload ${outcome}, expected it ${expected}:\n${describe(all, MARKS)}\n--- event log ---\n${eventLines(settled.row.since)}`);
    // Serving keeps working afterwards, on that same single worker.
    await sleep(1500);
    const after = await proxyRequest(port, 2000);
    assert.equal(after.status, 200);
    assert.equal(after.worker, final, `after settling (${outcome}), a different worker answered`);
    assert.deepEqual(childPids(pid), [final], `after settling (${outcome}), extra workers are still alive`);
  } finally { cleanup(); }
});

// ── red-team round 2: the old supervisor's notice carries no reload id ──
// The v1.24.92 supervisor tags EVERY readiness rejection 'timeout' — a new worker that
// exited before ready included — and never names the reload it is about. A worker that
// trusted that reason cold-restarted (exit 75) into a build that cannot boot, and the
// supervisor respawned it forever; one that only recorded it kept admission paused (503)
// until its self-heal, ~50s by default. An id-less notice settles at once and never
// authorizes a cold restart.

const COLD = /Applying the update with a full restart/;

test('old supervisor + HEAD workers: an update whose new build EXITS before ready is not cold-restarted into, and serving resumes within seconds', { skip: skipHeadless, timeout: 120_000 }, async () => {
  const cli = await oldSupervisorEntry();
  const p = await bootHeadless({ cli, env: {
    MAXPOOL_RELOAD_READY_MS: '10000', MAXPOOL_RELOAD_SELFHEAL_MS: '20000',
    MAXPOOL_TEST_RESTART_SIGNAL: '1', MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_EXIT_BEFORE_READY: '1',
  } });
  try {
    process.kill(p.worker, 'SIGUSR2');   // an update reload; its new build dies at the readiness probe
    assert.ok(await until(() => /readiness wait failed/.test(p.out()), 60_000, 20), `precondition: the old supervisor rolled back:\n${p.out()}`);
    const t0 = Date.now();
    const back = await until(async () => (await proxyRequest(p.port, 1000)).status === 200, 15_000, 100);
    const tookMs = Date.now() - t0;
    assert.ok(back && tookMs < 3000, `the pool answered 200 only ${tookMs}ms after the rollback notice (allowed 3000ms):\n${p.out()}`);
    // Past the 20s self-heal: still the same worker, and no cold restart was attempted.
    await sleep(22_000);
    assert.doesNotMatch(p.out(), COLD, `an id-less 'timeout' cold-restarted into a build that died before ready:\n${p.out()}`);
    assert.match(p.out(), /Update NOT applied/, 'the user is told the update did not land');
    const r = await proxyRequest(p.port, 2000);
    assert.equal(r.status, 200);
    assert.equal(r.worker, p.worker, 'the worker that was serving still serves');
    assert.deepEqual(childPids(p.child.pid), [p.worker], 'one worker, the original');
  } finally { await p.stop(); }
});

test('old supervisor + HEAD workers: a late id-less notice for an earlier reload settles the open one at once, and never cold-restarts it', { skip: skipHeadless, timeout: 150_000 }, async () => {
  // Readiness 25s, self-heal 15s: the worker gives up on #1 (no answer), the user retries
  // (#2, which this supervisor ignores while #1 is in flight), then #1's id-less
  // 'timeout' arrives while #2 is open — before #2's own self-heal (~31s).
  const cli = await oldSupervisorEntry();
  const p = await bootHeadless({ cli, env: {
    MAXPOOL_RELOAD_READY_MS: '25000', MAXPOOL_RELOAD_SELFHEAL_MS: '15000',
    MAXPOOL_TEST_RESTART_SIGNAL: '1', MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_NEVER_READY: '1',
  } });
  try {
    process.kill(p.worker, 'SIGUSR2');   // #1
    assert.ok(await until(() => /Reload rolled back \(the supervisor did not answer\)/.test(p.out()), 40_000), `precondition: the self-heal settled #1:\n${p.out()}`);
    const before = p.out().length;
    process.kill(p.worker, 'SIGUSR2');   // #2, while the supervisor still waits on #1
    assert.ok(await until(() => /readiness wait failed/.test(p.out().slice(before)), 30_000, 20), `precondition: #1's notice came:\n${p.out()}`);
    const t0 = Date.now();
    const settled = await until(() => /Reload rolled back/.test(p.out().slice(before)), 5000, 20);
    const tookMs = Date.now() - t0;
    assert.ok(settled && tookMs < 3000, `#2 was not settled at once by the id-less notice (${tookMs}ms):\n${p.out().slice(before)}`);
    assert.ok((await until(async () => (await proxyRequest(p.port, 1000)).status === 200, 3000, 100)), 'serving 200 again');
    await sleep(12_000);                 // past #2's self-heal
    const after = p.out().slice(before);
    assert.doesNotMatch(after, COLD, `a stale id-less notice cold-restarted the open reload:\n${after}`);
    assert.deepEqual(childPids(p.child.pid), [p.worker], 'one worker, the original');
  } finally { await p.stop(); }
});

test('old supervisor + HEAD workers, terminal reading: a reload whose new build reports failure resumes serving within seconds (not at the self-heal)', { skip, timeout: 150_000 }, async () => {
  // Self-heal pushed to 60s: recovering a few seconds after the supervisor's rollback can
  // only be the id-less notice acting.
  const cli = await oldSupervisorEntry();
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ cli, selfHealMs: 60_000, env: { MAXPOOL_TEST_FAIL_RELOAD_WORKER: '1' } });
  try {
    const logFrom = (await log()).length;
    await pressRestart(term);
    const rolled = await watch({ port, pid, log, logFrom, ms: 45_000, timeoutMs: 1000, stepMs: 100, pred: r => /reported failed/.test(r.since) });
    assert.ok(rolled.ok, `precondition: the old supervisor rolled back:\n${describe(rolled.timeline, MARKS)}`);
    const back = await watch({ port, pid, log, logFrom, ms: 10_000, timeoutMs: 1000, stepMs: 100, pred: r => r.status === 200 });
    assert.ok(back.ok && back.row.t < 3, `the pool kept refusing requests ${back.row?.t}s after the rollback notice (allowed 3s):\n${describe(back.timeline, MARKS)}`);
    assert.equal(back.row.worker, oldWorker, 'the worker that was serving still serves');
  } finally { cleanup(); }
});
