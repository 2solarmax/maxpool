// A seamless reload must not depend on the terminal reading its output.
//
// Live (2026-11-13, Mac, v1.24.91 → 1.24.92): the auto-update's seamless reload rolled
// back. The old worker's 50s self-heal fired ("Reload rolled back (new worker never took
// over)" → "The new version failed to start … Update NOT applied") and the supervisor's
// 30s readiness timeout only reached the event log 7m36s after the reload began. For those
// 50s the pool admitted no new request. The terminal had stopped reading (the same Mac
// later logged "terminal reclaimed after drain in 67705ms").
//
// Mechanism (reproduced here on a real pty, stacks taken with `sample`): the supervisor
// and the new reload worker share the terminal with the old worker, but — unlike the old
// worker's dashboard (release A made it non-blocking) — they write to it with Node's
// default BLOCKING tty writes. Once the terminal stops reading, the pty's ~1 KB output
// queue is full and:
//   (a) the reload worker blocks inside a boot-time console.log ("Duplicate guard: …",
//       "Team pools: …", "Config providers: …" — all printed BEFORE its stdout muzzle),
//       so it never reaches its IPC handler and never answers MSG_PROBE_READY;
//   (b) the supervisor's readiness timer fires on time, then blocks inside its own
//       console.log ("reload: readiness wait failed …") BEFORE sending MSG_ROLLED_BACK
//       and before reaping the new worker — so the old worker's self-heal sees no reason
//       (treated as "failed to start", the update is abandoned) and the stuck reload
//       worker lives until the terminal reads again.
//
// These tests drive the REAL supervisor + workers on a pty whose reader they control
// (test/fixtures/pty-run.py), with throwaway configs, fake tokens and a local stub
// upstream. They kill only the process group they spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const HARNESS = fileURLToPath(new URL('./fixtures/pty-run.py', import.meta.url));
const HAVE_PTY = spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'python3 with pty not available';

// Shortest budgets the pool accepts (index.js RELOAD_READY_MS floor 10s, self-heal floor 15s).
const READY_MS = 10_000;
const SELFHEAL_MS = 15_000;
// Accounts the team pool also holds → one "Duplicate guard: …" boot line each (live: 15).
const DUP_ACCOUNTS = 15;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"msg_ok","type":"message","content":[]}');
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

// One proxied request → {status, worker, ms} or {error, ms}; never rejects. A fresh
// connection per request (agent: false) so every probe is independent of the last.
function proxyRequest(port, timeoutMs = 1000) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', timeout: timeoutMs, agent: false,
        headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } },
      res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, worker: Number(res.headers['x-maxpool-worker']) || null, ms: Date.now() - t0 })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.end(JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }));
  });
}

/** The terminal side of a pty running maxpool (same protocol as tui-terminal-pty.test.js). */
class Terminal {
  constructor(args, env) {
    this.proc = spawn('python3', [HARNESS, '200', '60', '--', process.execPath, cliPath, ...args],
      { env, stdio: ['pipe', 'pipe', 'inherit'] });
    this.lines = [];
    this.waiting = [];
    createInterface({ input: this.proc.stdout }).on('line', line => {
      const i = this.waiting.findIndex(w => line.startsWith(w.prefix));
      if (i >= 0) { const [w] = this.waiting.splice(i, 1); clearTimeout(w.timer); w.resolve(line); } else this.lines.push(line);
    });
  }

  cmd(s) { this.proc.stdin.write(`${s}\n`); }

  next(prefix, timeoutMs = 15_000) {
    const i = this.lines.findIndex(l => l.startsWith(prefix));
    if (i >= 0) return Promise.resolve(this.lines.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`harness never said ${prefix.trim()}`)), timeoutMs);
      this.waiting.push({ prefix, resolve, timer });
    });
  }

  close() {
    // `kill` = SIGKILL the pty child's process group (the supervisor and its workers only).
    try { this.cmd('kill'); this.proc.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 500).unref();
  }
}

// `bootLines`: give the reload worker the live machine's boot-time console output — one
// "Duplicate guard" line per account the team pool also holds (seeded from the state file,
// as in reload-restart-integration.test.js; the pool URL is a dead port, nothing leaves
// the machine) plus "Team pools: 1 linked".
async function bootPool({ bootLines = true, env: extraEnv = {} } = {}) {
  const port = await getFreePort();
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-ttystall-'));
  const configPath = join(dir, 'config.json');
  const accounts = [{ name: 'api-live', type: 'apikey', apiKey: 'sk-ant-stub' }];
  const identities = {};
  if (bootLines) {
    for (let i = 1; i <= DUP_ACCOUNTS; i++) {
      accounts.push({ name: `dup-${i}@example.test`, type: 'oauth', accountUuid: `U${i}`,
        accessToken: `at${i}`, refreshToken: `rt${i}`, expiresAt: Date.now() + 3600_000 });
      identities[`uuid:U${i}`] = { name: `dup-${i}@example.test` };
    }
  }
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false,
    restartDrainTimeoutMs: 500,
    accounts,
    ...(bootLines ? { pools: [{ name: 'team', url: 'http://127.0.0.1:1', key: 'k', intervalMs: 600_000 }] } : {}),
  }) + '\n');
  if (bootLines) {
    await writeFile(configPath.replace(/\.json$/, '.state.json'), JSON.stringify({
      _generation: 1, poolIdentities: { team: identities }, poolIdentitiesAt: Date.now(),
    }));
  }
  const env = {
    ...process.env,
    MAXPOOL_CONFIG: configPath,
    MAXPOOL_DISABLE_SLEEP_GUARD: '1',
    MAXPOOL_DISABLE_QUOTA_PROBE: '1',
    MAXPOOL_RELOAD_READY_MS: String(READY_MS),
    MAXPOOL_RELOAD_SELFHEAL_MS: String(SELFHEAL_MS),
    TERM: 'xterm-256color',
    ...extraEnv,
  };
  delete env.MAXPOOL_SERVER_WORKER;   // supervised: the TTY supervisor + its workers
  delete env.MAXPOOL_RELOAD_WORKER;
  const term = new Terminal(['server'], env);
  const pid = Number((await term.next('PID ')).slice(4));
  term.cmd('read');
  const deadline = Date.now() + 30_000;
  let first = null;
  while (Date.now() < deadline && !(first = await proxyRequest(port)).worker) await sleep(200);
  assert.ok(first?.worker, 'precondition: the pool came up and served');
  // Settle before any reload: live, the worker had been up for days. A reload requested
  // within ~1s of a cold start is a different path (observed here: after "cutover
  // complete" every connection was reset) and is not what these tests pin.
  await sleep(3000);
  const settled = await proxyRequest(port);
  assert.equal(settled.worker, first.worker, 'precondition: the cold worker is still the one serving after settling');
  const logPath = configPath.replace(/\.json$/, '.log');
  const log = () => readFile(logPath, 'utf8').catch(() => '');
  return { port, term, pid, oldWorker: first.worker, log, cleanup: () => { term.close(); upstream.server.close(); } };
}

// The supervisor's live worker children.
function childPids(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
}

// r = restart (the same seamless hand-off a self-update runs), then y = confirm.
async function pressRestart(term) {
  term.cmd(`keys ${Buffer.from('r').toString('hex')}`);
  await sleep(700);
  term.cmd(`keys ${Buffer.from('y').toString('hex')}`);
}

// The terminal stops reading and the old worker's dashboard fills the pty's output queue.
async function stopTheTerminal(term, port) {
  term.cmd('pause');
  for (let i = 0; i < 10; i++) { await proxyRequest(port, 1500); await sleep(30); }
}

// Poll until `pred` holds or `ms` elapse; returns the per-second timeline either way.
async function watch({ port, pid, log, logFrom, ms, pred }) {
  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < ms) {
    const r = await proxyRequest(port, 900);
    const kids = childPids(pid);
    const since = (await log()).slice(logFrom);
    const row = { t: Math.round((Date.now() - t0) / 100) / 10, status: r.status || r.error, worker: r.worker, kids, since };
    timeline.push(row);
    if (pred(row)) return { ok: true, row, timeline };
    await sleep(500);
  }
  return { ok: false, row: timeline.at(-1), timeline };
}

const MARKS = ['Team pools: 1 linked', 'readiness wait failed', 'reported failed', 'cutover complete', 'Reload rolled back', 'Rollback complete'];
const describe = timeline => timeline.map(r =>
  `  +${r.t}s req=${r.status}${r.worker ? `/pid ${r.worker}` : ''} workers=[${r.kids}] log=[${MARKS.filter(m => r.since.includes(m)).join(' | ')}]`).join('\n');

// With the terminal READING, this same config cuts over in ~1-2s (measured 2026-11-13 by
// hand on this harness), far inside the 10s readiness budget — so a slow boot is not what
// these tests catch. Not kept as a test here: on this harness ~1 in 3-4 reloads that DO
// cut over are followed by every new connection failing ECONNRESET for 10s+ (only the new,
// idle worker holds the listening socket; seen with and without client keep-alive; cause
// not yet known) — a separate defect that would make a control flaky. After a fix for the
// stall, the first test below can surface that defect too: ECONNRESET rows after
// "cutover complete" in its timeline are that, not the stall.

test('a restart lands while the terminal is not reading (new worker serves within the readiness budget)', { skip, timeout: 120_000 }, async () => {
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool();
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    await pressRestart(term);
    // Readiness budget + margin. The terminal stays stopped for the whole window: a fix
    // must not depend on it reading again (live, it did not for 7+ minutes).
    const w = await watch({ port, pid, log, logFrom, ms: READY_MS + 10_000,
      pred: r => r.status === 200 && r.worker && r.worker !== oldWorker });
    assert.ok(w.ok, `the reload never handed over to a new worker while the terminal was not reading `
      + `(old worker pid ${oldWorker}):\n${describe(w.timeline)}`);
  } finally { cleanup(); }
});

test('(a) the reload worker finishes booting while the terminal is not reading', { skip, timeout: 120_000 }, async () => {
  const { port, term, pid, log, cleanup } = await bootPool();
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    await pressRestart(term);
    // "Team pools: 1 linked" is the reload worker's LAST pre-handler boot line. The event
    // log append runs on the worker's event loop, so it lands only if no earlier boot
    // console.log is stuck in a blocking write to the terminal. Booting this config takes
    // ~1s with the terminal reading (see the note above). The cold worker printed the same
    // line at its own boot, so count over the WHOLE log: the reload worker's is the 2nd.
    const linked = s => (s.match(/Team pools: 1 linked/g) || []).length;
    const before = linked((await log()).slice(0, logFrom));
    assert.equal(before, 1, 'precondition: only the cold worker\'s own boot line is in the log so far');
    const w = await watch({ port, pid, log, logFrom, ms: 8_000, pred: r => before + linked(r.since) >= 2 });
    assert.ok(w.ok, `the reload worker never finished booting while the terminal was not reading — it is blocked `
      + `in a boot-time console.log to the terminal before its IPC handler exists:\n${describe(w.timeline)}`);
  } finally { cleanup(); }
});

test('(b) the supervisor acts on a failed reload while the terminal is not reading', { skip, timeout: 120_000 }, async () => {
  // Minimal config (no boot-time lines) + the failing-new-worker test hook: the reload
  // worker answers MSG_PROBE_READY with MSG_FAILED immediately, so ONLY the supervisor's
  // own handling is under test. Its next steps — log, tell the old worker why
  // (MSG_ROLLED_BACK), kill the reload worker — must not wait for the terminal.
  const { port, term, pid, oldWorker, log, cleanup } = await bootPool({ bootLines: false, env: { MAXPOOL_TEST_FAIL_RELOAD_WORKER: '1' } });
  try {
    await stopTheTerminal(term, port);
    const logFrom = (await log()).length;
    await pressRestart(term);
    // A reload worker existed: seen as a 2nd child, or (if reaped before the first poll)
    // proven by the supervisor's own "reported failed" line.
    let sawReloadWorker = false;
    const w = await watch({ port, pid, log, logFrom, ms: 8_000, pred: r => {
      if (r.kids.length > 1 || r.since.includes('reported failed')) sawReloadWorker = true;
      return sawReloadWorker && r.kids.length === 1 && r.kids[0] === oldWorker;
    } });
    assert.ok(sawReloadWorker, `precondition: a reload worker was spawned:\n${describe(w.timeline)}`);
    assert.ok(w.ok, `the supervisor never reaped the failed reload worker while the terminal was not reading — `
      + `it is blocked in its rollback console.log, so MSG_ROLLED_BACK and the kill wait for the terminal:\n${describe(w.timeline)}`);
  } finally { cleanup(); }
});
