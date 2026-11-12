// Release B (batch 1): T5 — a non-streaming request is never retried on the SAME account
// (B5), and B7's cloud side: the 504 + request-scoped marker is only for a request that
// carried the pool deadline header; a header-less (old Mac) request keeps today's 503.
// Module constants are read at import: floor the first-byte wait at 5s BEFORE importing.
process.env.MAXPOOL_TTFB_MS = '5000';
// no size scaling: the streaming control must time out at the 5s floor, not at 0.6ms/byte × 300KB.
process.env.MAXPOOL_TTFB_MS_PER_BYTE = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');

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
const attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));
const accounts = (n) => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
})), 0.9);
const bigBody = (bytes, stream) => JSON.stringify({ model: 'claude-opus-5-5', stream, messages: [{ role: 'user', content: 'x'.repeat(bytes - 120) }] });

async function run(am, plan, headers, reqBody) {
  const hits = [];
  const up = http.createServer((req, res) => { req.resume(); hits.push(String(req.headers.authorization || '')); if (plan(hits.length) === 'hang') return; res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const upPort = await listen(up);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const out = { hits, status: 0, text: '', headers: {}, lines: [], elapsedMs: 0 };
  try {
    out.lines = await captureLog(async () => {
      const t0 = Date.now();
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers }, body: reqBody,
        signal: AbortSignal.timeout(40_000),
      });
      out.status = r.status; out.headers = Object.fromEntries(r.headers); out.text = await r.text();
      out.elapsedMs = Date.now() - t0;
    });
  } finally { await close(proxy); await close(up); }
  return out;
}

test('T5: a non-streaming >250KB first-byte timeout does NOT retry the same account (1 upstream hit)', async () => {
  const r = await run(accounts(1), () => 'hang', {}, bigBody(300_000, false));
  assert.equal(r.hits.length, 1, `retry-same must not fire for non-streaming; hits=${r.hits.length}\n${attempts(r.lines).join('\n')}`);
  assert.ok(!attempts(r.lines).some(l => l.endsWith('→ retry-same')), attempts(r.lines).join('\n'));
  assert.equal(r.status, 503, 'one account, nothing left to move to → today\'s connection_unavailable');
});

test('T5 control: the same 300KB prompt STREAMING still gets its retry-same (streaming unchanged)', async () => {
  const r = await run(accounts(1), (n) => (n === 1 ? 'hang' : 'ok'), {}, bigBody(300_000, true));
  assert.ok(r.hits.length >= 2, `streaming keeps D3: hits=${r.hits.length}\n${attempts(r.lines).join('\n')}`);
});

test('B7 (cloud side): a header-less request keeps today\'s 503 and gets NO request-scoped marker (old Mac / mixed version)', async () => {
  const r = await run(accounts(1), () => 'hang', {}, bigBody(2_000, false));
  assert.equal(r.status, 503, r.text.slice(0, 200));
  assert.equal(r.headers['x-maxpool-request-scoped'], undefined);
});

test('B7 (cloud side): with the pool deadline header the cloud answers 504 timeout_error + request-scoped, after waiting the header', async () => {
  // 20s header − 3s transit = 17s usable. The 5s TTFB floor would cut at 5s and today answers 503.
  // With a deadline of 17s the hop wait is min(5s TTFB, 17s) = 5s: TTFB still binds first, so
  // the deadline-cut 504 only appears once the deadline is the binding bound. Use a header small
  // enough that the deadline binds: 6s header → max(6s − 3s, 1s) = 3s.
  const r = await run(accounts(1), () => 'hang', { 'x-maxpool-deadline-ms': '6000' }, bigBody(2_000, false));
  assert.equal(r.status, 504, `${r.status} ${r.text.slice(0, 200)}`);
  assert.equal(r.headers['x-maxpool-request-scoped'], '1');
  assert.equal(JSON.parse(r.text).error.type, 'timeout_error');
  assert.ok(r.elapsedMs >= 2_500 && r.elapsedMs <= 4_500, `waited ≈ header − transit margin (3s), got ${r.elapsedMs}ms — not an instant 504, not the 5s TTFB`);
  assert.equal(r.hits.length, 1);
});
