// Release B (batch 2) T7 / B10: never re-send for a client that has already left.
//
// The real ghost: the proxy drops its client-close listener the moment the upstream's
// HEADERS arrive. A non-streaming request is then in its BODY read with nobody watching
// the client; if the body read fails (reset / stall), the transient-error path "moves" the
// request to another account — a second upstream call for a socket that is already dead.
// Pre-B10 that burns an account's slot and a model call for nothing.
//
// Single pool, 127.0.0.1 stub upstream, no real token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, __serverTest } from '../src/server.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function captureLog(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}

function accounts() {
  return new AccountManager(['a1', 'a2'].map((n, i) => ({
    name: n, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
  })), 0.9);
}

/** Upstream: the FIRST hit sends 200 headers + a partial body, then (after `failAfterMs`) resets the socket. */
function bodyResetStub(failAfterMs) {
  const hits = [];
  let firstHit; const firstHitP = new Promise(r => { firstHit = r; });
  const server = http.createServer((req, res) => {
    req.resume();
    hits.push(req.headers.authorization);
    if (hits.length === 1) firstHit();
    if (hits.length > 1) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_second","type":"message"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000' });
    res.write('{"id":"msg_part');
    setTimeout(() => req.socket.destroy(), failAfterMs);
  });
  return { server, hits, firstHit: firstHitP };
}

async function runGhost({ stub, leaveAfterMs, queue = { enabled: false } }) {
  const am = accounts();
  const upPort = await listen(stub.server);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      await new Promise(resolve => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } });
        req.on('error', () => {});
        req.on('close', resolve);
        req.end(JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }));
        // Leave `leaveAfterMs` after the upstream has answered its headers (the body read is under way).
        stub.firstHit.then(() => sleep(leaveAfterMs)).then(() => req.destroy());
      });
      await sleep(1500);   // let the proxy finish whatever it does after the body read fails
    });
    return { am, lines, hits: stub.hits };
  } finally { await close(proxy); await close(stub.server); }
}

test('T7: client leaves during the non-streaming BODY read, then the body fails → NO second upstream call, client_cancelled, neutral release', async () => {
  const stub = bodyResetStub(700);
  const { am, lines, hits } = await runGhost({ stub, leaveAfterMs: 200 });
  assert.equal(hits.length, 1, `a dead client must not trigger a move; upstream hits: ${hits}\n${lines.join('\n')}`);
  assert.ok(lines.some(l => /client_cancelled/.test(l)), `client_cancelled logged:\n${lines.join('\n')}`);
  for (const a of am.accounts) {
    assert.equal(a.inFlight, 0, `${a.name} lease released`);
    assert.equal(a.failedRequests, 0, `${a.name}: a client leaving is not a failed request`);
    assert.equal(a.consecutiveFailures, 0, `${a.name}: no failure streak`);
    assert.ok(!(a.softCooldownUntil > Date.now()) && !(a.cooldownUntil > Date.now()), `${a.name}: no cooldown`);
  }
});

test('T7: the leave is noticed promptly while the body is still being read (lease freed before the upstream gives up)', async () => {
  const stub = bodyResetStub(5000);
  const am = accounts();
  const upPort = await listen(stub.server);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    await captureLog(async () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }));
      await stub.firstHit;
      await sleep(300);
      req.destroy();
      await sleep(400);
      assert.equal(am.accounts.reduce((n, a) => n + a.inFlight, 0), 0, 'lease freed ~immediately on client close, not after the upstream body timeout');
    });
  } finally { await close(proxy); await close(stub.server); }
});

test('T7 control: a LIVE client whose body read fails still moves to the second account', async () => {
  const stub = bodyResetStub(300);
  const am = accounts();
  const upPort = await listen(stub.server);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let status = 0;
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }), signal: AbortSignal.timeout(15_000) });
      status = r.status; await r.text();
    });
    assert.equal(status, 200);
    assert.equal(stub.hits.length, 2, 'a present client still gets the move');
  } finally { await close(proxy); await close(stub.server); }
});

test('B10 chokepoint: hasEligibleRoute refuses a re-send for a client whose socket is destroyed or closed, once-logged', async () => {
  const am = { hasAvailableRoute: () => true };
  const logs = [];
  const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); };
  try {
    assert.equal(__serverTest.hasEligibleRoute(am, {}), true, 'no client socket recorded: unchanged');
    assert.equal(__serverTest.hasEligibleRoute(am, { _clientRes: { destroyed: false, closed: false } }), true, 'live client: unchanged');
    const gone = { _clientRes: { destroyed: true } };
    assert.equal(__serverTest.hasEligibleRoute(am, gone), false);
    assert.equal(__serverTest.hasEligibleRoute(am, gone), false);
    assert.equal(__serverTest.hasEligibleRoute(am, { _clientRes: { closed: true } }), false, 'closed (not yet destroyed) counts');
  } finally { console.log = orig; }
  assert.equal(logs.filter(l => /client_cancelled/.test(l)).length, 2, `logged once per request (2 requests): ${logs.join('|')}`);
});
