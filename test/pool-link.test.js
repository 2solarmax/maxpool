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

