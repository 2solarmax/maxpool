// Terminal-hangup safety: closing the terminal that runs maxpool must STOP it
// cleanly, never reload into a headless orphan that outlives the terminal and
// squats port 3456 with no TUI and no way to quit. A window close delivers SIGHUP
// to the whole foreground process group (supervisor + worker). The fix gates SIGHUP
// on interactivity: interactive → drain+exit; headless → reload. We can't allocate
// a real pty in this zero-dependency suite, so MAXPOOL_FORCE_TTY=1 makes the
// supervisor + worker take the interactive branch, and we deliver a GROUP SIGHUP
// (process.kill(-pid, ...)) to faithfully reproduce a terminal hangup — which
// exercises the double-signal interaction (the pre-mortem BLOCKER) for real.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
function startJsonUpstream() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}
function proxyGet(port, apiKey, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
}
async function waitFor(pred, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await pred()) return true; await new Promise(r => setTimeout(r, stepMs)); }
  throw new Error('waitFor predicate never became true');
}
function portFree(port) {
  return new Promise(resolve => {
    const s = net.connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(true));
  });
}

test('terminal hangup (group SIGHUP, interactive): supervisor + worker shut down cleanly, no orphan, no respawn', async () => {
  const upstream = await startJsonUpstream();
  const port = await getFreePort();
  const apiKey = 'mp-test-key';
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-hup-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false, switchThreshold: 0.90, shutdown: { drainTimeoutMs: 3000 },
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');

  let out = '';
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_FORCE_SUPERVISOR: '1', MAXPOOL_FORCE_TTY: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true, // detached → own process group for the group SIGHUP
  });
  child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);

  const exited = new Promise(r => child.once('exit', (code, signal) => r({ code, signal })));

  try {
    await waitFor(async () => { try { return (await proxyGet(port, apiKey)).status === 200; } catch { return false; } }, 20000);
    const beforeHup = out;

    // Terminal hangup: SIGHUP to the whole process group (supervisor + worker).
    process.kill(-child.pid, 'SIGHUP');

    // The whole thing must EXIT (not survive headless). Bounded so a hang fails loud.
    const result = await Promise.race([
      exited,
      new Promise(r => setTimeout(() => r({ timeout: true }), 8000)),
    ]);
    assert.notEqual(result.timeout, true, 'maxpool did not exit after the terminal hangup — it survived as an orphan');

    // The interactive branch must DRAIN+SHUTDOWN, not reload.
    assert.match(out, /Draining shutdown \(SIGHUP\)/, 'worker chose graceful shutdown on the hangup');

    // No respawn into an orphan: nothing reloaded/relistened AFTER the hangup.
    const afterHup = out.slice(beforeHup.length);
    assert.doesNotMatch(afterHup, /cutover complete/, 'must NOT seamless-reload on a terminal hangup');
    assert.doesNotMatch(afterHup, /Listening on/, 'must NOT respawn a fresh worker after the hangup');
    assert.doesNotMatch(afterHup, /crash #\d/, 'the clean shutdown must NOT be misread as a crash to back off + respawn');

    // The port is released (no lingering process holding :port).
    await waitFor(() => portFree(port), 6000);
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    try { child.kill('SIGKILL'); } catch { /* gone */ }
    await new Promise(r => upstream.server.close(r));
  }
});
