// Shared fixture for the link-path TTFB / retry-same tests: a fake cloud pool with two
// Claude rows. `plan(pinAccount, nthHitForThatRow, req)` → 'hang' | 'reset' | 'partial'
// | 'ok' | 'sse' | {delay, sse}.
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

export const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
export const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };

const SSE_OK = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_link_ok"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

export function remotePool(plan) {
  const hits = [];
  const per = new Map();
  const server = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [
        { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
      ] }));
      return;
    }
    if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
    req.resume();
    const pin = req.headers['x-maxpool-pin-account'] || '?';
    const n = (per.get(pin) || 0) + 1; per.set(pin, n);
    hits.push(pin);
    const what = plan(pin, n, req);
    if (what === 'hang') return;
    // 'reset': the link drops the connection (a transport fault, nothing answered).
    if (what === 'reset') { req.socket.destroy(); return; }
    // 'partial': the first SSE event, then silence (lets a client leave mid-body).
    if (what === 'partial') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_link_partial"}}\n\n');
      return;
    }
    const answer = (sse) => {
      if (sse) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_OK); }
      else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_link_ok"}'); }
    };
    if (what && typeof what === 'object') {
      const t = setTimeout(() => answer(what.sse), what.delay);
      res.on('close', () => clearTimeout(t));
      return;
    }
    answer(what === 'sse');
  });
  return { server, hits };
}

export async function bootLink(remote, queue = { enabled: false }) {
  const remotePort = await listen(remote.server);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue });
  const port = await listen(proxy);
  return { am, port, cleanup: async () => { am.setPoolLinks([]); await close(proxy); await close(remote.server); await close(upstream); } };
}

export function bigBody(bytes, stream) {
  return JSON.stringify({ model: 'claude-opus-5-5', stream, messages: [{ role: 'user', content: 'x'.repeat(Math.max(0, bytes - 120)) }] });
}

export async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}
export const attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));
