import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ISOLATION: never resolve a developer's real config.
const dir = mkdtempSync(join(tmpdir(), 'mp-heartbeat-'));
process.env.MAXPOOL_CONFIG = join(dir, 'config.json');
writeFileSync(process.env.MAXPOOL_CONFIG, JSON.stringify({ proxy: {}, accounts: [] }));
const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { PoolLink } = await import('../src/pool-link.js');

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => { s.closeAllConnections?.(); s.close(r); });
const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function post(port, body) {
  const res = await fetch(`http://127.0.0.1:${port}/v1/messages?beta=true`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-profile': 'all' }, body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  let text = '';
  try {
    for await (const c of res.body) text += Buffer.from(c).toString();
  } catch (e) { text += `\n[CLIENT GAVE UP: ${e.name}]`; }
  return { status: res.status, text };
}

test('a request released from the queue onto a cloud row delivers the cloud reply', async () => {
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ name: 'cloud a', type: 'oauth', accountUuid: 'CA', enabled: true, status: 'active', quota: {} }] }));
      return;
    }
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); });
  });
  const remotePort = await listen(remote);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'k' });
  await link.poll();
  const am = new AccountManager([], 0.9);
  am.setPoolLinks([link]);
  const row = am.accounts.find(a => a.remote);
  assert.ok(row, 'mirror row exists');
  row.cooldownUntil = Date.now() + 700;       // busy now, free in under a second
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: true, pollMs: 50, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  try {
    const r = await post(port, { model: 'claude-sonnet-5-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    assert.ok(r.text.includes('message_stop'), `cloud reply must reach the client, got: ${r.text.slice(0, 200)}`);
    assert.ok(!r.text.includes('unreachable'), `must not surface a link error, got: ${r.text.slice(0, 200)}`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); }
});

test('a signature 400 arriving after the keep-alive started is still repaired', async () => {
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      const hasThinking = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'thinking'));
      setTimeout(() => {
        if (hasThinking) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        } else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); }
      }, hasThinking ? 300 : 0);   // slower than the 100ms keep-alive grace below
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accountUuid: 'C1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, enabled: true }], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, pollMs: 50, heartbeatMs: 1000, streamForwardGraceMs: 100 } });
  const port = await listen(proxy);
  try {
    const r = await post(port, { model: 'claude-sonnet-5-5', max_tokens: 8, stream: true, messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'glm' }, { type: 'text', text: 't' }] },
      { role: 'user', content: 'again' },
    ] });
    assert.ok(r.text.includes('message_stop'), `repaired reply must reach the client, got: ${r.text.slice(0, 220)}`);
    assert.equal(bodies.length, 2, 'one rejected attempt, one repaired attempt');
  } finally { await close(proxy); await close(upstream); }
});

test('a cloud 503 with no other route waits in the queue instead of reaching the client', async () => {
  let calls = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ name: 'cloud a', type: 'oauth', accountUuid: 'CA', enabled: true, status: 'active', quota: {} }] }));
      return;
    }
    req.resume();
    req.on('end', () => {
      calls++;
      if (calls === 1) { res.writeHead(503, { 'retry-after': '1', 'content-type': 'application/json' }); res.end('{"type":"error","error":{"type":"pinned_account_busy","message":"busy"}}'); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE);
    });
  });
  const remotePort = await listen(remote);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'k' });
  await link.poll();
  const am = new AccountManager([], 0.9);
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: true, pollMs: 50, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  try {
    const r = await post(port, { model: 'claude-sonnet-5-5', max_tokens: 8, stream: true, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200, `client must not see the 503, got ${r.status}: ${r.text.slice(0, 160)}`);
    assert.ok(r.text.includes('message_stop'), `reply after the wait must arrive, got: ${r.text.slice(0, 200)}`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); }
});

test('a signature 400 on a request released from the queue is still repaired', async () => {
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      bodies.push(body);
      const hasThinking = body.messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === 'thinking'));
      if (hasThinking) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
      } else { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); }
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accountUuid: 'C1', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, enabled: true }], 0.9);
  am.accounts[0].cooldownUntil = Date.now() + 700;   // forces the queue before the first attempt
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, pollMs: 50, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  try {
    const r = await post(port, { model: 'claude-sonnet-5-5', max_tokens: 8, stream: true, messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 'glm' }, { type: 'text', text: 't' }] },
      { role: 'user', content: 'again' },
    ] });
    assert.ok(r.text.includes('message_stop'), `repaired reply must reach the client, got: ${r.text.slice(0, 260)}`);
  } finally { await close(proxy); await close(upstream); }
});

test('a GLM row keeps serving past 95% of its session and benches at 100%; a cap still wins', () => {
  const am = new AccountManager([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z' }], 0.95, { crossProviderFallbackPolicy: 'always' });
  const a = am.accounts[0];
  const acquire = () => am.acquireAccount({ profile: 'all', path: '/v1/messages' }, new Set());
  a.quota.providerSes = 0.96; a.quota.providerSesReset = Date.now() + 3600_000;
  const lease = acquire();
  assert.equal(lease?.account?.name, 'glm', 'the ROUTER must serve it, not just the session helper');
  am.releaseAccount(lease, { success: true, status: 200 });
  a.quota.providerSes = 1;
  assert.equal(acquire(), null, 'benched at the real wall');
  a.quota.providerSes = 0.96; a.capUtilization = 0.5; a.capMode = 'fixed';
  assert.equal(acquire(), null, 'an owner cap outranks the wall');
});
