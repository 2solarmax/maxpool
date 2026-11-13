// A rolled-back seamless reload resumes serving when the supervisor SAYS so, not at the
// old worker's self-heal.
//
// Live (2026-11-13, Mac): the supervisor rolled a reload back, but the old worker only
// recorded the reason and kept every new request at 503 "restarting" until its 50s
// self-heal fired — and when no reason had arrived it called it "The new version failed
// to start". Here the self-heal is pushed to 60s, so a pool that recovers within a few
// seconds can only have acted on the supervisor's MSG_ROLLED_BACK.
//
// Headless (MAXPOOL_FORCE_SUPERVISOR, no pty), throwaway config, fake key, local stub
// upstream; kills only the process group it spawned.
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
const SELFHEAL_MS = 60_000;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

function startJsonUpstream() {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

function proxyGet(port, apiKey, timeoutMs = 3000) {
  return new Promise(resolve => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', agent: false,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey } }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', e => resolve({ error: e.message }));
    req.end(JSON.stringify({ model: 'x', max_tokens: 1, messages: [] }));
  });
}

async function waitFor(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  return false;
}

test('a rolled-back reload resumes serving on the supervisor\'s notice, not at the self-heal', { timeout: 90_000 }, async () => {
  const upstream = await startJsonUpstream();
  const port = await getFreePort();
  const apiKey = 'mp-test-key';
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-rbanswer-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey },
    upstream: `http://127.0.0.1:${upstream.port}`,
    updateCheck: false, shutdown: { drainTimeoutMs: 4000 },
    accounts: [{ name: 'api-test', type: 'apikey', apiKey: 'sk-ant-stub' }],
  }) + '\n');

  let out = '';
  const env = {
    ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_FORCE_SUPERVISOR: '1',
    MAXPOOL_TEST_FAIL_RELOAD_WORKER: '1',   // the new worker reports failure → supervisor rolls back
    MAXPOOL_TEST_RESTART_SIGNAL: '1',       // SIGUSR2 → the latching requestRestart (admission paused)
    MAXPOOL_RELOAD_SELFHEAL_MS: String(SELFHEAL_MS),
  };
  delete env.MAXPOOL_SERVER_WORKER;
  delete env.MAXPOOL_RELOAD_WORKER;
  const child = spawn(process.execPath, [cliPath, 'server'], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', d => { out += d; });
  child.stderr.on('data', d => { out += d; });
  try {
    assert.ok(await waitFor(async () => (await proxyGet(port, apiKey)).status === 200, 20_000), `precondition: pool came up:\n${out}`);
    const t0 = Date.now();
    process.kill(-child.pid, 'SIGUSR2');
    assert.ok(await waitFor(() => /rolling back/.test(out), 15_000), `precondition: the supervisor rolled back:\n${out}`);
    // Back to 200 well inside the self-heal: only MSG_ROLLED_BACK can explain it.
    const recovered = await waitFor(async () => (await proxyGet(port, apiKey, 1000)).status === 200, 8_000, 200);
    const tookMs = Date.now() - t0;
    assert.ok(recovered && tookMs < SELFHEAL_MS / 4, `the old worker kept refusing requests after the supervisor's rollback notice (${tookMs}ms):\n${out}`);
    // The notice's reason reaches the user's log, in words.
    assert.match(out, /Reload rolled back \(the new worker failed to start\)/);
    assert.doesNotMatch(out, /never took over|did not answer/, 'the supervisor DID answer');
    assert.equal(child.exitCode, null, 'supervisor still up');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
    await new Promise(r => { if (child.exitCode != null || child.signalCode != null) r(); else { child.once('exit', r); setTimeout(r, 3000).unref(); } });
    await new Promise(r => upstream.server.close(r));
  }
});
