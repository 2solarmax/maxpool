// Release B, red-team round 1, F3 (BLOCKER): a non-streaming answer that takes LONGER than the
// first-byte floor (prod 120s) but still fits inside the client's patience must be SERVED, and
// the row that is serving it must not be touched. Before the fix the cloud's direct wait was
// min(120s floor, remaining, 290s): at the floor it timed out (UPSTREAM_TTFB), answered a bare
// 503, and the Mac booked failedRequests/consecutiveFailures/last15m.failed + a cooldown on the
// cloud row for an answer the upstream was still producing.
//
// Timers are SCALED so this runs in seconds: the floor is 3s (MAXPOOL_TTFB_MS), the upstream
// answers at 6s, the client's patience is 60s. Scratch pools + a local upstream stub only: no
// Anthropic / z.ai call, no live pool.
// Module constants are read at import; node --test gives each file its own process.
process.env.MAXPOOL_TTFB_MS = '3000';
process.env.MAXPOOL_TTFB_MS_PER_BYTE = '0';
process.env.MAXPOOL_LINK_TTFB_MS = '15000';
process.env.MAXPOOL_LINK_HOP_CAP_MS = '30000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { PoolLink } = await import('../src/pool-link.js');

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
async function captureLog(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}
const oauth = (n) => Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
}));
const REQ_BODY = JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

// Upstream: answers after delayMs (null = never). `hits` records the bearer token of every call.
function upstreamStub(delayMs) {
  const hits = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      hits.push(String(req.headers.authorization || ''));
      if (delayMs == null) return;
      const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_long_ok","type":"message"}'); }, delayMs);
      res.on('close', () => clearTimeout(t));
    });
  });
  return { server, hits };
}

function untouched(am, label) {
  for (const row of am.accounts) {
    assert.ok(!(row.cooldownUntil > Date.now()), `${label}/${row.name}: cooldownUntil unchanged`);
    assert.equal(row.failedRequests || 0, 0, `${label}/${row.name}: failedRequests`);
    assert.equal(row.consecutiveFailures || 0, 0, `${label}/${row.name}: consecutiveFailures`);
    assert.equal(am._loadSummary(row, 15 * 60_000).failed, 0, `${label}/${row.name}: last15m.failed`);
  }
}

async function post(port, headers, timeoutMs = 60_000) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers }, body: REQ_BODY,
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text(), elapsedMs: Date.now() - t0 };
}

test('F3 direct: an answer slower than the first-byte floor but inside the client patience is SERVED; rows untouched; no move', async () => {
  const stub = upstreamStub(6_000);
  const upPort = await listen(stub.server);
  const am = new AccountManager(oauth(2), 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } });
  const port = await listen(proxy);
  try {
    let r;
    const lines = await captureLog(async () => { r = await post(port, { 'x-stainless-timeout': '60' }); });
    assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 200)}\n${lines.slice(-6).join('\n')}`);
    assert.ok(r.text.includes('msg_long_ok'));
    assert.ok(r.elapsedMs >= 5_500, `the answer really took longer than the 3s floor (${r.elapsedMs}ms)`);
    assert.equal(stub.hits.length, 1, `no move to another row: ${stub.hits.join(',')}`);
    assert.deepEqual(lines.filter(l => /attempt failed/.test(l)), []);
    untouched(am, 'direct');
  } finally { await close(proxy); await close(stub.server); }
});

test('F3 direct control: a request with NO patience header keeps the first-byte floor (503 at ~3s, today\'s behaviour)', async () => {
  const stub = upstreamStub(null);
  const upPort = await listen(stub.server);
  const am = new AccountManager(oauth(1), 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let r;
    await captureLog(async () => { r = await post(port, {}); });
    assert.equal(r.status, 503, r.text.slice(0, 200));
    assert.ok(r.elapsedMs >= 2_500 && r.elapsedMs <= 6_000, `cut at the 3s floor, got ${r.elapsedMs}ms`);
    assert.equal(r.headers['x-maxpool-request-scoped'], undefined);
  } finally { await close(proxy); await close(stub.server); }
});

test('F3 pool deadline: a first-byte timeout with no route left answers the request-scoped 504, never a bare 503', async () => {
  // Cap the hop at 4s (the same injectable knob as the link cap) and give the request a 40s pool deadline:
  // the TTFB timer (4s) fires BEFORE the deadline, so this is the not-deadline-bound timeout path.
  process.env.MAXPOOL_LINK_HOP_CAP_MS = '4000';
  const stub = upstreamStub(null);
  const upPort = await listen(stub.server);
  const am = new AccountManager(oauth(1), 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let r;
    await captureLog(async () => { r = await post(port, { 'x-maxpool-deadline-ms': '40000' }); });
    assert.equal(r.status, 504, `${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(r.headers['x-maxpool-request-scoped'], '1');
    assert.equal(JSON.parse(r.text).error.type, 'timeout_error');
    assert.ok(r.elapsedMs >= 3_500 && r.elapsedMs <= 7_000, `timed out at the 4s hop cap, got ${r.elapsedMs}ms`);
    assert.equal(stub.hits.length, 1);
  } finally { process.env.MAXPOOL_LINK_HOP_CAP_MS = '30000'; await close(proxy); await close(stub.server); }
});

test('R2-2 direct client: a first-byte timeout at the hop cap with no route left also answers the 504 (not a bare 503)', async () => {
  // A direct long-patience client (stainless header, no pool hop) used to get 503 here while a pool-deadline
  // request got 504 for the same event. Both are this request running out of time, not an account fault.
  process.env.MAXPOOL_LINK_HOP_CAP_MS = '4000';
  const stub = upstreamStub(null);
  const upPort = await listen(stub.server);
  const am = new AccountManager(oauth(1), 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let r;
    await captureLog(async () => { r = await post(port, { 'x-stainless-timeout': '60' }); });
    assert.equal(r.status, 504, `${r.status} ${r.text.slice(0, 200)}`);
    assert.equal(JSON.parse(r.text).error.type, 'timeout_error');
    assert.ok(r.elapsedMs >= 3_500 && r.elapsedMs <= 7_000, `timed out at the 4s hop cap, got ${r.elapsedMs}ms`);
    assert.equal(stub.hits.length, 1);
  } finally { process.env.MAXPOOL_LINK_HOP_CAP_MS = '30000'; await close(proxy); await close(stub.server); }
});

test('F3 through a real link: Mac + cloud, answer slower than the cloud\'s floor, patience 60s → served; Mac row AND cloud row untouched', async () => {
  const stub = upstreamStub(6_000);
  const upPort = await listen(stub.server);
  const cloudAm = new AccountManager(oauth(1), 0.9);
  const cloud = createProxyServer(cloudAm, { proxy: { clients: [{ name: 'max', key: 'mp-max' }] }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } });
  const cloudPort = await listen(cloud);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  const macAm = new AccountManager([], 0.9);
  macAm.setPoolLinks([link]);
  const dead = http.createServer((q, s) => { s.writeHead(500); s.end('{}'); });
  const deadPort = await listen(dead);
  const mac = createProxyServer(macAm, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } });
  const macPort = await listen(mac);
  try {
    let r;
    const lines = await captureLog(async () => { r = await post(macPort, { 'x-stainless-timeout': '60' }); });
    assert.equal(r.status, 200, `${r.status} ${r.text.slice(0, 200)}\n${lines.filter(l => /attempt|remote|deadline|503|504/i.test(l)).join('\n')}`);
    assert.ok(r.text.includes('msg_long_ok'));
    assert.equal(stub.hits.length, 1, 'one upstream call: the cloud did not give up and re-send');
    assert.ok(macAm.accounts.length >= 1);
    untouched(macAm, 'mac');
    untouched(cloudAm, 'cloud');
  } finally { macAm.setPoolLinks([]); await close(mac); await close(dead); await close(cloud); await close(stub.server); }
});
