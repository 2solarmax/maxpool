// Regression: the INTERACTIVE cold restart (TUI `r` key) must bring the server
// back. The bug (v1.5.12 and earlier): after the first worker goes primary, the
// supervisor runs closeMasterAccept() → masterServer.close(). Every exit-75
// cold-respawn then handed that NO-LONGER-LISTENING server to the new worker,
// which ignores a falsy handle (`msg.type===MSG_LISTEN && handle`) → never
// listens, never becomes primary, never renders the TUI. The user saw a blank
// hang after "Restarting server now" / "Idle" and had to close the terminal.
//
// The existing reload-restart-integration test can't catch this: a supervised
// worker now always resolves reloadStrategy → 'seamless' (TUI and headless alike).
// MAXPOOL_TEST_FORCE_COLD_RESTART forces the cold path so the exit-75 respawn is
// exercised without a real pty.
//
// This asserts the SECOND boot banner appears AND the port serves a request
// again after the cold restart — with the bug, the respawned worker never binds
// and the request hangs → timeout (RED).

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

// Upstream that responds 200 immediately, so a proxied request completes fast and
// proves the worker is actually listening + primary.
function startRespondingUpstream() {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

async function waitFor(pred, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error('waitFor predicate never became true');
}

const countBoots = out => (out.match(/Maxpool Proxy/g) || []).length;

// Fire a request through the proxy; resolve the status code, or reject on timeout.
function proxyRequest(port, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', timeout: timeoutMs,
        headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } },
      res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('timeout', () => { req.destroy(new Error('request timed out')); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
}

test('interactive cold restart brings the server back (exit-75 respawn re-listens the socket)', async () => {
  const port = await getFreePort();
  const { server: upstream, port: upstreamPort } = await startRespondingUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-cold-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    updateCheck: false,
    restartDrainTimeoutMs: 800,
    accounts: [{
      name: 'a1', type: 'oauth', accountUuid: 'u1',
      accessToken: 'at1', refreshToken: 'rt1', expiresAt: Date.now() + 3600_000,
    }],
  }) + '\n');

  let out = '';
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: {
      ...process.env,
      MAXPOOL_CONFIG: configPath,
      MAXPOOL_FORCE_SUPERVISOR: '1',
      MAXPOOL_TEST_RESTART_SIGNAL: '1',
      MAXPOOL_TEST_FORCE_COLD_RESTART: '1', // exercise the interactive cold-restart path
      MAXPOOL_DISABLE_SLEEP_GUARD: '1',
      MAXPOOL_DISABLE_QUOTA_PROBE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);

  try {
    await waitFor(() => /Maxpool Proxy/.test(out), 20000);
    const firstBoots = countBoots(out);

    // The worker is primary once a proxied request succeeds (→ closeMasterAccept
    // has fired on the supervisor, arming the stale-handle bug for the next spawn).
    await waitFor(async () => { try { return (await proxyRequest(port)) === 200; } catch { return false; } }, 15000);

    // Two consecutive cold restarts — the real "keeps hanging every time" report.
    // Each must bring the server fully back (fresh boot banner + a served request).
    let bootsBefore = firstBoots;
    for (let cycle = 1; cycle <= 2; cycle++) {
      // Fire the REAL interactive restart (TUI `r`) via a group SIGUSR2.
      process.kill(-child.pid, 'SIGUSR2');

      // Cold path confirmed, then the server MUST come back (a new boot banner)...
      await waitFor(() => countBoots(out) > bootsBefore, 20000);

      // ...and actually SERVE again — the respawned worker bound the port.
      const served = await waitFor(async () => {
        try { return (await proxyRequest(port)) === 200; } catch { return false; }
      }, 15000);
      assert.ok(served, `cold restart #${cycle}: the respawned worker serves requests again`);
      bootsBefore = countBoots(out);
    }
    assert.match(out, /Restarting server now/, 'the interactive cold-restart path ran');
    assert.ok(bootsBefore >= firstBoots + 2, 'two fresh workers booted across two cold restarts');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    upstream.close();
  }
});
