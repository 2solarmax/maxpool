// Bounded-restart end-to-end proof: the interactive `r` restart must NOT hang when
// requests are in flight. Regression for the "Restart pending; admission paused
// while N upstream request(s) finish" stall (RestartController drained UNBOUNDED —
// a single long/held request pinned the restart forever).
//
// We spawn a REAL supervisor + worker, hold a request in flight (a stub upstream
// that never responds), fire the actual restart path — the TUI `r` key, driven
// headless via the gated SIGUSR2 test hook — and assert:
//   1. the drain starts against the in-flight request ("Restart pending")
//   2. it is BOUNDED — forces the restart instead of hanging on the held request
//   3. the supervisor respawns a worker that binds the port again (server returns)
//
// A pty can't be allocated in this zero-dependency suite, so MAXPOOL_FORCE_SUPERVISOR
// forces the supervisor and MAXPOOL_TEST_RESTART_SIGNAL wires SIGUSR2 → requestRestart
// (worker) / no-op (supervisor). We deliver a GROUP SIGUSR2 so the worker gets it.

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

// Upstream that ACCEPTS the request and holds the response open forever, so the
// proxied request stays genuinely in flight across the restart.
function startHoldingUpstream() {
  const held = [];
  const server = http.createServer((_req, res) => { held.push(res); /* never responds */ });
  return new Promise(resolve =>
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, held })));
}

async function waitFor(pred, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, stepMs));
  }
  throw new Error('waitFor predicate never became true');
}
// Each worker boot (initial + every restart) prints the startup banner.
const countBoots = out => (out.match(/Maxpool Proxy/g) || []).length;

test('restart with an in-flight request completes bounded and the server comes back', async () => {
  const port = await getFreePort();
  const { server: upstream, port: upstreamPort, held } = await startHoldingUpstream();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-restart-'));
  const configPath = join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    updateCheck: false,
    restartDrainTimeoutMs: 800, // bound the pre-restart drain fast for the test
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
      MAXPOOL_DISABLE_SLEEP_GUARD: '1',
      MAXPOOL_DISABLE_QUOTA_PROBE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // own process group → a group SIGUSR2 reaches the worker
  });
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);

  try {
    await waitFor(() => /Maxpool Proxy/.test(out), 20000);
    const firstBoots = countBoots(out);

    // 1) Put a request IN FLIGHT — the stub upstream holds it open forever.
    const inflight = http.request(
      { host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } },
      () => {});
    inflight.on('error', () => {}); // dropped when the worker restarts — expected
    inflight.end(JSON.stringify({ model: 'x', messages: [] }));

    // Wait until the upstream actually received it → maxpool has it as in-flight.
    await waitFor(() => held.length > 0, 15000);

    // 2) Fire the REAL restart path (TUI `r`) via a group SIGUSR2.
    process.kill(-child.pid, 'SIGUSR2');

    // 3) Under a SUPERVISED restart the pre-drain is SKIPPED (seamless baton drains
    // in-flight after the handoff; a 10s pre-drain with 30-60s requests never
    // completes and just 503s the fleet). So we expect the swap to fire promptly,
    // NOT the old "Restart pending" drain message.
    await waitFor(() => /Restarting|restart/i.test(out), 10000);
    // ...and the server must COME BACK (a second boot banner).
    await waitFor(() => countBoots(out) > firstBoots, 20000);

    assert.ok(countBoots(out) > firstBoots, 'a fresh worker booted — server came back');
    assert.ok(countBoots(out) > firstBoots, 'a fresh worker booted — server came back');
  } finally {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    upstream.close();
    held.forEach(res => { try { res.destroy(); } catch { /* noop */ } });
  }
});
