// Release B (batch 1) integration: T2, T4, B12 through the real proxy server against a
// stub upstream, and the Mac-side link behaviour (B4 header out, B7 504 neutral) against a
// stub cloud. No account token is real; every socket is on 127.0.0.1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

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
const _attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));

function accounts(n = 2) {
  return new AccountManager(Array.from({ length: n }, (_, i) => ({
    name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
  })), 0.9);
}
const body = (stream = false) => JSON.stringify({ model: 'claude-opus-5-5', stream, messages: [{ role: 'user', content: 'hi' }] });

// Upstream stub: plan(token, nth) → 'hang' | 'ok' | 529
function upstreamStub(plan) {
  const hits = [];
  const per = new Map();
  const server = http.createServer((req, res) => {
    req.resume();
    const tok = String(req.headers.authorization || '').replace('Bearer ', '');
    const n = (per.get(tok) || 0) + 1; per.set(tok, n);
    hits.push(tok);
    const what = plan(tok, n);
    if (what === 'hang') return;
    if (what === 529) { res.writeHead(529, { 'content-type': 'application/json', 'retry-after': '30' }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"busy"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_ok","type":"message"}');
  });
  return { server, hits };
}

async function run(am, stub, headers, { stream = false, timeoutMs = 60_000 } = {}) {
  const upPort = await listen(stub.server);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const out = { status: 0, text: '', headers: {}, elapsedMs: 0, lines: [] };
  try {
    out.lines = await captureLog(async () => {
      const t0 = Date.now();
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers }, body: body(stream),
          signal: AbortSignal.timeout(timeoutMs),
        });
        out.status = r.status; out.headers = Object.fromEntries(r.headers); out.text = await r.text();
      } catch (e) { out.status = `client-abort:${e.name}`; }
      out.elapsedMs = Date.now() - t0;
    });
  } finally { await close(proxy); await close(stub.server); }
  return out;
}

// ---------------------------------------------------------------- T2 (+ B12 neutrality)

test('T2: X-Stainless-Timeout 40, upstream silent → 504 inside patience − margin, one hop, row untouched (B12)', async () => {
  const am = accounts(2);
  const stub = upstreamStub(() => 'hang');
  const r = await run(am, stub, { 'x-stainless-timeout': '40' }, { timeoutMs: 45_000 });
  // 40s patience − 15s margin = 25s usable. Today: the flat 120s wait outlives the client.
  assert.equal(r.status, 504, `status ${r.status} after ${r.elapsedMs}ms\n${r.lines.slice(-6).join('\n')}`);
  assert.ok(r.elapsedMs <= 26_000, `answered at ${r.elapsedMs}ms, must be ≤ 40s − 15s margin (+1s slack)`);
  assert.ok(r.elapsedMs >= 20_000, `answered at ${r.elapsedMs}ms: waited the deadline, did not give up early`);
  assert.equal(stub.hits.length, 1, `summed hops ≤ deadline: ONE upstream hit (got ${stub.hits}); with <60s left no move is attempted`);
  const err = JSON.parse(r.text);
  assert.equal(err.error.type, 'timeout_error');
  assert.equal(r.headers['x-maxpool-request-scoped'], undefined, 'a client request (no pool header) gets no pool-only marker');
  // B12: a client-patience expiry is neither an account fault nor a streak.
  const a = am.accounts[0];
  assert.equal(a.inFlight, 0, 'lease returned');
  assert.equal(a.failedRequests, 0, 'not a failed request');
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.requestFaultStreak || 0, 0, 'no markTransientFailure streak');
  assert.ok(!(a.softCooldownUntil > Date.now()) && !(a.cooldownUntil > Date.now()), 'no cooldown');
  assert.equal(am._loadSummary(a, 15 * 60_000).failed, 0);
});

// ---------------------------------------------------------------- T4

test('T4: a fast 529 with < 60s of patience left is surfaced, ONE upstream hit (the :1616 path via hasEligibleRoute)', async () => {
  const am = accounts(2);
  const stub = upstreamStub(() => 529);
  // 70s patience − 15s margin = 55s remaining < the 60s minimum-move.
  const r = await run(am, stub, { 'x-stainless-timeout': '70' }, { timeoutMs: 20_000 });
  assert.equal(r.status, 529, `status ${r.status}\n${r.lines.slice(-6).join('\n')}`);
  assert.equal(stub.hits.length, 1, `no move under the minimum: hits=${stub.hits}`);
  assert.ok(r.elapsedMs < 5_000, `surfaced fast (${r.elapsedMs}ms)`);
});

test('T4 control: the same 529 with ample patience still moves to the second account', async () => {
  const am = accounts(2);
  const stub = upstreamStub((tok) => (tok === 't1' ? 529 : 'ok'));
  const r = await run(am, stub, { 'x-stainless-timeout': '600' }, { timeoutMs: 20_000 });
  assert.equal(r.status, 200, `status ${r.status}`);
  assert.equal(stub.hits.length, 2, `moved: ${stub.hits}`);
});

test('T4 control: a header-less client keeps today\'s behaviour (move on 529, no deadline)', async () => {
  const am = accounts(2);
  const stub = upstreamStub((tok) => (tok === 't1' ? 529 : 'ok'));
  const r = await run(am, stub, {}, { timeoutMs: 20_000 });
  assert.equal(r.status, 200);
  assert.equal(stub.hits.length, 2);
});

// ---------------------------------------------------------------- Mac side (B4 out, B7 in)

function cloudStub(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [
        { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
      ] }));
      return;
    }
    req.resume();
    seen.push({ pin: req.headers['x-maxpool-pin-account'], headers: { ...req.headers } });
    handler(req, res, seen.length);
  });
  return { server, seen };
}

async function bootMac(cloud) {
  const cloudPort = await listen(cloud.server);
  const dead = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const deadPort = await listen(dead);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  return { am, port, cleanup: async () => { am.setPoolLinks([]); await close(proxy); await close(dead); await close(cloud.server); } };
}

async function viaMac(port, headers, stream = false) {
  let status = 0; let text = ''; let hdrs = {};
  const lines = await captureLog(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers }, body: body(stream),
      signal: AbortSignal.timeout(20_000),
    });
    status = r.status; hdrs = Object.fromEntries(r.headers); text = await r.text();
  });
  return { status, text, headers: hdrs, lines };
}

test('B4: a non-streaming request with patience sends the cloud ONE number: header + G ≤ the Mac link wait', async () => {
  const cloud = cloudStub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_ok"}'); });
  const mac = await bootMac(cloud);
  try {
    const r = await viaMac(mac.port, { 'x-stainless-timeout': '3600' });
    assert.equal(r.status, 200, r.text);
    const sent = Number(cloud.seen[0].headers['x-maxpool-deadline-ms']);
    assert.ok(Number.isFinite(sent) && sent > 0, `the cloud was given a deadline: ${cloud.seen[0].headers['x-maxpool-deadline-ms']}`);
    // cc: remaining ≈ 3585s; the Mac's per-hop cap (290s) binds, so the header follows the CAPPED wait.
    assert.ok(sent + 10_000 <= 290_000, `header ${sent} + G(10s) ≤ 290s link hop`);
    assert.ok(sent > 270_000, `and close to it (${sent}) — not a token value`);
  } finally { await mac.cleanup(); }
});

test('B4: no deadline header goes out for a streaming request or a header-less client (today\'s wire, unchanged)', async () => {
  const cloud = cloudStub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_ok"}'); });
  const mac = await bootMac(cloud);
  try {
    await viaMac(mac.port, { 'x-stainless-timeout': '600' }, true);
    await viaMac(mac.port, {}, false);
    assert.equal(cloud.seen.length, 2);
    for (const s of cloud.seen) assert.equal(s.headers['x-maxpool-deadline-ms'], undefined);
  } finally { await mac.cleanup(); }
});

test('B7: the cloud\'s request-scoped 504 releases the Mac row NEUTRAL (no cooldown, no failed, no streak)', async () => {
  const cloud = cloudStub((req, res) => {
    res.writeHead(504, { 'content-type': 'application/json', 'x-maxpool-request-scoped': '1' });
    res.end('{"type":"error","error":{"type":"timeout_error","message":"deadline"}}');
  });
  const mac = await bootMac(cloud);
  try {
    // 70s − 15s = 55s remaining < minimum-move: the 504 is surfaced after ONE hop.
    const r = await viaMac(mac.port, { 'x-stainless-timeout': '70' });
    assert.equal(r.status, 504, `${r.status} ${r.text}`);
    assert.equal(cloud.seen.length, 1);
    for (const row of mac.am.accounts) {
      assert.ok(!(row.cooldownUntil > Date.now()), `${row.name}: no cooldown`);
      assert.equal(row.failedRequests, 0, `${row.name}: no failed count`);
      assert.equal(row.consecutiveFailures, 0, `${row.name}: no streak`);
      assert.equal(row.inFlight, 0);
      const w = mac.am._loadSummary(row, 15 * 60_000);
      assert.equal(w.failed, 0, `${row.name}: last15m.failed`);
      assert.equal(w.linkFailed || 0, 0, `${row.name}: not a link fault`);
    }
  } finally { await mac.cleanup(); }
});

test('B7 control: a 504 WITHOUT the request-scoped marker (an upstream\'s own 504) is not given the neutral release', async () => {
  const cloud = cloudStub((req, res) => { res.writeHead(504, { 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"timeout_error","message":"x"}}'); });
  const mac = await bootMac(cloud);
  try {
    const r = await viaMac(mac.port, { 'x-stainless-timeout': '70' });
    assert.equal(r.status, 504);
    const failed = mac.am.accounts.reduce((n, row) => n + row.failedRequests, 0);
    assert.ok(failed >= 1, 'an unmarked 504 still counts as today (marker is the only neutral key)');
  } finally { await mac.cleanup(); }
});
