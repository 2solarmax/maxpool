// PENDING RELEASE B (maxpool freeze task, 2026-11-12): expected RED until release B ships its per-request deadline.
// Not under test/ discovery on purpose — run directly: node --test test/pending/link-cloud-keepalive.test.js
// Mac → cloud link, end to end with TWO REAL pools (owner report 2026-11-12: "why are
// there so many fails across all accounts?"). The Mac's link first-byte wait is FLAT
// (MAXPOOL_LINK_TTFB_MS), on the premise that the linked pool commits keep-alive
// headers early. Live, 182 link first-byte give-ups an hour hit cloud requests that
// were still legitimately waiting on Claude/GLM ("Client left after 119.3s … still
// waiting, nothing sent" on the cloud). This file pins what the Mac sees when the
// cloud's upstream is slower than the link floor but well inside the cloud's own wait.
process.env.MAXPOOL_LINK_TTFB_MS = '15000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer } = await import('../src/server.js');
const { PoolLink } = await import('../src/pool-link.js');

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const SSE_OK = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_slow_ok"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

// A real cloud pool whose upstream answers after `delayMs`, and a real Mac pool linked to it.
async function bootTwoPools(delayMs) {
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const stream = /"stream":true/.test(raw);
      const t = setTimeout(() => {
        if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_OK); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_slow_ok","type":"message"}'); }
      }, delayMs);
      res.on('close', () => clearTimeout(t));
    });
  });
  const upPort = await listen(upstream);
  const cloudAm = new AccountManager([
    { name: 'c1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.9);
  const cloud = createProxyServer(cloudAm, {
    proxy: { apiKey: 'mp-max' }, upstream: `http://127.0.0.1:${upPort}`,
    queue: { enabled: true, streamForwardGraceMs: 1000 },
  });
  const cloudPort = await listen(cloud);

  const macAm = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  macAm.setPoolLinks([link]);
  const deadUp = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const deadPort = await listen(deadUp);
  const mac = createProxyServer(macAm, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`,
    queue: { enabled: true, streamForwardGraceMs: 1000 },
  });
  const macPort = await listen(mac);
  return {
    macPort,
    cleanup: async () => { macAm.setPoolLinks([]); await close(mac); await close(deadUp); await close(cloud); await close(upstream); },
  };
}

async function sendThroughMac(macPort, stream) {
  let status = 0; let text = '';
  const lines = await captureLog(async () => {
    const r = await fetch(`http://127.0.0.1:${macPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ model: 'claude-opus-5-5', stream, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    status = r.status; text = await r.text();
  });
  return { status, text, lines };
}

for (const stream of [true, false]) {
  test(`a ${stream ? 'streaming' : 'NON-streaming'} turn the cloud is still serving is not abandoned by the Mac at the link floor`, async () => {
    // Cloud upstream answers at 20s; the Mac's link floor is 15s; the cloud's own wait is 120s.
    const { macPort, cleanup } = await bootTwoPools(20_000);
    try {
      const { status, text, lines } = await sendThroughMac(macPort, stream);
      const gaveUp = lines.filter(l => /attempt failed \(link_ttfb\)/.test(l));
      assert.deepEqual(gaveUp, [], `the Mac gave up on a cloud request that was still being served:\n${lines.join('\n')}`);
      assert.equal(status, 200, `status ${status}: ${text.slice(0, 300)}`);
      assert.ok(text.includes('msg_slow_ok'), `the cloud's real answer reached the client:\n${text.slice(0, 300)}`);
    } finally { await cleanup(); }
  });
}
