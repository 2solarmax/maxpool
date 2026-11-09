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

// ---------------------------------------------------------------- batch 2: remaining sites

const oauth = n => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
})), 0.9);

// Direct client-gone + the startedAt fix: the elapsed time in "Client left after Xs" was
// read from a requestInfo.startedAt nobody set, so it always printed 0.0s.
test('direct path: client cancel logs a NON-ZERO elapsed and exactly one released-cancel line', async () => {
  let hits = 0;
  const upstream = http.createServer((req, res) => {
    hits++; req.resume();
    const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); }, 1500);
    res.on('close', () => clearTimeout(t));
  });
  const upPort = await listen(upstream);
  const am = oauth(2);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const ctl = new AbortController();
      const p = fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }), signal: ctl.signal,
      }).catch(e => e);
      await new Promise(r => setTimeout(r, 400));
      ctl.abort();
      await p;
      await new Promise(r => setTimeout(r, 300));
    });
    const left = lines.find(l => l.startsWith('[Maxpool] Client left after '));
    assert.ok(left, lines.join('\n'));
    const secs = Number(/after ([\d.]+)s/.exec(left)[1]);
    assert.ok(secs >= 0.3, `elapsed must come from the request clock, got ${secs}s`);
    const line = one(lines, 'client_cancelled', 'released-cancel');
    assert.match(line, /client left after [\d.]+s \(still waiting\)/);
    assert.equal(attempts(lines).length, 1);
    assert.equal(hits, 1, 'not re-sent');
    assert.deepEqual(am.accounts.map(a => a.inFlight), [0, 0]);
  } finally { await close(proxy); await close(upstream); }
});

// Direct non-transient: a fetch that fails for a reason that is NOT network-class (an
// unparseable upstream URL) → moved off the first account, then surfaced.
test('direct path: non-transient proxy error emits moved, then queued + surfaced on the last route', async () => {
  const am = oauth(2);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://bad host:1', queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(() => post(port));
    const a = attempts(lines);
    assert.equal(a.length, 3, a.join('\n'));
    assert.ok(a[0].includes('on "a1"') && a[0].endsWith('→ moved'), a[0]);
    assert.ok(a[1].includes('on "a2"') && a[1].endsWith('→ queued'), a[1]);
    assert.ok(a[2].includes('on "a2"') && a[2].endsWith('→ surfaced'), a[2]);
    assert.ok(!a.some(l => l.includes('fetch failed')), 'classified non-transient');
  } finally { await close(proxy); }
});

// Local 429 on the only account: queued, then (queue disabled) surfaced — one each.
test('direct path: local 429 with no other route emits queued then surfaced', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' });
    res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}');
  });
  const upPort = await listen(upstream);
  const proxy = createProxyServer(oauth(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(() => post(port));
    one(lines, 'rate_limited', 'queued');
    one(lines, 'rate_limited', 'surfaced');
    assert.equal(attempts(lines).length, 2, attempts(lines).join('\n'));
  } finally { await close(proxy); await close(upstream); }
});

// Provider auth failure (401) on the only route → surfaced.
test('provider 401 emits exactly one auth_failed line → surfaced', async () => {
  const kimi = http.createServer((req, res) => {
    req.resume();
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":{"type":"authentication_error","message":"bad key"}}');
  });
  const kimiPort = await listen(kimi);
  const am = new AccountManager([], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false }, retry: { maxAttemptsPerRequest: 2 },
  });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all', 'x-maxpool-kimi-token': 'kk', 'x-maxpool-kimi-base-url': `http://127.0.0.1:${kimiPort}` },
        body: JSON.stringify({ model: 'claude-sonnet-test', messages: [] }),
      });
      await r.text();
    });
    const line = one(lines, 'auth_failed', 'surfaced');
    assert.match(line, /HTTP 401; no other route/);
    assert.equal(attempts(lines).length, 1, attempts(lines).join('\n'));
  } finally { await close(proxy); await close(kimi); }
});

// Provider 403 (quota, recoverable) on the only route: the moved line, then surfaced.
test('provider 403 emits provider_403 moved on a failover', async () => {
  const zai = http.createServer((req, res) => {
    req.resume();
    const tok = String(req.headers.authorization || '');
    if (tok.endsWith('zai-bad')) { res.writeHead(403, { 'content-type': 'application/json' }); res.end('{"error":{"type":"permission_error","message":"forbidden"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const zaiPort = await listen(zai);
  const mk = (name, token) => ({
    name, type: 'provider', provider: 'zai', authToken: token,
    upstream: `http://127.0.0.1:${zaiPort}`, authHeader: 'authorization', profiles: ['all'], priority: 10,
    modelMap: { default: 'glm-5.3' }, stripBetaHeaders: true,
  });
  const am = new AccountManager([mk('zai-bad', 'zai-bad'), mk('zai-good', 'zai-good')], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false }, retry: { maxAttemptsPerRequest: 4 },
  });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
        body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }),
      });
      await r.text();
    });
    const a = attempts(lines);
    assert.equal(a.length, 1, `exactly one attempt line:\n${a.join('\n')}`);
    assert.match(a[0], /^\[Maxpool\] attempt failed \(provider_403\) on "zai-bad" — HTTP 403 → moved$/);
  } finally { await close(proxy); await close(zai); }
});

// T2: the client leaves MID-STREAM on the link path — bytes already reached it. The
// pre-byte cancel rules (D1) do not apply: no released-cancel, no retry, no move.
test('T2: link mid-stream abort keeps the old path — no released-cancel, no re-send, leases released', async () => {
  const hitsRemote = [];
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
      req.resume();
      hitsRemote.push(req.headers['x-maxpool-pin-account']);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mid"}}\n\n');
      // ...then stays open (a long answer) until the client leaves
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  const { am, proxyPort, cleanup } = await boot(server);
  try {
    const lines = await captureLog(async () => {
      const ctl = new AbortController();
      const r = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }), signal: ctl.signal,
      });
      const reader = r.body.getReader();
      const first = await reader.read();
      assert.ok(Buffer.from(first.value).toString().includes('msg_mid'), 'bytes reached the client first');
      ctl.abort();
      await reader.read().catch(() => {});
      await new Promise(rs => setTimeout(rs, 500));
    });
    assert.equal(hitsRemote.length, 1, `never re-sent: ${hitsRemote}`);
    assert.ok(!lines.some(l => l.endsWith('→ released-cancel')), 'the pre-byte cancel shape does not fire');
    assert.ok(!lines.some(l => l.endsWith('→ moved') || l.endsWith('→ retry-same') || l.endsWith('→ queued')), attempts(lines).join('\n'));
    assert.ok(!lines.some(l => l.includes('(link, still waiting)')));
    assert.equal(am.accounts.filter(a => a.remote).reduce((n, a) => n + a.inFlight, 0), 0, 'leases released');
  } finally { await cleanup(); }
});

// One stub, one status → the first account's attempt line for that failure class.
async function firstAttemptFor(status, bodyText, setup) {
  const upstream = http.createServer((req, res) => {
    req.resume();
    const tok = String(req.headers.authorization || '');
    if (tok.endsWith('t1')) { res.writeHead(status, { 'content-type': 'application/json', 'retry-after': '5' }); res.end(bodyText); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const upPort = await listen(upstream);
  const am = oauth(2);
  am.accounts[1].activeWeight = 5;   // a1 is the natural first pick
  setup?.(am);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(() => post(port));
    return attempts(lines);
  } finally { await close(proxy); await close(upstream); }
}

test('server-side 429 (shared throttle wording) emits upstream_429 → moved', async () => {
  const a = await firstAttemptFor(429, '{"type":"error","error":{"type":"rate_limit_error","message":"Anthropic is temporarily limiting requests"}}');
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(upstream_429\) on "a1" — server-side throttle, retry-after 5s → moved$/);
});

test('529 overload emits upstream_529 → moved', async () => {
  const a = await firstAttemptFor(529, '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(upstream_529\) on "a1" — overloaded, retry-after 5s → moved$/);
});

test('retriable 5xx emits upstream_<status> → moved', async () => {
  const a = await firstAttemptFor(502, '{"type":"error","error":{"type":"api_error","message":"bad gateway"}}');
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(upstream_502\) on "a1" — retriable upstream status, cooling down → moved$/);
});

test('OAuth token refresh failure emits token_refresh → moved', async () => {
  const a = await firstAttemptFor(200, '{}', am => {
    const real = am.ensureTokenFresh.bind(am);
    am.ensureTokenFresh = async (i, ...rest) => (i === 0 ? false : real(i, ...rest));
  });
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(token_refresh\) on "a1" — OAuth token refresh unavailable → moved$/);
});
