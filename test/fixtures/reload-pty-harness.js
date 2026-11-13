// Shared harness for the reload-on-a-real-pty tests (same protocol as
// test/reload-terminal-not-reading.test.js, which keeps its own copy unchanged).
// Throwaway configs, fake tokens, a local stub upstream; a test kills only the
// process group it spawned (Terminal.close → pty-run.py `kill`).
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HEAD_CLI = fileURLToPath(new URL('../../src/index.js', import.meta.url));
const HARNESS = fileURLToPath(new URL('./pty-run.py', import.meta.url));
export const HAVE_PTY = spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;
const PROBE_CHILD = fileURLToPath(new URL('./pending-switch-probe.mjs', import.meta.url));
const TERMINAL_MODE_URL = new URL('../../src/terminal-mode.js', import.meta.url).href;

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function getFreePort() {
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

/** One proxied request → {status, worker, ms} or {error, ms}; never rejects; fresh connection each time. */
export function proxyRequest(port, timeoutMs = 1000) {
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

/** The terminal side of a pty running maxpool. */
export class Terminal {
  constructor({ cli = HEAD_CLI, cols = 200, rows = 60, args = ['server'], env }) {
    this.proc = spawn('python3', [HARNESS, String(cols), String(rows), '--', process.execPath, cli, ...args],
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
    try { this.cmd('kill'); this.proc.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 500).unref();
  }
}

/**
 * Can THIS kernel hold a raw-mode switch pending while the terminal is not reading?
 * A macOS pty can: tcsetattr(TCSADRAIN) waits for the unread output queue (the live
 * stall, 2026-11-13). A Linux pty applies it at once however much is queued (CI run
 * 43520507097 measured {ok:true, ms:23} with the terminal paused), so a test whose
 * precondition is "the switch is still waiting" cannot run there.
 * Resolves {reachable, reason, measured}. reachable is false ONLY on positive evidence:
 * the kernel queue was full (bytes still queued unread) and the switch landed anyway.
 * Anything else (no report, helper error, queue not full) counts as reachable, so the
 * tests run and report the problem rather than skipping it.
 */
export async function probePendingSwitch() {
  if (!HAVE_PTY) return { reachable: false, reason: 'python3 with pty not available', measured: null };
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-probe-'));
  const report = join(dir, 'probe.json');
  const term = new Terminal({ cli: PROBE_CHILD, args: [TERMINAL_MODE_URL, report], cols: 80, rows: 24, env: process.env });
  try {
    await term.next('PID ');
    term.cmd('wait 15');                 // never `read`: the terminal stays paused throughout
    await term.next('EXIT ', 25_000);
    let r = null;
    try { r = JSON.parse(await readFile(report, 'utf8')); } catch { /* no report: treat as reachable */ }
    if (r && r.queued > 0 && r.settled?.ok === true) {
      return { reachable: false, measured: r,
        reason: `this ${process.platform} pty applies a raw-mode switch (tcsetattr TCSADRAIN) without waiting for the terminal: `
          + `${r.queued} bytes were still queued unread and the switch landed in ${r.settled.ms}ms, so a pending switch cannot be produced here` };
    }
    return { reachable: true, measured: r, reason: null };
  } finally { term.close(); }
}

/** Boot a supervised pool on a pty; resolves once it serves and has settled 3s. */
export async function bootPool({ cli = HEAD_CLI, cols = 200, rows = 60, readyMs = 10_000, selfHealMs = 15_000, env: extraEnv = {} } = {}) {
  const port = await getFreePort();
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-ptyreload-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false,
    restartDrainTimeoutMs: 500,
    accounts: [{ name: 'api-live', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');
  const env = {
    ...process.env,
    MAXPOOL_CONFIG: configPath,
    MAXPOOL_DISABLE_SLEEP_GUARD: '1',
    MAXPOOL_DISABLE_QUOTA_PROBE: '1',
    MAXPOOL_RELOAD_READY_MS: String(readyMs),
    MAXPOOL_RELOAD_SELFHEAL_MS: String(selfHealMs),
    TERM: 'xterm-256color',
    ...extraEnv,
  };
  delete env.MAXPOOL_SERVER_WORKER;
  delete env.MAXPOOL_RELOAD_WORKER;
  const term = new Terminal({ cli, cols, rows, env });
  const pid = Number((await term.next('PID ')).slice(4));
  term.cmd('read');
  const deadline = Date.now() + 30_000;
  let first = null;
  while (Date.now() < deadline && !(first = await proxyRequest(port)).worker) await sleep(200);
  assert.ok(first?.worker, 'precondition: the pool came up and served');
  await sleep(3000);
  const logPath = configPath.replace(/\.json$/, '.log');
  const log = () => readFile(logPath, 'utf8').catch(() => '');
  return { port, term, pid, dir, oldWorker: first.worker, log, cleanup: () => { term.close(); upstream.server.close(); } };
}

/**
 * Boot a supervised pool with NO terminal (MAXPOOL_FORCE_SUPERVISOR); resolves once it
 * serves. `out()` is everything the processes printed, `log()` the event log.
 */
export async function bootHeadless({ cli = HEAD_CLI, env: extraEnv = {} } = {}) {
  const port = await getFreePort();
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-headless-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false, shutdown: { drainTimeoutMs: 4000 },
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');
  const env = {
    ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_FORCE_SUPERVISOR: '1',
    MAXPOOL_DISABLE_SLEEP_GUARD: '1', MAXPOOL_DISABLE_QUOTA_PROBE: '1', ...extraEnv,
  };
  delete env.MAXPOOL_SERVER_WORKER;
  delete env.MAXPOOL_RELOAD_WORKER;
  let out = '';
  const child = spawn(process.execPath, [cli, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  const deadline = Date.now() + 30_000;
  let first = null;
  while (Date.now() < deadline && !((first = await proxyRequest(port)).status === 200 && first.worker)) await sleep(200);
  assert.ok(first?.worker, `precondition: the pool came up and served:\n${out}`);
  const logPath = configPath.replace(/\.json$/, '.log');
  const stop = async () => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    await new Promise(r => { if (child.exitCode != null || child.signalCode != null) r(); else { child.once('exit', r); setTimeout(r, 3000).unref(); } });
    await new Promise(r => upstream.server.close(r));
  };
  return { port, child, worker: first.worker, out: () => out, log: () => readFile(logPath, 'utf8').catch(() => ''), stop };
}

/** Poll `pred` until it holds or `timeoutMs` elapse. */
export async function until(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await sleep(stepMs);
  }
  return false;
}

/** The supervisor's live worker children. */
export function childPids(pid) {
  const r = spawnSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' });
  return (r.stdout || '').split('\n').filter(Boolean).map(Number).sort((a, b) => a - b);
}

/** r = restart (the same seamless hand-off a self-update runs), then y = confirm. */
export async function pressRestart(term) {
  term.cmd(`keys ${Buffer.from('r').toString('hex')}`);
  await sleep(700);
  term.cmd(`keys ${Buffer.from('y').toString('hex')}`);
}

/** The terminal stops reading and the dashboard fills the pty's output queue. */
export async function stopTheTerminal(term, port) {
  term.cmd('pause');
  for (let i = 0; i < 10; i++) { await proxyRequest(port, 1500); await sleep(30); }
}

/** Poll until `pred` holds or `ms` elapse; returns the per-poll timeline either way. */
export async function watch({ port, pid, log, logFrom = 0, ms, pred = () => false, timeoutMs = 900, stepMs = 500 }) {
  const t0 = Date.now();
  const timeline = [];
  while (Date.now() - t0 < ms) {
    const r = await proxyRequest(port, timeoutMs);
    const row = { t: Math.round((Date.now() - t0) / 100) / 10, status: r.status || r.error, worker: r.worker, ms: r.ms,
      kids: pid ? childPids(pid) : [], since: log ? (await log()).slice(logFrom) : '' };
    timeline.push(row);
    if (pred(row)) return { ok: true, row, timeline };
    await sleep(stepMs);
  }
  return { ok: false, row: timeline.at(-1), timeline };
}

export const describe = (timeline, marks = []) => timeline.map(r =>
  `  +${r.t}s req=${r.status}${r.worker ? `/pid ${r.worker}` : ''} (${r.ms}ms) workers=[${r.kids}] log=[${marks.filter(m => r.since.includes(m)).join(' | ')}]`).join('\n');
