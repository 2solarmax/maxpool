// The pool must never block on its own terminal — proven on a REAL pseudo-terminal
// (2026-11-12). Live: the Mac pool's main thread sat 100% in a synchronous TTY write()
// for up to 60s while the terminal fell behind; every account's requests stalled at
// once. A fake stdout cannot show this (Node's TTY stream is synchronous only on a real
// TTY), so these tests run the REAL worker on a pty whose reader they control
// (test/fixtures/pty-run.py, the judge's probe approach).
//
//   (a) terminal stops reading → the HTTP listener still answers within 1s
//   (b) quit while the terminal is behind → the exit sequence still arrives
//   (c) self-update hand-off with a slow terminal → the old worker's exit sequence lands
//       before the new worker paints, and nothing from the old worker after it
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));
const HARNESS = fileURLToPath(new URL('./fixtures/pty-run.py', import.meta.url));
const HAVE_PTY = spawnSync('python3', ['-c', 'import pty, termios'], { stdio: 'ignore' }).status === 0;
const skip = HAVE_PTY ? false : 'python3 with pty not available';

const EXIT_SEQ = '\x1b[?25h\x1b[?1049l';
const ENTER_ALT = '\x1b[?1049h';
const LEAVE_ALT = '\x1b[?1049l';

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

// One proxied request (it logs a line and renders on the TUI). Resolves {status, ms}
// or {error, ms} — never rejects, so a frozen pool reads as a timeout, not a crash.
function proxyRequest(port, timeoutMs) {
  const t0 = Date.now();
  return new Promise(resolve => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } },
      res => { res.resume(); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0 })); });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ error: e.message, ms: Date.now() - t0 }));
    req.end(JSON.stringify({ model: 'claude-x', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }));
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** The terminal side of a pty running maxpool. */
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

  async screen() {
    this.cmd('dump');
    return Buffer.from((await this.next('OUT ')).slice(4), 'base64').toString('utf8');
  }

  async waitExit(seconds) {
    this.cmd(`wait ${seconds}`);
    return (await this.next('EXIT ', (seconds + 5) * 1000)).slice(5);
  }

  close() {
    try { this.cmd('kill'); this.proc.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* gone */ } }, 500).unref();
  }
}

async function bootPool({ supervised = false } = {}) {
  const port = await getFreePort();
  const upstream = await startUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-pty-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false,
    restartDrainTimeoutMs: 500,
    accounts: [{ name: 'a1', type: 'oauth', accountUuid: 'u1', accessToken: 'at1', refreshToken: 'rt1', expiresAt: Date.now() + 3600_000 }],
  }) + '\n');
  const env = {
    ...process.env,
    MAXPOOL_CONFIG: configPath,
    MAXPOOL_DISABLE_SLEEP_GUARD: '1',
    MAXPOOL_DISABLE_QUOTA_PROBE: '1',
    TERM: 'xterm-256color',
    // Unsupervised = the worker itself owns the pty (no IPC parent) — the exact
    // process that froze live. Supervised = the TTY supervisor + its worker.
    ...(supervised ? {} : { MAXPOOL_SERVER_WORKER: '1' }),
  };
  const term = new Terminal(['server'], env);
  await term.next('PID ');
  term.cmd('read');
  await waitFor(async () => (await proxyRequest(port, 1000)).status === 200, 20_000, 'the pool to serve');
  return { port, term, cleanup: () => { term.close(); upstream.server.close(); } };
}

test('(a) a terminal that stops reading never stops the pool answering', { skip, timeout: 60_000 }, async () => {
  const { port, term, cleanup } = await bootPool();
  try {
    term.cmd('pause');   // the terminal falls behind and stops reading entirely
    // Traffic while the terminal is hung: every request logs a line and redraws.
    const slow = [];
    for (let i = 0; i < 30; i++) {
      const r = await proxyRequest(port, 1000);
      if (r.status !== 200) slow.push(`#${i}: ${r.error || r.status} after ${r.ms}ms`);
      await sleep(50);
    }
    assert.deepEqual(slow, [], `requests not answered within 1s while the terminal was not reading:\n${slow.join('\n')}`);
  } finally { cleanup(); }
});

test('(b) quitting while the terminal is behind still delivers the exit sequence', { skip, timeout: 60_000 }, async () => {
  const { port, term, cleanup } = await bootPool();
  try {
    term.cmd('pause');
    for (let i = 0; i < 10; i++) { await proxyRequest(port, 500); await sleep(30); }   // frames back up
    term.cmd('keys 03');            // Ctrl-C: the TUI quit path (drain, then exit)
    await sleep(1500);              // the worker reaches process exit with output still queued
    term.cmd('read');               // the terminal catches up
    assert.equal(await term.waitExit(15), '0', 'the pool exited cleanly');
    const out = await term.screen();
    const lastFrame = out.lastIndexOf('\x1b[?25l');
    const lastExit = out.lastIndexOf(EXIT_SEQ);
    assert.ok(lastExit >= 0, `the exit sequence never reached the terminal (tail: ${JSON.stringify(out.slice(-200))})`);
    assert.ok(lastExit > lastFrame, `the terminal was left in the dashboard screen: last frame at ${lastFrame}, exit sequence at ${lastExit}`);
  } finally { cleanup(); }
});

test('(c) self-update hand-off: the old worker is done writing before the new one paints', { skip, timeout: 120_000 }, async () => {
  const { port, term, cleanup } = await bootPool({ supervised: true });
  try {
    // A terminal falling behind: ~50 KB/s against ~20 KB frames.
    term.cmd('read-slow 1024 20');
    for (let i = 0; i < 10; i++) { await proxyRequest(port, 2000); await sleep(30); }
    // r = restart (the same hand-off a self-update runs), then y = confirm. Separate
    // keystrokes: the TUI reads a multi-char chunk as a paste and ignores it.
    term.cmd(`keys ${Buffer.from('r').toString('hex')}`);
    await sleep(700);
    term.cmd(`keys ${Buffer.from('y').toString('hex')}`);
    // The new worker's start() is the 2nd alt-screen enter. Then let the old worker
    // finish its drain and exit while the terminal is still slow.
    await waitFor(async () => (await term.screen()).split(ENTER_ALT).length - 1 >= 2, 60_000, 'the new worker to take over');
    await sleep(3000);
    term.cmd('read');
    await sleep(1500);
    const out = await term.screen();
    const enters = [];
    for (let i = out.indexOf(ENTER_ALT); i >= 0; i = out.indexOf(ENTER_ALT, i + 1)) enters.push(i);
    const newWorkerStart = enters[1];
    const leaves = [];
    for (let i = out.indexOf(LEAVE_ALT); i >= 0; i = out.indexOf(LEAVE_ALT, i + 1)) leaves.push(i);
    assert.ok(leaves.some(i => i < newWorkerStart), 'the old worker left the screen before the new worker painted');
    const late = leaves.filter(i => i > newWorkerStart);
    assert.deepEqual(late, [], `the old worker wrote its exit sequence AFTER the new worker took the screen (at ${late}, new worker at ${newWorkerStart})`);
    assert.equal((await proxyRequest(port, 3000)).status, 200, 'the new worker serves');
  } finally { cleanup(); }
});
