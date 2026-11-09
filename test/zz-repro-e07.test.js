import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const STATUS = { accounts: [
  { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
] };
test('E07 repro', async () => {
  let n = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') { res.writeHead(200, {'content-type':'application/json'}); return res.end(JSON.stringify(STATUS)); }
    req.resume(); n += 1;
    if (n === 1) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); setTimeout(() => res.socket.destroy(), 300); return; }
    setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_row2"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); }, 4500);
  });
  const rp = await listen(remote);
  const upstream = http.createServer((q, r) => { r.writeHead(500); r.end('{}'); });
  const up = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${rp}`, key: 'mp-max' });
  await link.poll(); am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up}`, queue: { enabled: false, streamForwardGraceMs: 1500, heartbeatMs: 500 } });
  const port = await listen(proxy);
  try {
    const o = console.log; const lines = []; console.log = (...a) => lines.push(a.join(' '));
    let text = '', stamps = []; const t0 = Date.now();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      const rd = r.body.getReader(); const dec = new TextDecoder();
      for (;;) { const { done, value } = await rd.read(); if (done) break; const s = dec.decode(value, {stream:true}); text += s; stamps.push(...Array.from({ length: (s.match(/event: ping/g) || []).length }, () => Date.now() - t0)); }
    } finally { console.log = o; }
    process.stderr.write(`RESULT n=${n} pings=${stamps.length} stamps=${JSON.stringify(stamps)} hasRow2=${text.includes('msg_row2')} total=${Date.now()-t0}\n`);
    // r4 E07 pin: the failover hop's keep-alive must keep pinging until hop 2's first
    // real byte — ≥4 pings (baseline 4; the un-finally-cleared-timer mutant gave 1).
    assert.equal(n, 2, 'failover happened');
    assert.ok(text.includes('msg_row2'), text.slice(0, 200));
    assert.ok(stamps.length >= 4, `pings continued through the failover hop: ${JSON.stringify(stamps)} (text=${JSON.stringify(text.slice(0, 160))})`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});
