// Regression: a connection the SUPERVISOR accepts must never be black-holed.
//
// The supervisor owns the listening socket and hands it to a worker, but keeps its
// OWN accept loop live (a) from the moment it binds until the first worker sends
// MSG_PRIMARY (the worker takes ~0.5-2s to boot, longer under load) and (b) over
// the reload cutover gap. A bare `net.Server` with no 'connection' handler accepts
// those connections and never reads or answers them: the client hangs, then gets
// ECONNRESET. Found 2026-11-08 as the root cause of test/reload-oauth-refresh-
// across-reload.test.js flaking: its first request was swallowed, so the expired-
// token refresh never reached the stub ("refresh POST arrived at stub" timeout).
//
// A second hole sits one hop later: when the listening socket is handed to the worker
// over IPC as a net.Server, Node builds an intermediate net.Server in the worker that
// accepts the already-queued connections before user code can attach, so they are
// stranded there with their request bytes unread (measured with a standalone script:
// 8 queued connections, the worker's HTTP server got 0-5). The supervisor therefore
// sends the raw TCP handle. A BURST of connections exercises both holes.
//
// Deterministic enough to fail every time on the old code: we connect the instant the
// port is bound, which is BEFORE any worker can possibly be listening, so the
// supervisor is the only acceptor and everything is queued at hand-over.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../src/index.js', import.meta.url));

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

// Resolve as soon as a TCP connect to the port succeeds (supervisor bound), keeping
// that socket open so the caller can speak HTTP on it.
function connectWhenBound(port, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect({ host: '127.0.0.1', port });
      sock.once('connect', () => resolve(sock));
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() > deadline) reject(new Error('supervisor never bound the port'));
        else setTimeout(attempt, 2);
      });
    };
    attempt();
  });
}

const BURST = 6;

test('connections made before the worker is up are all served, none black-holed', async () => {
  const port = await getFreePort();
  const apiKey = 'mp-test-key';
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-blackhole-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey },
    updateCheck: false,
    accounts: [{ name: 'k@test', type: 'apikey', apiKey: 'sk-ant-test-not-real' }],
  }) + '\n');

  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: {
      ...process.env,
      MAXPOOL_CONFIG: configPath,
      MAXPOOL_FORCE_SUPERVISOR: '1',
      MAXPOOL_DISABLE_QUOTA_PROBE: '1',
      MAXPOOL_DISABLE_SLEEP_GUARD: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);

  const socks = [];
  try {
    // Burst: every connection is made before any worker exists, then each asks for status.
    socks.push(await connectWhenBound(port, 20000));
    for (let i = 1; i < BURST; i++) socks.push(await connectWhenBound(port, 20000));
    const replies = await Promise.all(socks.map((sock, idx) => new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error(`connection #${idx} got no HTTP reply within 20s (black-holed). child output:\n${out.slice(-1500)}`)), 20000);
      sock.on('data', d => {
        buf += d;
        if (/\r\n\r\n/.test(buf)) { clearTimeout(timer); resolve(buf); }
      });
      sock.on('error', e => { clearTimeout(timer); reject(new Error(`connection #${idx} errored: ${e.code}. child output:\n${out.slice(-1500)}`)); });
      sock.on('close', () => { if (!/\r\n\r\n/.test(buf)) { clearTimeout(timer); reject(new Error(`connection #${idx} closed with no reply. child output:\n${out.slice(-1500)}`)); } });
      sock.write(`GET /maxpool/status HTTP/1.1\r\nHost: 127.0.0.1\r\nx-api-key: ${apiKey}\r\nConnection: close\r\n\r\n`);
    })));
    for (const [idx, reply] of replies.entries()) {
      assert.match(reply, /^HTTP\/1\.1 200 /, `connection #${idx}: expected a 200 from the worker, got: ${reply.split('\r\n')[0]}`);
    }
  } finally {
    for (const sock of socks) { try { sock.destroy(); } catch { /* ignore */ } }
    killGroup(child);
    await new Promise(r => { if (child.exitCode != null || child.signalCode != null) r(); else { child.once('exit', r); const t = setTimeout(r, 3000); t.unref?.(); } });
  }
});
