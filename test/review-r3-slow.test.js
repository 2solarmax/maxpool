// Review round 3 pins that need the real 30s module bounds (own process, own env).
process.env.MAXPOOL_BODY_MS = '30000';   // the floor the code allows

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const tok = req => String(req.headers.authorization || '').replace('Bearer ', '');
const mgr = (n = 2) => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
})), 0.9);
async function quiet(fn) { const o = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = o; } }

test('R3-1 wiring: a stalled non-streaming body moves the turn and soft-cools a1 (held conversations keep it)', async () => {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume(); hits.push(tok(req));
    if (tok(req) === 't1') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"id":"msg_'); return; }   // body stalls
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_a2', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  const upPort = await listen(up);
  const am = mgr(2);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const text = await quiet(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }) });
      return r.text();
    });
    assert.deepEqual(hits, ['t1', 't2']);
    assert.ok(text.includes('msg_a2'), text.slice(0, 200));
    assert.ok(am.accounts[0].softCooldownUntil > Date.now(), 'deprioritised for new placements');
    assert.ok(!(am.accounts[0].cooldownUntil > Date.now()), 'no account-wide cooldown');
    assert.equal(am.accounts[0].consecutiveFailures, 0);
  } finally { await close(proxy); await close(up); }
});

test('R3-4: an upstream trickling pings with no model-bearing event is released at the 30s hold cap', async () => {
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const iv = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 500);
    const end = setTimeout(() => { clearInterval(iv); res.end(); }, 40_000);
    res.on('close', () => { clearInterval(iv); clearTimeout(end); });
  });
  const upPort = await listen(up);
  const proxy = createProxyServer(mgr(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 120_000 } });
  const port = await listen(proxy);
  const ac = new AbortController();
  try {
    const t0 = Date.now();
    const arrivedAt = await quiet(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', signal: ac.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('"type":"ping"')) return Date.now() - t0;
      }
    });
    assert.ok(arrivedAt != null, 'held bytes were released before the stream ended');
    assert.ok(arrivedAt >= 29_000 && arrivedAt < 36_000, `released at the cap, not held to the end (40s): ${arrivedAt}ms`);
  } finally { ac.abort(); await close(proxy); await close(up); }
});
