// Release B, red-team round 1, F5: EVERY re-send site goes through the shared guard
// (client-gone + the 60s minimum-move for a non-streaming request). The direct-path moves on a
// retriable 500/502/503/504 and on a non-transient proxy error used to recurse into forwardRequest
// with no check, so a doomed re-send (< 60s of patience left) still fired upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, __serverTest } from '../src/server.js';

const { resendAllowed, hasEligibleRoute } = __serverTest;
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
const accounts = n => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
})), 0.9);
const BODY = JSON.stringify({ model: 'claude-opus-5-5', stream: false, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });

// A pool whose upstream answers `status` on every call (or, with upstreamUrl override, never reaches one).
async function run({ status, upstreamUrl, patienceSecs }) {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume();
    hits.push(String(req.headers.authorization || ''));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(`{"type":"error","error":{"type":"api_error","message":"x${status}"}}`);
  });
  const upPort = await listen(up);
  const proxy = createProxyServer(accounts(2), { proxy: { apiKey: 'tc-test' }, upstream: upstreamUrl || `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  let out;
  const lines = await captureLog(async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-stainless-timeout': String(patienceSecs) }, body: BODY,
      signal: AbortSignal.timeout(20_000),
    });
    out = { status: r.status, text: await r.text() };
  });
  await close(proxy); await close(up);
  return { ...out, hits, moved: lines.filter(l => /attempt failed .*→ moved$/.test(l)).length, lines };
}

for (const status of [500, 502, 503, 504]) {
  test(`F5: a retriable ${status} with < 60s of patience left is surfaced after ONE upstream hit (no doomed re-send)`, async () => {
    const r = await run({ status, patienceSecs: 70 });   // 70s − 15s margin = 55s < 60s minimum-move
    assert.equal(r.hits.length, 1, `hits=${r.hits}\n${r.lines.slice(-6).join('\n')}`);
    assert.equal(r.moved, 0);
  });
  test(`F5 control: the same ${status} with ample patience still moves to the second account`, async () => {
    const r = await run({ status, patienceSecs: 600 });
    assert.equal(r.hits.length, 2, `hits=${r.hits}\n${r.lines.slice(-6).join('\n')}`);
  });
}

test('F5: a non-transient proxy error with < 60s of patience left is surfaced, not re-sent to another account', async () => {
  // An unparsable upstream URL makes fetch throw a non-network TypeError: the proxy-error path (not the transient one).
  const r = await run({ status: 200, upstreamUrl: 'http://bad host:1', patienceSecs: 70 });
  assert.equal(r.status, 502, r.text.slice(0, 200));
  assert.equal(r.moved, 0, r.lines.join('\n'));
});
test('F5 control: the same proxy error with ample patience still moves to the second account', async () => {
  const r = await run({ status: 200, upstreamUrl: 'http://bad host:1', patienceSecs: 600 });
  assert.equal(r.moved, 1, r.lines.join('\n'));
});

test('F5 chokepoint: resendAllowed refuses a re-send for a gone client or with < 60s left, allows otherwise; hasEligibleRoute delegates to it', () => {
  const now = Date.now();
  const lines = [];
  const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
  try {
    assert.equal(resendAllowed({ stream: false, deadlineAt: now + 55_000 }), false, '55s left: doomed');
    assert.equal(resendAllowed({ stream: false, deadlineAt: now + 65_000 }), true, '65s left: allowed');
    assert.equal(resendAllowed({}), true, 'no deadline: allowed (today)');
    assert.equal(resendAllowed({ stream: true, deadlineAt: now + 1_000 }), true, 'streaming has no deadline');
    assert.equal(resendAllowed({ _clientRes: { destroyed: true } }), false, 'client socket destroyed');
    assert.equal(resendAllowed({ _clientRes: { closed: true }, stream: false, deadlineAt: now + 600_000 }), false, 'client socket closed');
    const am = accounts(2);
    assert.equal(hasEligibleRoute(am, { stream: false, deadlineAt: now + 55_000 }, new Set()), false);
    assert.equal(hasEligibleRoute(am, { _clientRes: { destroyed: true } }, new Set()), false);
    assert.equal(hasEligibleRoute(am, {}, new Set()), true);
  } finally { console.log = orig; }
});
