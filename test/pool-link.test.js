import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  PoolLink, fetchRemoteStatus, remoteIdentities,
  nextHopCount, HOP_HEADER, credentialFp,
} from '../src/pool-link.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { return new Promise(r => server.close(r)); }

// A REMOTE pool stub: key-gated /maxpool/status with one Claude oauth row (uuid U1)
// and one GLM provider row (fingerprint FP), plus /v1/messages that answers 200
// only with the right key and records the hop header.
function remotePoolStub() {
  const seen = [];
  const keyFp = credentialFp('glm-shared-key');
  const server = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      if (req.headers['x-api-key'] !== 'mp-max') { res.writeHead(401); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        accounts: [
          { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
          { name: 'glm max@gomokka.com', type: 'provider', provider: 'zai', keyFingerprint: keyFp, enabled: true, status: 'active', quota: { providerSes: 0.1, providerWk: 0.2 } },
        ],
        callers: { max: { requests: 3 } },
      }));
      return;
    }
    if (req.url === '/v1/messages') {
      seen.push({ hop: req.headers[HOP_HEADER] || null, key: req.headers['x-api-key'] || null });
      if (req.headers['x-api-key'] !== 'mp-max') { res.writeHead(401); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'remote-pool' }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, seen, keyFp };
}

const msgBody = JSON.stringify({ model: 'test', messages: [] });

function okUpstream() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}

test('pool link: identities + duplicate benching (uuid + provider key)', async () => {
  const { server } = remotePoolStub();
  const port = await listen(server);
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'mp-max' }, {
      fetchRemoteStatus: (url, key) => fetchRemoteStatus(url, key, { timeoutMs: 2000 }),
    });
    // Retry the first poll: under full-suite load a 2s HTTP timeout to the local
    // stub can expire once (release run 2026-11-06: failed only under load, green in
    // isolation). The assertion's subject is identity/benching, not poll timing.
    for (let i = 0; i < 3 && !link.lastOkAt; i++) await link.poll();
    assert.ok(link.lastOkAt, 'link poll ok');
    assert.equal(link.summary.usable, 2);

    // Local pool with a DUPLICATE of remote U1 + duplicate GLM key + one unique account.
    const am = new AccountManager([
      { name: 'reports-local', type: 'oauth', accountUuid: 'U1', accessToken: 'x', refreshToken: 'r1' },
      { name: 'unique-local', type: 'oauth', accountUuid: 'U2', accessToken: 'x', refreshToken: 'r2' },
    ], 0.9);
    // GLM keys load the way production loads them: config `providers` → provider rows.
    am.loadConfigProviders([{ name: 'glm-local', provider: 'zai', token: 'glm-shared-key' }]);
    am.setPoolLinks([link]);
    // Both duplicates benched, unique untouched.
    const glm = am.accounts.find(a => a.name === 'glm-local');
    const uniq = am.accounts.find(a => a.name === 'unique-local');
    assert.equal(am.accounts[0].poolBenchedBy, 'reports@gomokka.com');
    assert.equal(glm.poolBenchedBy, 'glm max@gomokka.com', 'provider key duplicate benched');
    assert.equal(uniq.poolBenchedBy, null);
    // Benched accounts never match a request.
    assert.equal(am._matchesRequest(am.accounts[0], 'all', {}), false);
    assert.equal(am._matchesRequest(glm, 'all', {}), false);
    assert.equal(am._matchesRequest(uniq, 'all', {}), true);
    // Benched oauth account never refreshes its token.
    assert.equal(await am.ensureTokenFresh(0), true); // no-op path, must not call refresh
    // Release when remote stops listing the duplicate.
    link.identities.delete('uuid:U1');
    am.applyPoolLinks();
    assert.equal(am.accounts[0].poolBenchedBy, null);
    am.setPoolLinks([]);
  } finally { await close(server); }
});

test('mirror row: forwards with key + hop header, lease accounted, browser noise never routed', async () => {
  const { server, seen } = remotePoolStub();
  const remotePort = await listen(server);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); }); // must NOT be used
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  let proxy = null;
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
    await link.poll();
    am.setPoolLinks([link]);          // mirrors are created by the poll itself
    const row = am.accounts.find(x => x.remote);
    assert.ok(row, 'mirror row exists');
    assert.ok(am._matchesRequest(row, 'all', { path: '/v1/messages' }), 'mirror routable for API traffic');
    assert.equal(am._matchesRequest(row, 'all', { path: '/favicon.ico' }), false, 'browser noise never forwarded');

    proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: msgBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.via, 'remote-pool');
    const rec = await new Promise(r => {
      const check = () => seen.length ? r(seen.at(-1)) : setTimeout(check, 25);
      check();
    });
    assert.equal(rec.key, 'mp-max', 'person key forwarded');
    assert.equal(rec.hop, '1', 'hop header added');
    await new Promise(r => {
      const t = setTimeout(r, 1500);
      res.body.cancel().catch(() => {}).finally(() => { clearTimeout(t); r(); });
    });
    await new Promise(r => setImmediate(r));
    assert.equal(row.inFlight, 0, 'lease released exactly once');
    assert.equal(row.failedRequests, 0, 'no failure counted');
  } finally { am.setPoolLinks([]); if (proxy) await close(proxy); await close(server); await close(upstream); }
});

test('pool link: loop guard refuses beyond MAX_HOPS both inbound and outbound', async () => {
  // Inbound: a request already carrying hop >= MAX is refused 508 by the receiving pool.
  const am = new AccountManager([], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1' });
  const port = await listen(proxy);
  try {
    // Bounded: without the guard the request would queue for a route — fail fast, never hang.
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', [HOP_HEADER]: '2' }, body: msgBody,
      signal: AbortSignal.timeout(3000),
    }).catch(e => ({ status: `aborted:${e.name}` }));
    assert.equal(res.status, 508);
  } finally { await close(proxy); }
  // Outbound: nextHopCount refuses at the cap.
  assert.equal(nextHopCount(undefined), 1);
  assert.equal(nextHopCount('1'), 2);
  assert.equal(nextHopCount('2'), null);
});

test('link down: requests fall to local accounts, mirrors leave routing', async () => {
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, via: 'local' })); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'local-1', type: 'apikey', apiKey: 'k1' }], 0.9);
  let proxy = null;
  try {
    const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1', key: 'mp-max' });
    link.lastError = 'network error'; link.lastOkAt = null;
    am.setPoolLinks([link]);
    am.syncRemoteMirrors(link);
    assert.equal(am.accounts.filter(a => a.remote && a.enabled !== false).length, 0, 'no live mirror from a down link');
    proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: msgBody,
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).via, 'local', 'served locally, not by the dead link');
  } finally { am.setPoolLinks([]); if (proxy) await close(proxy); await close(upstream); }
});

test('pool link: status JSON exposes pools block + keyFingerprint, no secrets', async () => {
  const { server, keyFp } = remotePoolStub();
  const port = await listen(server);
  try {
    const am = new AccountManager([], 0.9);
    am.loadConfigProviders([{ name: 'glm-local', provider: 'zai', token: 'glm-shared-key' }]);
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'mp-max' });
    await link.poll();
    am.setPoolLinks([link]);
    const st = am.getStatus();
    assert.ok(Array.isArray(st.pools) && st.pools.length === 1);
    assert.equal(st.pools[0].name, 'team');
    assert.equal(st.pools[0].accounts.length, 2);
    assert.equal(st.accounts.find(a => a.name === 'glm-local').keyFingerprint, keyFp);
    const raw = JSON.stringify(st);
    assert.ok(!raw.includes('mp-max'), 'person key never in status');
    assert.ok(!raw.includes('glm-shared-key'), 'provider key never in status');
    am.setPoolLinks([]);
  } finally { await close(server); }
});

test('duplicate guard: a benched local Claude copy NEVER spends its refresh token', async () => {
  let refreshCalls = 0;
  const am = new AccountManager([
    // Token already expired → an un-benched account WOULD refresh here.
    { name: 'reports-local', type: 'oauth', accountUuid: 'U1', accessToken: 'x', refreshToken: 'r1', expiresAt: Date.now() - 60_000 },
  ], 0.9, {}, { refreshAccessToken: async () => { refreshCalls++; return { accessToken: 'n', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }; } });
  // Positive control: not benched → refresh happens.
  await am.ensureTokenFresh(0);
  assert.equal(refreshCalls, 1, 'control: an expired un-benched token refreshes');
  am.accounts[0].expiresAt = Date.now() - 60_000;
  // Bench it via a link identity, then try again.
  const fakeLink = { identities: new Map([['uuid:U1', { name: 'reports@gomokka.com' }]]), start() {}, stop() {} };
  am.setPoolLinks([fakeLink]);
  assert.ok(am.accounts[0].poolBenchedBy);
  await am.ensureTokenFresh(0);
  assert.equal(refreshCalls, 1, 'benched copy must not refresh');
  am.setPoolLinks([]);
});

test('duplicate guard end-to-end: the REMOTE status (real getStatus shape) carries the Claude identity', async () => {
  // The remote side is a REAL AccountManager — not a hand-built stub — so the test
  // fails if getStatus ever stops exporting the identity a link matches on.
  const remoteAm = new AccountManager([
    { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U-REAL', accessToken: 'x', refreshToken: 'r' },
  ], 0.9);
  remoteAm.loadConfigProviders([{ name: 'glm shared', provider: 'zai', token: 'glm-key-real' }]);
  const status = JSON.parse(JSON.stringify(remoteAm.getStatus())); // wire round-trip
  const fakeLink = { identities: remoteIdentities(status), start() {}, stop() {} };
  const am = new AccountManager([
    { name: 'reports-local', type: 'oauth', accountUuid: 'U-REAL', accessToken: 'x', refreshToken: 'r2' },
  ], 0.9);
  am.loadConfigProviders([{ name: 'glm local', provider: 'zai', token: 'glm-key-real' }]);
  am.setPoolLinks([fakeLink]);
  assert.equal(am.accounts.find(a => a.name === 'reports-local').poolBenchedBy, 'reports@gomokka.com', 'Claude duplicate benched via real status');
  assert.equal(am.accounts.find(a => a.name === 'glm local').poolBenchedBy, 'glm shared', 'GLM duplicate benched via real status');
  am.setPoolLinks([]);
});


test('terminal People line: merges local + cloud callers, hides legacy key, empty when nobody named', async () => {
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const { TUI } = await import('../src/tui.js');
  const am = new AccountManager([], 0.9);
  am.callerCounts.set('max', 12);
  am.callerCounts.set('legacy-key', 3);
  am.poolLinks = [{ status: { callers: { ahmed: { requests: 40 }, max: { requests: 30 } } } }];
  const t = new TUI({ accountManager: am });
  assert.equal(strip(t._peopleLine(80)), ' People   ahmed 40 · max 30');
  am.poolLinks = []; am.callerCounts.clear();
  assert.equal(t._peopleLine(80), '');
});

test('link forward NEVER carries client provider tokens to the remote pool (live 2026-10-29: cc-all headers created remote accounts)', async () => {
  const { server } = remotePoolStub();
  const port = await listen(server);
  const seen = [];
  server.on('request', req => { if (req.url === '/v1/messages') seen.push(Object.keys(req.headers).filter(h => h.startsWith('x-maxpool-'))); });
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end(); });
  const upPort = await listen(upstream);
  try {
    const am = new AccountManager([], 0.9);
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'mp-max' });
    await link.poll();
    am.setPoolLinks([link]);
    const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-profile': 'all',
        'x-maxpool-zai-token': 'glm-secret-key', 'x-maxpool-kimi-token': 'kimi-secret-key', 'x-maxpool-zai-base-url': 'https://x' },
      body: msgBody,
    });
    await new Promise(r => setImmediate(r));
    // Non-vacuous: the forward must actually REACH the remote, else "no leaked
    // headers" passes on an empty list (it did, briefly, after the aggregate row
    // was removed and nothing routed).
    assert.equal(seen.length, 1, 'the request reached the remote pool');
    const forwarded = seen[0];
    assert.ok(!forwarded.some(h => /zai|kimi/.test(h)), `provider headers leaked: ${forwarded.join(',')}`);
    am.setPoolLinks([]);
    await close(proxy);
  } finally { await close(server); await close(upstream); }
});

test('mirror scoring: another teammate\'s live load makes the mirror score worse', () => {
  const am = new AccountManager([{ name: 't1', type: 'apikey', apiKey: 'k1' }], 0.9);
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [{ name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {} }] };
  link.identities = new Map();
  am.setPoolLinks([link]); am.syncRemoteMirrors(link);
  const row = am.accounts.find(a => a.remote);
  const s1 = am._scoreAccount(row, {});
  row._remoteOtherLoad = 12;            // the cloud reports 12 other in-flight
  const s2 = am._scoreAccount(row, {});
  assert.ok(s2 > s1, `loaded mirror must score worse: ${s2} > ${s1}`);
  am.setPoolLinks([]);
});

test('per-account cloud rows: every remote account mirrored individually, no credential, removed when gone', async () => {
  // Owner's live routing mode (balance) — the default 'sticky' keeps GLM off unless
  // claudeFallback allows it, which is the UNCHANGED rule, applied to cloud rows too.
  const am = new AccountManager([{ name: 'kira', type: 'oauth', accountUuid: 'K', accessToken: 'x', refreshToken: 'r' }], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1', key: 'mp-max' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [
    { name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 2, quota: { providerSes: 0.2, providerWk: 0.3 } },
    { name: 'reports', type: 'oauth', accountUuid: 'R', enabled: true, status: 'active', inFlight: 0, quota: { unified5h: 0.1, unified7d: 0.4 } },
    { name: 'off one', type: 'provider', provider: 'zai', enabled: false },
  ] };
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const cloud = am.accounts.filter(a => a.remote);
  assert.deepEqual(cloud.map(a => a.remote.remoteName).sort(), ['glm a', 'reports'], 'each enabled cloud account is its own row');
  assert.ok(cloud.every(a => a.credential == null && a.refreshToken == null), 'mirror rows hold no credential');
  assert.equal(cloud.find(a => a.remote.remoteName === 'glm a')._remoteOtherLoad, 2, 'teammates\' live load is visible to the balancer');
  assert.ok(am._matchesRequest(cloud[0], 'all', { path: '/v1/messages' }), 'cloud rows are routable');
  // Cloud drops an account → P5: its row is DISABLED in place, never removed.
  link.status.accounts = link.status.accounts.filter(a => a.name !== 'glm a');
  am.applyPoolLinks();
  assert.equal(am.accounts.filter(a => a.remote).length, 2, 'rows stable (no reindex)');
  assert.equal(am.accounts.find(a => a.remote?.remoteName === 'glm a').enabled, false, 'out of routing');
  // Link down → same: disabled, not removed.
  link.lastError = 'network error';
  am.applyPoolLinks();
  assert.equal(am.accounts.filter(a => a.remote).length, 2);
  assert.equal(am.accounts.filter(a => a.remote && a.enabled).length, 0, 'all out of routing');
  am.setPoolLinks([]);
});

test('request-shape refusal from the linked pool passes through: 429 + marker, mirror row NOT cooled', async () => {
  // Chain: local proxy -> linked remote proxy -> Anthropic stub that refuses a
  // non-Claude-Code Opus request (the 2026-11-08 shape refusal). The local side must
  // hand the client the remote's answer and leave the mirror row available — cooling
  // it would bench a healthy cloud account for real sessions.
  const bare = JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'Error' } });
  const upstream = http.createServer((req, res) => { let b=''; req.on('data', c=>b+=c); req.on('end', () => {
    const body = JSON.parse(b);
    const cc = Array.isArray(body.system) && body.system.some(x => String(x?.text||'').startsWith('You are Claude Code'));
    if (!/haiku/.test(body.model) && !cc) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(bare); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  const upPort = await listen(upstream);
  // A CLAUDE-type remote row so the remote's own shape check runs (provider rows skip it).
  const remoteAm = new AccountManager([{ name: 'reports', type: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: Date.now() + 3600_000, accountUuid: 'R', upstream: `http://127.0.0.1:${upPort}` }], 0.9, { routingMode: 'balance' });
  const remote = createProxyServer(remoteAm, { proxy: { clients: [{ name: 'max', key: 'mp-max' }] }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const rPort = await listen(remote);

  // A local apikey route that CAN serve any shape (its own upstream) — after the mirror
  // refuses the shape, the request must fail over HERE (red-team r2), not pass through.
  const keyUp = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  const keyPort = await listen(keyUp);
  const localAm = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1', upstream: `http://127.0.0.1:${keyPort}` }], 0.9, { routingMode: 'balance' });
  localAm.accounts[0].enabled = false; // phase 1: no local route → the refusal passes through
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${rPort}`, key: 'mp-max' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [{ name: 'reports', type: 'oauth', accountUuid: 'R', enabled: true, status: 'active', inFlight: 0, quota: { unified7d: 0.1 } }] };
  link.identities = remoteIdentities(link.status);
  localAm.setPoolLinks([link]);
  const local = createProxyServer(localAm, { proxy: { apiKey: 't' }, queue: { enabled: false } });
  const lPort = await listen(local);
  try {
    const nonCC = JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, system: [{ type: 'text', text: 'You are a precise assistant.' }], messages: [{ role: 'user', content: 'hi' }] });
    const res = await fetch(`http://127.0.0.1:${lPort}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 't', 'x-maxpool-profile': 'claude', 'x-maxpool-pin-account': 'reports' }, body: nonCC });
    assert.equal(res.status, 429);
    assert.equal(res.headers.get('x-maxpool-request-shape-refused'), '1', 'the marker survived the link hop');
    const mirror = localAm.accounts.find(a => a.remote && a.remote.remoteName === 'reports');
    assert.ok(mirror, 'mirror row exists');
    assert.ok(!mirror.cooldownUntil, 'mirror row was NOT cooled by the shape refusal');
    assert.notEqual(mirror.status, 'throttled');
    // Phase 2: a local apikey route exists → the same request is SERVED there.
    localAm.accounts[0].enabled = true;
    const res2 = await fetch(`http://127.0.0.1:${lPort}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 't', 'x-maxpool-profile': 'claude', 'x-maxpool-pin-account': 'reports' }, body: nonCC });
    assert.equal(res2.status, 200, 'failed over to the local apikey route');
    assert.ok(!mirror.cooldownUntil, 'mirror still not cooled');
  } finally { await close(local); await close(remote); await close(upstream); await close(keyUp); }
});

test('pin: remote serves a pinned request ONLY on the named account; pinned-unavailable is a fast 503 the caller fails over on', async () => {
  // Remote side: a real proxy with two GLM accounts, one rate-limited.
  const upstream = okUpstream();
  const upPort = await listen(upstream);
  const remoteAm = new AccountManager([], 0.9, { routingMode: 'balance' });
  remoteAm.loadConfigProviders([
    { name: 'glm a', provider: 'zai', token: 'ka', upstream: `http://127.0.0.1:${upPort}` },
    { name: 'glm b', provider: 'zai', token: 'kb', upstream: `http://127.0.0.1:${upPort}` },
  ]);
  const b = remoteAm.accounts.find(a => a.name === 'glm b');
  b.status = 'throttled'; b.rateLimitedUntil = Date.now() + 60_000;
  const remote = createProxyServer(remoteAm, { proxy: { clients: [{ name: 'max', key: 'mp-max' }] }, upstream: `http://127.0.0.1:${upPort}` });
  const rPort = await listen(remote);
  try {
    const hdr = { 'content-type': 'application/json', 'x-api-key': 'mp-max', 'x-maxpool-profile': 'all' };
    const ok = await fetch(`http://127.0.0.1:${rPort}/v1/messages`, { method: 'POST', headers: { ...hdr, 'x-maxpool-pin-account': 'glm a' }, body: msgBody });
    assert.equal(ok.status, 200);
    await ok.text();
    assert.equal(remoteAm.accounts.find(a => a.name === 'glm a').completedRequests, 1, 'served by the pinned account');
    const busy = await fetch(`http://127.0.0.1:${rPort}/v1/messages`, { method: 'POST', headers: { ...hdr, 'x-maxpool-pin-account': 'glm b' }, body: msgBody, signal: AbortSignal.timeout(5000) });
    assert.equal(busy.status, 503, 'pinned-unavailable answers fast instead of holding');
    // Anonymous caller can't pin (no steering without a named key).
    assert.equal(remoteAm.accounts.find(a => a.name === 'glm b').completedRequests, 0);
  } finally { await close(remote); await close(upstream); }
});

test('SC20 automatic guard, FINAL shape: duplicate local copy stays LISTED with "in cloud" status, never routes, never refreshes, never redeems', async () => {
  let refreshed = 0;
  const am = new AccountManager([
    { name: 'glm shared', type: 'oauth', accountUuid: 'U1', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() - 60_000 },
  ], 0.9, { routingMode: 'balance' }, { refreshAccessToken: async () => { refreshed++; return { accessToken: 'n', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }; } });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [{ name: 'glm shared', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active' }] };
  link.identities = new Map([['uuid:U1', { name: 'glm shared' }]]);
  am.setPoolLinks([link]);
  const a = am.accounts.find(x => x.name === 'glm shared');
  assert.ok(a.poolBenchedBy, 'auto-guarded by identity match');
  assert.equal(am._matchesRequest(a, 'all', { path: '/v1/messages' }), false, 'never routed');
  await am.ensureTokenFresh(a.index);
  assert.equal(refreshed, 0, 'single-use refresh token never spent');
  // TUI shows the row with the in-cloud status (SC20 display requirement).
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const t = new TUI({ accountManager: am });
  const line = strip(t._renderAcct(a.index, 11, true));
  assert.match(line, /in cloud/, 'status says in cloud');
  assert.match(line, /Local/, 'Where column still says Local — it IS the local copy');
  am.setPoolLinks([]);
});

test('SC20 live bars: a benched local copy renders the CLOUD row\'s quota, never its own frozen snapshot', async () => {
  const am = new AccountManager([
    { name: 'shared', type: 'oauth', accountUuid: 'U1', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [{ name: 'shared', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active',
    inFlight: 0, quota: { unified5h: 0.17, unified7d: 0.83 } }] };
  link.identities = new Map([['uuid:U1', { name: 'shared' }]]);
  am.setPoolLinks([link]);
  const a = am.accounts.find(x => x.name === 'shared');
  assert.ok(a.poolBenchedBy);
  a.quota.unified5h = 0.04; a.quota.unified7d = 0.31;   // stale local snapshot from before the bench
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line = strip(new TUI({ accountManager: am })._renderAcct(a.index, 11, true));
  assert.match(line, /83%/, 'weekly bar reads the cloud copy');
  assert.doesNotMatch(line, /31%/, 'stale local weekly never shown');
  assert.equal(a.quota.unified7d, 0.31, 'render never mutates the local account');
  am.setPoolLinks([]);
});

test('red-team #3 fixes: mirrors never mirror a mirror, never removed at runtime, out of the local global cap, no uuid aliasing', async () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1' }], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [
    { name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {} },
    { name: 'reports', type: 'oauth', accountUuid: 'R1', enabled: true, status: 'active', inFlight: 0, quota: {} },
    { name: 'their mirror ☁', type: 'provider', provider: 'zai', enabled: true, remote: true },   // P2
  ] };
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const names = am.accounts.filter(a => a.remote).map(a => a.remote.remoteName).sort();
  assert.deepEqual(names, ['glm a', 'reports'], 'P2: a remote mirror row is never mirrored again');
  assert.equal(am.accounts.find(a => a.remote?.remoteName === 'reports').accountUuid, null, 'M2: mirror never carries accountUuid');
  // P4: mirror leases don't count toward THIS machine's global in-flight cap.
  const m = am.accounts.find(a => a.remote?.remoteName === 'glm a');
  m.inFlight = 500; m.activeWeight = 500;
  assert.equal(am.getGlobalInFlight(), 0, 'cloud rows never exhaust the local cap');
  m.inFlight = 0; m.activeWeight = 0;
  // P5: an account leaving the cloud is disabled in place — indexes stay stable.
  const before = am.accounts.map(a => a.name).join('|');
  link.status.accounts = link.status.accounts.filter(a => a.name !== 'glm a');
  am.applyPoolLinks();
  assert.equal(am.accounts.map(a => a.name).join('|'), before, 'no reindex');
  assert.equal(am.accounts.find(a => a.remote?.remoteName === 'glm a').enabled, false, 'gone from cloud = out of routing');
  am.setPoolLinks([]);
});

test('red-team #3 P1/P3: remote refuses a pin past 2x the soft target as BUSY, and a pin skips the remote queue gate', async () => {
  const am = new AccountManager([{ name: 'r', type: 'oauth', accountUuid: 'U', accessToken: 'x', refreshToken: 'y' }], 0.9, { routingMode: 'balance' });
  const a = am.accounts[0];
  am.queueState.waiting.push({}); // a waiter in the remote's own queue
  assert.equal(am._matchesRequest(a, 'claude', { pinAccount: 'r' }), true, 'P3: pinned request not blocked by the queue gate');
  a.inFlight = 2 * am.scheduler.perAccountConcurrencyTarget;
  const info = { pinAccount: 'r' };
  assert.equal(am._matchesRequest(a, 'claude', info), false, 'P1: refused at the ceiling');
  assert.equal(info.pinRefusedBusy, true, 'P1: refusal flagged as busy (distinct error)');
  am.queueState.waiting.length = 0;
});

test('SC22 People screen: columns align by visible width, merges cloud windows, delta rule, nobody-yet state', async () => {
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const am = new AccountManager([], 0.9);
  const t = new TUI({ accountManager: am });
  assert.match(strip(t._renderPeoplePage(100).join('\n')), /Nobody has made a named request yet/);
  am.poolLinks = [{ lastOkAt: Date.now(), status: { callerWindows: {
    max: { h24: { req: 120, tok: 0 }, h24p: { req: 100, tok: 0 }, d7: { req: 500, tok: 2e6 }, d7p: { req: 0, tok: 0 }, d30: { req: 500, tok: 0 }, d30p: { req: 0, tok: 0 }, total: { req: 500, tok: 0 } },
    ahmed: { h24: { req: 10, tok: 0 }, h24p: { req: 4, tok: 0 }, d7: { req: 30, tok: 5000 }, d7p: { req: 0, tok: 0 }, d30: { req: 30, tok: 0 }, d30p: { req: 0, tok: 0 }, total: { req: 30, tok: 0 } },
  } } }];
  const lines = t._renderPeoplePage(100).map(strip);
  const hdr = lines.find(l => l.includes('person'));
  const maxRow = lines.find(l => l.trim().startsWith('max'));
  const ahmedRow = lines.find(l => l.trim().startsWith('ahmed'));
  assert.ok(maxRow && ahmedRow);
  assert.equal(maxRow.length, ahmedRow.length, 'rows the same visible width (color codes do not shift columns)');
  assert.match(maxRow, /\+20%/, 'base >= 50 → percent delta');
  assert.match(ahmedRow, /\+6\b/, 'base < 50 → raw delta');
  assert.ok(lines.indexOf(maxRow) < lines.indexOf(ahmedRow), 'sorted by 7d descending');
  assert.ok(hdr.indexOf('7d') > 0);
});

test('SC19 sort + hide: Where groups first (local before cloud), h also hides guarded locals', async () => {
  const { TUI } = await import('../src/tui.js');
  const _strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const am = new AccountManager([
    { name: 'kira', type: 'oauth', accountUuid: 'K', accessToken: 'x', refreshToken: 'r' },
  ], 0.9, { routingMode: 'balance' });
  am.loadConfigProviders([{ name: 'glm local', provider: 'zai', token: 'k1' }]);
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [
    { name: 'glm local', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0 },
    { name: 'cloud claude', type: 'oauth', enabled: true, status: 'active', inFlight: 0 },
  ] };
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const t = new TUI({ accountManager: am });
  const order = t._displayOrder().map(i => am.accounts[i].name);
  const firstCloud = order.findIndex(n => am.accounts.find(a => a.name === n)?.remote);
  const anyLocalAfter = order.slice(firstCloud).some(n => !am.accounts.find(a => a.name === n)?.remote);
  assert.ok(firstCloud > 0 && !anyLocalAfter, 'all local rows before all cloud rows');
  // hide-disabled also hides the guarded local duplicate
  t.hideDisabled = true;
  const visible = t._displayOrder().map(i => am.accounts[i]).filter(a => !(t.hideDisabled && a.enabled === false) && !(t.hideDisabled && a.poolBenchedBy) && a.type !== 'pool');
  assert.ok(!visible.some(a => a.poolBenchedBy), 'guarded local hidden under h');
  assert.ok(visible.some(a => a.remote), 'cloud rows still visible under h');
  am.setPoolLinks([]);
});

test('link down: cloud mirror rows read "offline", never "disabled"', async () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1' }], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [{ name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {} }] };
  link.identities = remoteIdentities(link.status);
  am.setPoolLinks([link]);
  const m = am.accounts.find(x => x.remote);
  assert.ok(m, 'mirror row exists');
  link.lastError = 'ECONNREFUSED';
  am.syncRemoteMirrors(link);
  assert.equal(m.enabled, false, 'down link takes the mirror out of routing');
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const line = strip(new TUI({ accountManager: am })._renderAcct(m.index, 11, true));
  assert.match(line, /⟐ offline/, 'reads as cloud unreachable');
  assert.doesNotMatch(line, /disabled/, 'never "disabled"');
  am.setPoolLinks([]);
});

test('boot during link outage keeps local copies benched (persisted identities seed the guard)', async () => {
  const am = new AccountManager([
    { name: 'shared', type: 'oauth', accountUuid: 'U9', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.9, { routingMode: 'balance' });
  // Boot: a FRESH link — no successful poll yet, identities empty, link not erroring either.
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  am.setPoolLinks([link]);
  am.applyPoolLinks();
  assert.equal(am.accounts.find(a => a.name === 'shared').poolBenchedBy, null,
    'without a seed, a fresh boot during an outage RELEASES the copy (the red-team scenario)');
  // The fix: seed from persisted state before the first poll.
  link.identities = new Map();
  am.seedPoolLinks({ team: { 'uuid:U9': { name: 'shared' } } }, Date.now());
  const a = am.accounts.find(x => x.name === 'shared');
  assert.equal(a.poolBenchedBy, 'shared', 'seeded identities bench the local copy at boot');
  assert.equal(am._matchesRequest(a, 'all', { path: '/v1/messages' }), false, 'never routed while benched');
  await am.ensureTokenFresh(a.index);
  assert.equal(a.refreshToken, 'r', 'single-use refresh token never spent during the outage window');
  am.setPoolLinks([]);
});

test('polled status: control characters are stripped from every name a terminal renders', async () => {
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link._fetchRemoteStatus = async () => ({ ok: true, at: 1, json: {
    accounts: [{ name: 'a\x1b]52;c;x\x07b', type: 'provider', provider: 'z\x1bai', lastError: 'e\x1b[2Jr' }],
    pools: [{ name: 'p\x1bq', accounts: [{ name: 'r\x1bs' }] }],
    callers: { 'c\x1bd': { requests: 1 } },
    callerWindows: { 'e\x1bf': { total: 1 } },
  } });
  await link.poll();
  assert.doesNotMatch(JSON.stringify(link.status), /\\u001b|\\u0007/);
  assert.deepEqual(Object.keys(link.status.callerWindows), ['ef']);
  assert.equal(link.status.accounts[0].name, 'a]52;c;xb');
});

test('no double count: undoing a forwarded request removes exactly one request from every window', () => {
  const am = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k1' }], 0.9, { routingMode: 'balance' });
  am._bumpCaller('max', 1, 0);
  am._bumpCaller('max', 1, 0);
  am._unbumpCaller('max');
  const st = am.callerStats.get('max');
  const hour = new Date().toISOString().slice(0, 13), day = hour.slice(0, 10);
  assert.deepEqual([st.total.req, st.hours[hour].req, st.days[day].req], [1, 1, 1]);
});

test('persisted identities age from the last good poll: an old seed is ignored, re-saving never refreshes it', () => {
  const am = new AccountManager([
    { name: 'shared', type: 'oauth', accountUuid: 'U9', accessToken: 'x', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.9, { routingMode: 'balance' });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  am.setPoolLinks([link]);
  const threeDaysAgo = Date.now() - 3 * 24 * 3600 * 1000;
  am.seedPoolLinks({ team: { 'uuid:U9': { name: 'shared' } } }, threeDaysAgo);
  assert.equal(am.poolIdentitiesAt(), threeDaysAgo, 'a re-save keeps the seed age');
  link.identities = new Map(); link._seedAt = null;
  am.seedPoolLinks({ team: { 'uuid:U9': { name: 'shared' } } }, Date.now() - 15 * 24 * 3600 * 1000);
  assert.equal(am.accounts[0].poolBenchedBy, null, 'a seed older than 14 days is ignored');
  am.setPoolLinks([]);
});

test('owner 2026-10-30: a GLM key at 97% session / 20% weekly stays FIRST-CLASS (no session-driven demotion)', () => {
  const am = new AccountManager([
    { name: 'claude', type: 'oauth', accountUuid: 'C1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', credential: 'k', profiles: ['all'] },
  ], 0.9, { routingMode: 'prefer-zai' });
  const glm = am.accounts.find(a => a.name === 'glm');
  const claude = am.accounts.find(a => a.name === 'claude');
  glm.quota = { providerSes: 0.97, providerWk: 0.20 };
  claude.quota = { unified5h: 0.1, unified7d: 0.1 };
  // Tier: the weekly ladder must read the WEEKLY window alone (old Math.max(ses,wk)
  // read 0.97 → 'critical' → last-resort pass 2 only, behind every Claude account).
  assert.equal(am._weeklyRawState(glm), 'normal', 'weekly 20% → normal, not critical');
  // Availability: 97% session with wall 1.0 stays SERVEABLE (owner: to 100%).
  assert.equal(am._isAvailable(glm, { allowWeeklyReserve: true }), true, 'pass-1 eligible');
  assert.equal(am._isSessionQuotaUnavailable(glm), false, 'not session-benched under the wall');
});

test('pin drop with a legacy-key link is named loudly, not silent (council 2026-10-31)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /pin-account dropped: the link authenticated with the remote\\'s legacy apiKey/,
    'the misconfiguration is named in the log');
});

test('capacity page $/1M: price ÷ measured weekly tank, monthly-normalized (owner 2026-10-31)', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { monthlyPriceUSD } = await import('../src/zai-subs.js');
  // quarterly $403.2 → $134.4/mo; annual $1411.2 → $117.6/mo
  assert.equal(monthlyPriceUSD([{ status: 'VALID', autoRenew: true, billingCycle: 'quarterly', price: 403.2 }]), 134.4);
  assert.ok(Math.abs(monthlyPriceUSD([{ status: 'VALID', autoRenew: true, billingCycle: 'annually', price: 1411.2 }]) - 117.6) < 1e-9);
  assert.equal(monthlyPriceUSD([]), null);
  assert.equal(monthlyPriceUSD([{ status: 'VALID', autoRenew: true, billingCycle: 'weekly', price: 5 }]), null, 'unknown cycle → null');
  // end-to-end render: provider row with wk tank 8M and $134.4/mo → $16.80/1M
  const am = new AccountManager([
    { name: 'glm q', type: 'provider', provider: 'zai', credential: 'k', profiles: ['all'] },
    { name: 'claude priced', type: 'oauth', accountUuid: 'C9', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.9, { routingMode: 'balance', monthlyPriceUSD: { 'claude priced': 200 } });
  // Open a weekly cycle, accrue tokens, then close at 80% full — exactly the
  // production path (accrue opens, utilization observations set peak, close freezes).
  for (const [nm, toks] of [['glm q', 6_400_000], ['claude priced', 1_600_000]]) {
    const L = am.capacity;
    L.accrue(nm, { input: Math.round(toks / 2), output: Math.round(toks / 2) }, Date.now() - 6 * 86400e3, ['wk']);
    L.estimateFromUtilization(nm, 'wk', 0.8);
    L.closeCycle(nm, 'wk', Date.now(), { finalUtilization: 0.8 });
  }
  am.applyMonthlyPrice(am.accounts[0].index, 134.4);
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const page = new TUI({ accountManager: am, config: {} })._renderCapacityPage(140).map(strip).join('\n');
  assert.match(page, /\$16\.80/, 'glm q: 134.4 ÷ 8M');
  assert.match(page, /\$100\.00/, 'claude priced: $200 ÷ measured 2M tank');
  assert.match(page, /\$\/1M/, 'header present');
  assert.match(page, /price per token|monthly-normalized/, 'legend names the derivation');
});

test('queue head-skip: a serveable waiter is not blocked forever by an unserveable head (redteam#5)', () => {
  const am = new AccountManager([{ name: 'glm', type: 'provider', provider: 'zai', credential: 'k', profiles: ['all'] }], 0.9, { routingMode: 'balance' });
  // Head: enqueued 2 min ago (beyond the 60s bound). Follower: enqueued now.
  const head = { queueTicket: { id: 1, queuedAt: Date.now() - 120_000, bytes: 100 } };
  const follower = { queueTicket: { id: 2, queuedAt: Date.now(), bytes: 100 } };
  am.queueState.waiting.push(head.queueTicket, follower.queueTicket);
  // Follower within the bound: FIFO holds (no starvation of the head).
  assert.equal(am.canAdmitQueuedRequest({ ...follower }), false, 'fresh follower still waits its turn');
  // The HEAD itself always admits (unchanged FIFO fast path).
  assert.equal(am.canAdmitQueuedRequest({ ...head }), true, 'head admits');
  // Re-queue both; now let the FOLLOWER wait past the bound with a stuck head.
  am.queueState.waiting.length = 0;
  const stuckHead = { queueTicket: { id: 3, queuedAt: Date.now() - 300_000, bytes: 100 } };
  const slowFollower = { queueTicket: { id: 4, queuedAt: Date.now() - 90_000, bytes: 100 } };
  am.queueState.waiting.push(stuckHead.queueTicket, slowFollower.queueTicket);
  assert.equal(am.canAdmitQueuedRequest({ ...slowFollower }), true, 'a 90s-waited follower skips the stuck head');
  assert.deepEqual(am.queueState.waiting.map(t => t.id), [3],
    'the ADMITTED ticket leaves the queue; the stuck head keeps its place');
});

test('architect#5: the aggregate pool-row mechanism is DELETED from the codebase', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['../src/account-manager.js', '../src/server.js', '../src/tui.js', '../src/index.js']) {
    const src = readFileSync(new URL(f, import.meta.url), 'utf8');
    assert.ok(!/upsertPoolAccount/.test(src), `${f} must not create aggregate rows`);
    assert.ok(!/type === 'pool'/.test(src), `${f} must not branch on type:pool`);
  }
});

test('price cell derivation: weekly-plan accounts derive weekly tank at 5h × 5.5 (measured), not × 33.6 (owner 2026-10-31)', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const am = new AccountManager([
    { name: 'glm wkplan', type: 'provider', provider: 'zai', credential: 'k', profiles: ['all'] },
  ], 0.9, { routingMode: 'balance' });
  const a = am.accounts[0];
  a.quota.weeklyAbsent = false;          // a weekly-plan account
  am.applyMonthlyPrice(0, 134.4);
  // No wk cycle; one ses cycle → 5h tank 1.2M. Derived weekly = 6.6M → $20.36/1M.
  const L = am.capacity;
  L.accrue('glm wkplan', { input: 480_000, output: 480_000 }, Date.now() - 4.5 * 3600e3, ['ses']);
  L.estimateFromUtilization('glm wkplan', 'ses', 0.8);
  L.closeCycle('glm wkplan', 'ses', Date.now(), { finalUtilization: 0.8 });
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const page = new TUI({ accountManager: am, config: {} })._renderCapacityPage(140).map(strip).join('\n');
  assert.match(page, /\$20\.36/, '134.4 ÷ (1.2M × 5.5)');
  assert.doesNotMatch(page, /\$3\.\d\d/, 'the ×33.6 figure ($3.34) must not appear');
});

test('capacity page on the REAL two-pool shape: cloud rows get their price and tank (owner 2026-10-31 screen showed "--")', async () => {
  const { CapacityLedger } = await import('../src/capacity-ledger.js');
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
  const am = new AccountManager([], 0.9, { routingMode: 'balance' });
  am.capacity = new CapacityLedger();
  // Months of history measured LOCALLY before the move, under the pre-migration name.
  am.capacity.accrue('personal', { input: 4_000_000, output: 4_000_000 }, Date.now() - 6 * 86400e3, ['wk']);
  am.capacity.estimateFromUtilization('personal', 'wk', 0.8);
  am.capacity.closeCycle('personal', 'wk', Date.now(), { finalUtilization: 0.8 });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null; link.identities = new Map();
  link.status = { accounts: [
    { name: 'personal', type: 'oauth', accountUuid: 'P1', enabled: true, status: 'active', inFlight: 0, quota: {},
      plan: { tier: 'Max 20x', cadence: 'monthly', priceUsd: 200, billingMonths: 1 } },
    { name: 'glm q', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {},
      monthlyPriceUSD: 134.4,
      // v5: only all-token CYCLES are capacity; a bare aggregate `tank` (legacy axis) is ignored.
      cycles: { ses: [], wk: [{ startedAt: Date.now() - 8 * 86400e3, endedAt: Date.now() - 86400e3, resetAt: Date.now() - 86400e3,
        tokens: 8_000_000, finalUtilization: 1.0, complete: true, axis: 'all' }] } },
  ] };
  am.setPoolLinks([link]); am.syncRemoteMirrors(link);
  const t = new TUI({ accountManager: am, config: {} });
  t.capacityWindow = 'wk';
  const page = t._renderCapacityPage(140).map(strip).join('\n');
  assert.match(page, /\$20\.00/, 'Claude mirror: $200 ÷ 10M local pre-migration tank');
  assert.match(page, /\$16\.80/, 'GLM mirror: $134.4 cloud-read price ÷ 8M cloud tank');
  am.setPoolLinks([]);
});

test('cloud row tank: months of local history beat a 1-cycle cloud reading', async () => {
  const { CapacityLedger } = await import('../src/capacity-ledger.js');
  const am = new AccountManager([], 0.9, { routingMode: 'balance' });
  am.capacity = new CapacityLedger();
  for (let k = 3; k >= 1; k--) {   // three local weekly cycles of 10M-equivalent
    am.capacity.accrue('glm z', { input: 4_000_000, output: 4_000_000 }, Date.now() - (k * 7 + 6) * 86400e3, ['wk']);
    am.capacity.estimateFromUtilization('glm z', 'wk', 0.8);
    am.capacity.closeCycle('glm z', 'wk', Date.now() - k * 7 * 86400e3, { finalUtilization: 0.8 });
  }
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null; link.identities = new Map();
  link.status = { accounts: [{ name: 'glm z', type: 'provider', provider: 'zai', enabled: true, status: 'active', inFlight: 0, quota: {},
    tank: { wk: { avg: 2_000_000, n: 1, prev: null, last: 2_000_000, lowerBound: true } } }] };
  am.setPoolLinks([link]); am.syncRemoteMirrors(link);
  const row = am.accounts.find(x => x.remote);
  const t = am.capacityTank(row.index, 'wk');
  assert.equal(t.n, 3, 'the 3-cycle local history wins');
  assert.equal(t.avg, 10_000_000);
  am.setPoolLinks([]);
});
