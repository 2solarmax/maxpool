// BLOCKER 1 regression (in-flight refresh across the baton).
//
// A real oauth-type account boots EXPIRED so the worker triggers a token
// refresh. The stub OAuth token endpoint rotates SINGLE-USE tokens (presenting a
// previously-rotated token → invalid_grant) and HOLDS the first refresh response
// open. While that refresh POST is in flight, we fire a real SIGHUP reload. The
// single-writer baton must AWAIT the in-flight refresh before MSG_RELEASED, so
// the new worker never rotates the SAME single-use token →
//   - the upstream sees EXACTLY ONE rotation
//   - the account never lands in invalid_grant / 'error'
//
// Goes through the REAL worker boot path (not a static lease toggle).

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

// Combined stub: /v1/oauth/token (single-use rotating, first refresh held open),
// /api/oauth/profile (so account resolution succeeds), and /v1/messages (proxy
// upstream). Exposes rotation count + a release() for the held refresh.
function startOAuthStub() {
  let currentRefresh = 'r0';
  let rotations = 0;
  const invalidated = new Set();
  let heldResolve = null;
  let holdFirst = true;

  const server = http.createServer(async (req, res) => {
    if (req.url === '/v1/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      let parsed = {};
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      const presented = parsed.refresh_token;

      // Optionally hold the FIRST refresh open so a reload can race it.
      if (holdFirst) {
        holdFirst = false;
        await new Promise(resolve => { heldResolve = resolve; });
      }

      if (presented !== currentRefresh || invalidated.has(presented)) {
        // Single-use violation — the exact brick path.
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'token already used' }));
        return;
      }
      invalidated.add(currentRefresh);
      rotations++;
      currentRefresh = `r${rotations}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        access_token: `at${rotations}`,
        refresh_token: currentRefresh,
        expires_in: 3600,
      }));
      return;
    }
    if (req.url === '/api/oauth/profile') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ account: { uuid: 'u-test', email_address: 'oauth@test' }, organization: {} }));
      return;
    }
    // proxy upstream (/v1/messages etc.)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    port: server.address().port,
    rotations: () => rotations,
    releaseHeld: () => { if (heldResolve) { heldResolve(); heldResolve = null; } },
    isHolding: () => heldResolve != null,
  })));
}

function readBody(req) {
  return new Promise(resolve => { let b = ''; req.on('data', c => b += c); req.on('end', () => resolve(b)); });
}

function proxyGet(port, apiKey, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST',
      headers: { 'content-type': 'application/json' } }, res => {
      let b = ''; res.setEncoding('utf8'); res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
}

// Query proxy status to read account state (active vs error).
function status(port, apiKey) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/maxpool/status', method: 'GET',
      headers: { 'x-api-key': apiKey } }, res => {
      let b = ''; res.on('data', c => b += c); res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.setTimeout(4000, () => req.destroy(new Error('status timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise(r => setTimeout(r, stepMs)); }
  throw new Error('waitFor predicate never became true');
}

function killGroup(child) {
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  try { child.kill('SIGKILL'); } catch { /* gone */ }
}

test('in-flight OAuth refresh across a reload rotates the single-use token EXACTLY once (no brick)', async () => {
  const stub = await startOAuthStub();
  const port = await getFreePort();
  const apiKey = 'mp-test-key';
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-oauth-'));
  const configPath = join(dir, 'config.json');
  // OAuth account boots ALREADY EXPIRED → the worker refreshes on first use.
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey },
    upstream: `http://127.0.0.1:${stub.port}`,
    updateCheck: false, switchThreshold: 0.90, shutdown: { drainTimeoutMs: 15000 },
    accounts: [{
      name: 'oauth@test', type: 'oauth', accountUuid: 'u-test',
      accessToken: 'at0', refreshToken: 'r0', expiresAt: Date.now() - 60_000,
    }],
  }) + '\n');

  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: {
      ...process.env,
      MAXPOOL_CONFIG: configPath,
      MAXPOOL_FORCE_SUPERVISOR: '1',
      MAXPOOL_OAUTH_TOKEN_ENDPOINT: `http://127.0.0.1:${stub.port}/v1/oauth/token`,
    },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = ''; child.stdout.on('data', d => out += d); child.stderr.on('data', d => out += d);

  try {
    await waitFor(() => /Maxpool Proxy|Listening on/.test(out), 20000);

    // Fire a request — its routing triggers ensureTokenFresh (token is expired),
    // which POSTs to the held stub. Don't await (it blocks on the held refresh).
    proxyGet(port, apiKey).catch(() => {});
    // Wait until the refresh POST is actually in flight (held) at the stub.
    await waitFor(() => stub.isHolding(), 20000);

    // Reload NOW, mid-refresh. The baton must drain the in-flight refresh before
    // MSG_RELEASED so the new worker never re-rotates the same single-use token.
    child.kill('SIGHUP');
    // Give the baton a moment to start releasing, then let the held refresh finish.
    await new Promise(r => setTimeout(r, 600));
    stub.releaseHeld();

    await waitFor(() => /cutover complete/.test(out), 20000);
    // Settle: let any (forbidden) second rotation attempt happen if the bug exists.
    await new Promise(r => setTimeout(r, 800));

    assert.equal(stub.rotations(), 1, `single-use token rotated EXACTLY once (saw ${stub.rotations()})`);

    // The account must not be bricked. Drive a request so status reflects state,
    // then assert it is not in 'error'/auth-failed.
    await proxyGet(port, apiKey).catch(() => {});
    const st = await status(port, apiKey);
    const acct = st.accounts.find(a => a.name === 'oauth@test');
    assert.ok(acct, 'account present in status');
    assert.notEqual(acct.status, 'error', `account not bricked (status=${acct.status})`);
  } finally {
    stub.releaseHeld();
    killGroup(child);
    await new Promise(r => child.once('exit', r));
    await new Promise(r => stub.server.close(r));
  }
});
