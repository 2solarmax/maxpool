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

// r4: the echo-hold cap counts from the FIRST HELD BYTE, not from stream start —
// a split message_start arriving >30s after the stream began must still be REWRITTEN
// (the provider model id must never leak), while the trickle case still releases 30s
// after the hold began. The anchor is not injectable, so fake the clock: the upstream
// holds its first body byte for 31s BEFORE streamResponse's first read — no, that also
// delays the hold start. Instead exercise the real seam: first chunk LATE (after the
// 30s refusalHoldStart age) but the hold begins with it → the rewrite must happen.
test('r4: a split model-bearing event arriving 31s after stream start is still rewritten, not released verbatim', async () => {
  const FIRST = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"glm-5.3",';
  const REST = '"usage":{"input_tokens":1}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const t1 = setTimeout(() => res.write(FIRST), 31_000);
    const t2 = setTimeout(() => res.end(REST), 32_500);
    res.on('close', () => { clearTimeout(t1); clearTimeout(t2); });
  });
  const upPort = await listen(up);
  const proxy = createProxyServer(mgr(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let text = '';
    await quiet(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      text = await r.text();
    });
    assert.ok(!text.includes('glm-5.3'), `provider id must be rewritten: ${text.slice(0, 220)}`);
    assert.ok(text.includes('"model":"claude-opus-5-5"'), `client model present: ${text.slice(0, 220)}`);
    assert.ok(text.includes('message_stop'), text.slice(0, 220));
  } finally { await close(proxy); await close(up); }
});

// F07: a PROVIDER stream never arms the refusal hold, so the echo hold must set its
// own 30s anchor — without it a provider trickling pings with no model event holds
// the stream indefinitely (only the 240s idle guard would ever cut it).
test('r4: a provider stream trickling pings with no model event releases 30s after the FIRST held byte', async () => {
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    setTimeout(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 1_500);   // hold begins here
    const iv = setInterval(() => res.write('event: ping\ndata: {"type":"ping"}\n\n'), 1_000);
    const end = setTimeout(() => { clearInterval(iv); res.end(); }, 120_000);
    res.on('close', () => { clearInterval(iv); clearTimeout(end); });
  });
  const upPort = await listen(up);
  const am = new AccountManager([{ name: 'glm1', type: 'provider', provider: 'zai', profiles: ['all'], accessToken: 'k', refreshToken: null, expiresAt: null, model: 'glm-5.3' }], 0.9, { routingMode: 'balance' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const ac = new AbortController();
  try {
    const t0 = Date.now();
    const firstPingAt = await quiet(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
        body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
        if (buf.includes('"type":"ping"')) return Date.now() - t0;
      }
    });
    assert.ok(firstPingAt != null, 'held bytes released');
    assert.ok(firstPingAt >= 30_000 && firstPingAt < 38_000, `released ~30s after the hold began (first ping ~1.5s): ${firstPingAt}ms`);
  } finally { ac.abort(); await close(proxy); await close(up); }
});

// r5: the REFUSAL hold's 30s cap shares the same anchor (first held byte) — case A:
// a bare message_start arriving 31s after headers is NOT past the cap, so a refusal in
// the next chunk still reroutes with nothing written to the client.
test('r5 case A: message_start at +31s, refusal 1s later → still rerouted (cap counts from the first held byte)', async () => {
  const START = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}\n\n';
  const REFUSAL = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction"}},"usage":{"output_tokens":0}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  const PROVIDER = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","model":"glm-5.3"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider answered"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';
  let call = 0;
  const up = http.createServer((req, res) => {
    req.resume(); call += 1;
    if (call === 1) {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
      const t1 = setTimeout(() => res.write(START), 31_000);
      const t2 = setTimeout(() => res.end(REFUSAL), 32_000);
      res.on('close', () => { clearTimeout(t1); clearTimeout(t2); });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(PROVIDER);
  });
  const upPort = await listen(up);
  const am = new AccountManager([
    { name: 'anth1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'glm1', type: 'provider', provider: 'zai', profiles: ['all'], accessToken: 'k', refreshToken: null, expiresAt: null, model: 'glm-5.3' },
  ], 0.9, { routingMode: 'balance' });
  am.accounts[1].activeWeight = 50;
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let text = '';
    const lines = []; const orig = console.log; console.log = (...a) => lines.push(a.join(' '));
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
        body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      text = await r.text();
    } finally { console.log = orig; }
    assert.equal(call, 2, `rerouted once: ${lines.join(' | ')}`);
    assert.ok(text.includes('provider answered'), text.slice(0, 300));
    assert.ok(!text.includes('"refusal"'), 'the refusal never reaches the client');
  } finally { await close(proxy); await close(up); }
});
