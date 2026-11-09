import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { server.closeAllConnections?.(); return new Promise(r => server.close(r)); }

// Collect [Maxpool] console lines while fn runs.
async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

const attempts = (lines) => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));
const one = (lines, kind, action) => {
  const hits = attempts(lines).filter(l => l.includes(`(${kind})`) && l.endsWith(`→ ${action}`));
  assert.equal(hits.length, 1, `expected exactly one attempt line (${kind}) → ${action}; got:\n${attempts(lines).join('\n') || '(none)'}`);
  return hits[0];
};

function remote(status, delayMs = 0, onHit) {
  const hits = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [
        { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
        { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
      ] }));
      return;
    }
    if (req.url === '/v1/messages') {
      hits.push(req.headers['x-maxpool-pin-account'] || '?');
      if (onHit) onHit(req, res);
      else {
        const t = setTimeout(() => { res.writeHead(status, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }, delayMs);
        res.on('close', () => clearTimeout(t));
      }
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, hits };
}

async function boot(remoteServer, upstreamStatus = 500) {
  const remotePort = await listen(remoteServer);
  const upstream = http.createServer((req, res) => { res.writeHead(upstreamStatus); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}` , queue: { enabled: false } });
  const proxyPort = await listen(proxy);
  return { am, proxy, proxyPort, cleanup: async () => { am.setPoolLinks([]); await close(proxy); await close(remoteServer); await close(upstream); } };
}

const post = (port, body = { model: 'claude-opus-5-5', messages: [] }) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: JSON.stringify(body),
}).then(r => r.text().catch(() => ''));

// DIRECT-path sites: no pool link at all — one local account whose upstream port is
// dead. One refused TCP connection is a network-class fetch failure → the transient
// branch (markTransientFailure network + release) → moved when a route remains.
test('direct path: transient failure emits exactly one attempt line per attempt with moved, then queued/surfaced', async () => {
  const deadPort = 1; // nothing listens here; connection refused instantly
  const am = new AccountManager([{
    name: 'local@gomokka.com', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000,
  }], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}` , queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(() => post(port));
    // Single account, no route left: the attempt is queued (queue disabled in this
    // fixture → declines immediately) and then surfaced — one line each.
    one(lines, 'fetch failed', 'queued');
    one(lines, 'fetch failed', 'surfaced');
    assert.equal(attempts(lines).length, 2, `no duplicate attempt lines:\n${attempts(lines).join('\n')}`);
  } finally { await close(proxy); }
});

// Wire: remote 429 before any byte — the "moved" token from the link branch.
test('link path: remote 429 emits exactly one attempt line with moved', async () => {
  const r = remote(429, 0, (req, res) => { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); });
  const { proxyPort, cleanup } = await boot(r.server);
  try {
    const lines = await captureLog(() => post(proxyPort));
    one(lines, 'remote-429', 'moved');
    assert.ok(!attempts(lines).some(l => l.endsWith('→ queued') && !l.includes('no other route')), 'no stray queued line');
  } finally { await cleanup(); }
});

// Wire: remote 503 with only ONE remote account route available — the queue refuses
// (pinned requests never hold) and the error is surfaced: queued + surfaced pair.
test('link path: remote 503 with no other route emits queued then surfaced, one each', async () => {
  const r = remote(503, 0, (req, res) => { res.writeHead(503); res.end('{}'); });
  const { proxyPort, cleanup } = await boot(r.server);
  try {
    const lines = await captureLog(() => post(proxyPort));
    // Row 1 (a successor exists) logs moved; row 2 (last route) logs queued, the
    // queue declines (disabled here) and the SAME attempt logs its surfaced verdict.
    one(lines, 'remote-503', 'moved');
    one(lines, 'remote-503', 'queued');
    one(lines, 'remote-503', 'surfaced');
    assert.equal(attempts(lines).length, 3, `exactly one line per verdict:\n${attempts(lines).join('\n')}`);
  } finally { await cleanup(); }
});

// Wire: client cancel on the link path — released-cancel (D1).
test('link path: client cancel emits exactly one attempt line with released-cancel', async () => {
  const r = remote(200, 1500);
  const { proxyPort, cleanup } = await boot(r.server);
  try {
    const lines = await captureLog(async () => {
      const ctl = new AbortController();
      const p = fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }), signal: ctl.signal,
      }).catch(e => e);
      await new Promise(rs => setTimeout(rs, 300));
      ctl.abort();
      await p;
      await new Promise(rs => setTimeout(rs, 500));
    });
    one(lines, 'client_cancelled', 'released-cancel');
    assert.equal(attempts(lines).length, 1, 'the abandoned turn must not be retried elsewhere');
    assert.equal(r.hits.length, 1, 'stub hit exactly once');
  } finally { await cleanup(); }
});

// The formatter itself, via the module's test export: kind in parentheses, quoted
// account, detail, arrow + next-action token — the grammar every wired site shares.
test('logFailedAttempt line grammar: kind + account + detail + next-action token', async () => {
  const mod = await import('../src/server.js');
  const fn = mod.__serverTest.logFailedAttempt;
  assert.equal(typeof fn, 'function', 'logFailedAttempt exported for pinning');
  const out = await captureLog(() => fn('acct', 'kind-x', 'detail-y', 'moved'));
  assert.equal(out[0], '[Maxpool] attempt failed (kind-x) on "acct" — detail-y → moved');
});

// The give-up line is LAZY: a hold that recovers must log `queued` and never
// `surfaced` (pins the formatter-vs-printer split — passing the printing call as the
// argument emitted "surfaced" at call time even when the queue then served the turn).
test('link path: a queued attempt that recovers logs queued and never surfaced', async () => {
  let n = 0;
  const r = remote(0, 0, (req, res) => {
    n++;
    if (n <= 2) { res.writeHead(503, { 'retry-after': '1' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const remotePort = await listen(r.server);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`,
    queue: { enabled: true, capacityMaxWaitMs: 8000, pollMs: 50 },
  });
  const port = await listen(proxy);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
      });
      status = res.status; await res.text();
    });
    assert.equal(status, 200, `the hold recovered and served the turn:\n${lines.join('\n')}`);
    one(lines, 'remote-503', 'queued');
    assert.equal(attempts(lines).filter(l => l.endsWith('→ surfaced')).length, 0,
      `a recovered hold must not log surfaced:\n${attempts(lines).join('\n')}`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(r.server); await close(upstream); }
});
