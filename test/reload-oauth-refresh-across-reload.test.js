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
import { fork, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
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

// 25s, not 6s: these spawn REAL worker processes and the parallel suite starves
// them of CPU on a loaded machine — a local request that normally answers in
// milliseconds was timing out and failing a test with no logic defect.
function proxyGet(port, apiKey, timeoutMs = 25000) {
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
    req.setTimeout(15000, () => req.destroy(new Error('status timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitFor(predicate, timeoutMs = 20000, stepMs = 100, what = '', tail = () => '') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise(r => setTimeout(r, stepMs)); }
  // Include the child's captured output: this test's three waitFors all poll LOG TEXT
  // of a spawned supervisor, and a timing failure was indistinguishable from a real
  // bug ("never became true") with the only evidence discarded. Flaky twice in one
  // day (release gate 2026-11-08) at exactly this blindness.
  throw new Error(`waitFor never true${what ? ` (${what})` : ''} — child output tail:\n${String(tail()).slice(-1500)}`);
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
    await waitFor(() => /Maxpool Proxy|Listening on/.test(out), 20000, 100, 'server-ready', () => out);

    // Fire a request — its routing triggers ensureTokenFresh (token is expired),
    // which POSTs to the held stub. Don't await (it blocks on the held refresh).
    proxyGet(port, apiKey).catch(() => {});
    // Wait until the refresh POST is actually in flight (held) at the stub.
    await waitFor(() => stub.isHolding(), 20000, 100, 'refresh POST arrived at stub', () => out);

    // Reload NOW, mid-refresh. The baton must drain the in-flight refresh before
    // MSG_RELEASED so the new worker never re-rotates the same single-use token.
    child.kill('SIGHUP');
    // Give the baton a moment to start releasing, then let the held refresh finish.
    await new Promise(r => setTimeout(r, 600));
    stub.releaseHeld();

    await waitFor(() => /cutover complete/.test(out), 20000, 100, 'reload cutover', () => out);
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
    await new Promise(r => { if (child.exitCode != null || child.signalCode != null) { r(); } else { child.once('exit', r); const t = setTimeout(r, 3000); t.unref && t.unref(); } });
    await new Promise(r => stub.server.close(r));
  }
});

test('a native refresh can finish beyond a legacy supervisor release deadline without cutting over early', async () => {
  const stub = await startOAuthStub();
  const port = await getFreePort();
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-native-refresh-'));
  const configPath = join(dir, 'config.json');
  const preload = join(dir, 'fixture.mjs');
  // Exercise the actual native token exchange and manager persistence. Every
  // non-loopback origin in this subprocess is intercepted or refused.
  await writeFile(preload, `
    const original = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      const target = new URL(url);
      if (target.href === 'https://auth.openai.com/oauth/token')
        return original('http://127.0.0.1:${stub.port}/v1/oauth/token', opts);
      if (target.hostname === '127.0.0.1') return original(url, opts);
      return new Response('offline', {status: 503});
    };
  `);
  await writeFile(configPath, JSON.stringify({
    proxy: { host: '127.0.0.1', port, apiKey: 'fixture-owner' }, updateCheck: false, preventSleep: false,
    accounts: [{ name: 'native', provider: 'codex', codexAuth: 'native', type: 'oauth',
      accountUuid: 'test-user', organizationUuid: 'test-work', codexAccountId: 'test-work',
      accessToken: 'at0', refreshToken: 'r0', expiresAt: Date.now() - 60_000 }],
  }));
  const child = spawn(process.execPath, [cliPath, 'server'], {
    env: { ...process.env, NODE_OPTIONS: '--import=' + preload, MAXPOOL_CONFIG: configPath,
      MAXPOOL_FORCE_SUPERVISOR: '1', MAXPOOL_DISABLE_SLEEP_GUARD: '1', MAXPOOL_DISABLE_QUOTA_PROBE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  try {
    await waitFor(() => /Maxpool Proxy|Listening on/.test(out), 20000, 75, 'native pool ready', () => out);
    const request = fetch('http://127.0.0.1:' + port + '/maxpool/codex/v1/models', {
      headers: { authorization: 'Bearer fixture-owner' },
    }).then(res => res.status).catch(() => 0);
    await waitFor(stub.isHolding, 12000, 50, 'native refresh started', () => out);
    child.kill('SIGHUP');
    await new Promise(r => setTimeout(r, 21_000));
    assert.doesNotMatch(out, /cutover complete|falling back/);
    assert.equal((await status(port, 'fixture-owner')).accounts.length, 1);
    stub.releaseHeld();
    assert.equal(await request, 503, 'the original catalog request stayed connected to its worker');
    await waitFor(() => out.includes('cutover complete'), 15_000, 60, 'native cutover', () => out);
    assert.equal(stub.rotations(), 1);
    assert.doesNotMatch(out, /falling back|invalid_grant/);
  } finally {
    stub.releaseHeld();
    killGroup(child);
    await new Promise(r => stub.server.close(r));
  }
});

test('an encrypted continuation arriving through the supervisor waits for the final owner snapshot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-forwarded-native-'));
  const configPath = join(dir, 'config.json');
  const listener = net.createServer({ pauseOnConnect: true });
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  const acct = { name: 'offline', enabled: false, type: 'oauth', provider: 'codex', codexAuth: 'native',
    accessToken: 'fake', accountUuid: 'user', codexAccountId: 'workspace', organizationUuid: 'workspace' };
  await writeFile(configPath, JSON.stringify({ proxy: { host: '127.0.0.1', port, apiKey: 'fixture-owner' },
    accounts: [acct], updateCheck: false, preventSleep: false }));
  const child = fork(cliPath, ['server'], {
    env: { ...process.env, MAXPOOL_CONFIG: configPath, MAXPOOL_SERVER_WORKER: '1', MAXPOOL_RELOAD_WORKER: '1',
      MAXPOOL_DISABLE_QUOTA_PROBE: '1', MAXPOOL_DISABLE_SLEEP_GUARD: '1' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], detached: true,
  });
  try {
    let ready = false;
    child.on('message', msg => { if (msg.type === 'ready') ready = true; });
    await waitFor(() => { if (!ready) child.send({ type: 'probe-ready' }); return ready; }, 10_000, 50);
    const forwarded = new Promise((resolve, reject) => listener.once('connection', socket =>
      child.send({ type: 'conn' }, socket, err => err ? reject(err) : resolve())));
    const followup = fetch('http://127.0.0.1:' + port + '/maxpool/codex/v1/responses', {
      method: 'POST', headers: { authorization: 'Bearer fixture-owner', 'content-type': 'application/json', 'thread-id': 'thread-x' },
      body: JSON.stringify({ model: 'fixture-model', previous_response_id: 'private-state', stream: true }),
      signal: AbortSignal.timeout(10_000),
    });
    await forwarded;
    const sha = str => createHash('sha256').update(str).digest('hex');
    await writeFile(join(dir, 'config.state.json'), JSON.stringify({
      nativeCodexConversationOwners: [['codex-wire:' + sha('thread-x'), sha(JSON.stringify(['user', 'workspace']))]],
    }));
    child.send({ type: 'takeover' }, listener);
    const reply = await followup;
    assert.equal(reply.status, 429, 'restored disabled owner is unavailable; an ownerless continuation would get 409');
    await reply.text();
  } finally {
    killGroup(child);
    await new Promise(r => listener.close(r));
  }
});

test('a Claude Code first turn on Codex after replacement boot stays on Codex through takeover', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-claude-provider-handoff-'));
  const configPath = join(dir, 'config.json');
  async function listen(server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => { server.close(); server.closeAllConnections?.(); });
    return server.address().port;
  }
  const hits = [];
  const upstream = await listen(http.createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    hits.push(req.url);
    if (req.url === '/v1/responses') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id: 'resp_fixture', model: 'gpt-6.2-sol' } },
        { type: 'response.output_text.delta', item_id: 'item', delta: 'codex fixture' },
        { type: 'response.completed', response: { usage: { input_tokens: 5, output_tokens: 2 } } },
      ]) res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ content: [{ type: 'text', text: 'claude fixture' }] }));
  }));
  const listener = net.createServer({ pauseOnConnect: true });
  const port = await listen(listener);
  const host = 'http://127.0.0.1:' + upstream;
  await writeFile(configPath, JSON.stringify({ proxy: { host: '127.0.0.1', port, apiKey: 'fixture' },
    updateCheck: false, preventSleep: false, queue: { enabled: false },
    accounts: [
      { name: 'Claude', type: 'apikey', apiKey: 'fake', upstream: host },
      { name: 'Codex', type: 'oauth', provider: 'codex', codexAuth: 'native', accountUuid: 'user',
        codexAccountId: 'workspace', accessToken: 'fake', expiresAt: Date.now() + 3_600_000,
        upstream: host + '/v1/responses', codexModels: [{ slug: 'gpt-6.2-sol', efforts: ['high'] }] },
    ] }));
  async function worker(reload) {
    const child = fork(cliPath, ['server'], { env: { ...process.env, MAXPOOL_CONFIG: configPath,
      MAXPOOL_SERVER_WORKER: '1', MAXPOOL_RELOAD_WORKER: reload ? '1' : '',
      MAXPOOL_DISABLE_QUOTA_PROBE: '1', MAXPOOL_DISABLE_SLEEP_GUARD: '1' },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], detached: true });
    t.after(() => killGroup(child));
    const messages = new Set();
    let errors = '';
    child.stderr.on('data', data => { errors += data; });
    child.on('message', msg => messages.add(msg.type));
    const wait = type => waitFor(() => messages.has(type), 15000, 25, type, () => errors);
    await waitFor(() => {
      if (messages.has('ready')) return true;
      child.send({ type: 'probe-ready' });
    }, 15000, 50, 'worker boot', () => errors);
    return { child, wait };
  }
  const old = await worker(false);
  let acceptor = old.child;
  listener.on('connection', socket => acceptor.send({ type: 'conn' }, socket));
  old.child.send({ type: 'listen' }, listener);
  await old.wait('primary');
  const next = await worker(true);
  function turn(at, provider, thread = 'handoff-thread') {
    return fetch('http://127.0.0.1:' + at + '/v1/messages', { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'fixture', connection: 'close',
        'x-maxpool-profile': 'all', 'x-maxpool-provider': provider },
      body: JSON.stringify({ model: 'claude-sonnet-5', stream: true, metadata: { user_id: JSON.stringify({ session_id: thread }) },
        messages: [{ role: 'user', content: 'hello' }] }), signal: AbortSignal.timeout(15000) });
  }
  assert.match(await (await turn(port, 'codex')).text(), /codex fixture/);
  old.child.send({ type: 'release' });
  await old.wait('released');
  acceptor = next.child;

  // A separate supervisor-accepted socket guarantees this request is delivered
  // via MSG_CONN before TAKEOVER, even if the OS would otherwise pick a worker.
  const earlyListener = net.createServer({ pauseOnConnect: true });
  const earlyPort = await listen(earlyListener);
  const forwarded = new Promise((resolve, reject) => earlyListener.once('connection', socket =>
    next.child.send({ type: 'conn' }, socket, err => err ? reject(err) : resolve())));
  const early = turn(earlyPort, 'claude');
  await forwarded;
  next.child.send({ type: 'takeover' }, listener);
  assert.match(await (await early).text(), /codex fixture/);
  await next.wait('primary');
  assert.match(await (await turn(port, 'claude')).text(), /codex fixture/);
  assert.match(await (await turn(port, 'claude', 'fresh-thread')).text(), /claude fixture/);
  assert.deepEqual(hits, ['/v1/responses', '/v1/responses', '/v1/responses', '/v1/messages']);
});
