// Red-team round 1 on the terminal-not-reading fix (2026-11-13): rollback races,
// headless (MAXPOOL_FORCE_SUPERVISOR, no pty). Throwaway config, fake key, local
// stub upstream; each test kills only the process group it spawned.
//
//   1. a STALE rollback notice (for an earlier reload) must not settle the open one —
//      it used to, and an update reload then cold-restarted in the middle of a baton
//   2. an old worker that dies mid-reload must not let the baton's fallback end the
//      NEXT turn — it used to, leaving two primaries (two lease holders)
//   3. an update-driven reload must not make a later plain restart "an update"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFreePort, proxyRequest, sleep } from './fixtures/reload-pty-harness.js';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function startUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function until(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

function childPids(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number);
}

async function boot(env) {
  const upstream = await startUpstream();
  const port = await getFreePort();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-races-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false, shutdown: { drainTimeoutMs: 4000 },
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');
  const fullEnv = { ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_FORCE_SUPERVISOR: '1', MAXPOOL_DISABLE_SLEEP_GUARD: '1', MAXPOOL_DISABLE_QUOTA_PROBE: '1', ...env };
  delete fullEnv.MAXPOOL_SERVER_WORKER;
  delete fullEnv.MAXPOOL_RELOAD_WORKER;
  let out = '';
  const child = spawn(process.execPath, [cliPath, 'server'], { env: fullEnv, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  let worker = null;
  assert.ok(await until(async () => { const r = await proxyRequest(port, 1000); worker = r.worker; return r.status === 200 && worker; }, 20_000),
    `precondition: the pool came up:\n${out}`);
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    await new Promise(r => { if (child.exitCode != null || child.signalCode != null) r(); else { child.once('exit', r); setTimeout(r, 3000).unref(); } });
    await new Promise(r => upstream.server.close(r));
  };
  return { port, dir, child, worker, out: () => out, stop };
}

test('a stale rollback notice for an earlier reload does not settle (or cold-restart) the open one', { timeout: 120_000 }, async () => {
  // Readiness budget 25s, self-heal 15s: the worker gives up on reload #1 before the
  // supervisor does, the user retries (#2), and #1's 'timeout' arrives (~25s) while #2
  // is still open (#2's own self-heal fires ~31s) — so ignoring it is the id check's
  // doing, never a race with #2's self-heal (30s readiness let that race decide).
  const p = await boot({
    MAXPOOL_RELOAD_READY_MS: '25000', MAXPOOL_RELOAD_SELFHEAL_MS: '15000',
    MAXPOOL_TEST_RESTART_SIGNAL: '1', MAXPOOL_TEST_RELOAD_IS_UPDATE: '1', MAXPOOL_TEST_RELOAD_NEVER_READY: '1',
  });
  try {
    process.kill(p.worker, 'SIGUSR2');   // reload #1 (an update), the new build never reports ready
    assert.ok(await until(() => /Reload rolled back \(the supervisor did not answer\)/.test(p.out()), 25_000),
      `precondition: the self-heal settled reload #1:\n${p.out()}`);
    const before = p.out().length;
    process.kill(p.worker, 'SIGUSR2');   // reload #2, while the supervisor still works on #1
    assert.ok(await until(() => /readiness wait failed/.test(p.out()), 25_000), `precondition: #1's timeout fired:\n${p.out()}`);
    await sleep(3000);
    const after = p.out().slice(before);
    assert.doesNotMatch(after, /Applying the update with a full restart/, `reload #2 was cold-restarted on reload #1's notice:\n${after}`);
    assert.doesNotMatch(after, /Reload rolled back \(the new worker did not report ready in time\)/, `reload #2 was settled by reload #1's notice:\n${after}`);
    const events = await readFile(join(p.dir, 'config.log'), 'utf8').catch(() => '');
    assert.match(events, /Ignored a rollback notice for an earlier reload/, `#1's notice reached #2 while it was open and was ignored by its id:\n${events.slice(-3000)}`);
  } finally { await p.stop(); }
});

test('an old worker that dies mid-reload leaves exactly one primary (the fallback never ends the next turn)', { timeout: 120_000 }, async () => {
  const p = await boot({ MAXPOOL_TEST_CRASH_SIGNAL: '1', MAXPOOL_TEST_RELOAD_READY_DELAY_MS: '3000' });
  try {
    process.kill(p.worker, 'SIGHUP');    // headless: a seamless reload; the new worker reports ready at +3s
    await sleep(300);
    process.kill(p.worker, 'SIGUSR2');   // the old worker crashes (exit 75) before the hand-off
    // The respawned cold worker serves; then the reload's own outcome lands (release
    // wait on a dead worker → fallback). Give it the supervisor's 20s release budget.
    await sleep(26_000);
    const kids = childPids(p.child.pid);
    const servedBy = new Set();
    for (let i = 0; i < 8; i++) { const r = await proxyRequest(p.port, 1500); if (r.worker) servedBy.add(r.worker); await sleep(100); }
    assert.match(p.out(), /old worker did not release/, `precondition: the reload reached its fallback:\n${p.out()}`);
    assert.equal(kids.length, 1, `expected one worker, found ${kids.length} (${kids}):\n${p.out()}`);
    assert.deepEqual([...servedBy], kids, `requests were served by ${[...servedBy]} (workers ${kids})`);
  } finally { await p.stop(); }
});

test('after an update-driven reload, a plain restart is not treated as an update', { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-once-'));
  const once = join(dir, 'first-reload-is-an-update');
  await writeFile(once, '');
  const p = await boot({ MAXPOOL_TEST_RESTART_SIGNAL: '1', MAXPOOL_TEST_FAIL_RELOAD_WORKER: '1', MAXPOOL_TEST_RELOAD_IS_UPDATE: once });
  try {
    process.kill(p.worker, 'SIGUSR2');   // #1: an update; the new build reports failure
    assert.ok(await until(() => /Update NOT applied/.test(p.out()), 20_000), `precondition: #1 rolled back as an update:\n${p.out()}`);
    assert.ok(await until(async () => (await proxyRequest(p.port, 1000)).status === 200, 10_000), 'precondition: serving again');
    const before = p.out().length;
    process.kill(p.worker, 'SIGUSR2');   // #2: a plain restart
    assert.ok(await until(() => /Rollback complete|Update NOT applied/.test(p.out().slice(before)), 20_000), `#2 never settled:\n${p.out()}`);
    const after = p.out().slice(before);
    assert.match(after, /Rollback complete — resumed serving on the current version/, `a plain restart was reported as an update:\n${after}`);
    assert.doesNotMatch(after, /Update NOT applied/);
  } finally { await p.stop(); }
});
