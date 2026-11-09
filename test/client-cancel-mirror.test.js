import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink, credentialFp } from '../src/pool-link.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { server.closeAllConnections?.(); return new Promise(r => server.close(r)); }

// Cloud pool stub whose /v1/messages takes 1.5s before sending headers (a thinking turn).
function slowRemote() {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [
        { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'glm max@gomokka.com', type: 'provider', provider: 'zai', keyFingerprint: credentialFp('k'), enabled: true, status: 'active', quota: { providerSes: 0.1, providerWk: 0.2 } },
      ] }));
      return;
    }
    if (req.url === '/v1/messages') {
      hits.push(req.headers['x-maxpool-pin-account'] || '?');
      const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, 1500);
      res.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, hits };
}

test('client cancels while a cloud account is still thinking: not an account failure, not retried elsewhere', async () => {
  const { server, hits } = slowRemote();
  const remotePort = await listen(server);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  let proxy = null;
  try {
    const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
    await link.poll();
    am.setPoolLinks([link]);
    proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` });
    const proxyPort = await listen(proxy);
    const ctl = new AbortController();
    const p = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
      body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }), signal: ctl.signal,
    }).catch(e => e);
    await new Promise(r => setTimeout(r, 300));
    ctl.abort();                                   // Esc in Claude Code
    await p;
    await new Promise(r => setTimeout(r, 2500));   // let any retry run to completion
    const rows = am.accounts.filter(a => a.remote);
    const failed = rows.filter(a => a.failedRequests || a.consecutiveFailures).map(a => `${a.name}:${a.consecutiveFailures}`);
    assert.deepEqual(failed, [], `a client cancel was scored as an account failure: ${failed}`);
    assert.equal(hits.length, 1, `after the client left, the request was re-sent to: ${hits.slice(1).join(', ')}`);
    assert.equal(rows.reduce((n, a) => n + a.inFlight, 0), 0, 'leases released');
  } finally { am.setPoolLinks([]); if (proxy) await close(proxy); await close(server); await close(upstream); }
});
