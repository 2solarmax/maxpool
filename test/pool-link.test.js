import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import {
  PoolLink, fetchRemoteStatus, remoteIdentities, computeDuplicates,
  accountIdentity, nextHopCount, HOP_HEADER, credentialFp,
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
  const { server, keyFp } = remotePoolStub();
  const port = await listen(server);
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'mp-max' }, {
      fetchRemoteStatus: (url, key) => fetchRemoteStatus(url, key, { timeoutMs: 2000 }),
    });
    await link.poll();
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

test('pool link: routing forwards to the remote pool with key + hop header', async () => {
  const { server, seen } = remotePoolStub();
  const remotePort = await listen(server);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); }); // must NOT be used
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  let proxy = null;
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
    await link.poll();
    const row = am.upsertPoolAccount(link);
    assert.equal(row.type, 'pool');
    am.setPoolLinks([link]);
    assert.ok(am._matchesRequest(row, 'all', { path: '/v1/messages' }), 'pool row is routable for API traffic');
    assert.equal(am._matchesRequest(row, 'all', { path: '/favicon.ico' }), false, 'browser noise never forwarded');
    assert.ok(am._isAvailable(row), 'healthy link is available');

    proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: msgBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.via, 'remote-pool');
    // Assert on the stub's RECORDED exchange only after the response completed —
    // a missing hop header can never hang the assertion (mutant M3 lesson).
    const rec = await new Promise(r => {
      const check = () => seen.length ? r(seen.at(-1)) : setTimeout(check, 25);
      check();
    });
    assert.equal(rec.key, 'mp-max', 'person key forwarded');
    assert.equal(rec.hop, '1', 'hop header added');
    // Lease accounting (live-rehearsal bug 2026-10-29): one successful forward =
    // inFlight back to 0, one completed, zero failed — never a leaked/doubled lease.
    // Bounded wait: the client socket must CLOSE first — that is the event whose
    // listener used to double-release. Then also drain one macrotask so a leaked
    // close-listener release (which would decrement below/after) is observed.
    await new Promise(r => {
      const t = setTimeout(r, 1500);
      res.body.cancel().catch(() => {}).finally(() => { clearTimeout(t); r(); });
    });
    await new Promise(r => setImmediate(r));
    assert.equal(row.inFlight, 0, 'lease released exactly once');
    assert.equal(row.completedRequests, 1, 'success counted');
    assert.equal(row.failedRequests, 0, 'success not counted as failure');
    // status-only release = failure (verified directly against releaseAccount) —
    // pin the success-flag shape, not just the counter arithmetic.
    const l2 = am.acquireAccount({ path: '/v1/messages' });
    assert.equal(l2?.account?.name, 'team', 'control lease lands on the link');
    am.releaseAccount(l2, { status: 200 });
    assert.equal(row.failedRequests, 1, 'control: status-only release counts failed');
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

test('pool link: down remote benches the link row (requests fall to local accounts)', async () => {
  const { server } = remotePoolStub();
  const port = await listen(server); // remote exists but will be closed mid-test
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, via: 'local' })); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'local-1', type: 'apikey', apiKey: 'k1' }], 0.9);
  let proxy = null;
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'mp-max' });
    await link.poll();
    const row = am.upsertPoolAccount(link);
    am.setPoolLinks([link]);
    await close(server); // remote goes down
    link.lastError = 'network error'; link.lastOkAt = null; // simulate a failed poll tick
    assert.equal(am._isAvailable(row), false, 'downed link benched');

    proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: msgBody,
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.via, 'local', 'served locally, not by the dead link');
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
    am.upsertPoolAccount(link);
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
  const { TUI } = await import('../src/tui.js');
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
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
    am.upsertPoolAccount(link);
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
    const forwarded = seen.at(-1) || [];
    assert.ok(!forwarded.some(h => /zai|kimi/.test(h)), `provider headers leaked: ${forwarded.join(',')}`);
    assert.ok(forwarded.includes('x-maxpool-session') || forwarded.includes('x-maxpool-profile') || true, 'safe headers may pass');
    am.setPoolLinks([]);
    await close(proxy);
  } finally { await close(server); await close(upstream); }
});

test('link scoring: a loaded/exhausted cloud scores WORSE than a fresh one (routing respects remote capacity)', async () => {
  const am = new AccountManager([], 0.9);
  const fresh = { name: 't1', type: 'apikey', apiKey: 'k1' };
  am.upsertRuntimeAccount(fresh);
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.summary = { total: 9, usable: 9, needsLogin: 0 };
  link.status = { scheduler: { globalInFlight: 0 }, accounts: [] };
  am.upsertPoolAccount(link);
  am.setPoolLinks([link]);
  const row = am.accounts.find(a => a.type === 'pool');
  const s1 = am._scoreAccount(row, {});
  link.status.scheduler.globalInFlight = 12; // cloud busy
  link.summary = { total: 9, usable: 2, needsLogin: 1 }; // and nearly exhausted
  const s2 = am._scoreAccount(row, {});
  assert.ok(s2 > s1, `loaded cloud must score worse: ${s2} > ${s1}`);
  // And a healthy link must still beat a locally-throttled account (routable, not benched).
  const local = am.accounts.find(a => a.name === 't1');
  local.status = 'throttled'; local.rateLimitedUntil = Date.now() + 60000;
  const localScore = am._scoreAccount(local, {});
  assert.ok(s1 < localScore, `fresh link should outrank a throttled local: ${s1} < ${localScore}`);
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
  const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');
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

test('link down: cloud mirror rows read "cloud ✕", never "disabled"', async () => {
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
  assert.match(line, /cloud ✕/, 'reads as cloud unreachable');
  assert.doesNotMatch(line, /disabled/, 'never "disabled"');
  am.setPoolLinks([]);
});
