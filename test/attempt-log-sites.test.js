// D5 batch 3 (red-team r1 #5/#6/#7/#9): every failed attempt prints exactly ONE
// `attempt failed` line whose token is decided AFTER the outcome is known, at the sites
// the reviewer found silent, plus pins for the queued sites and the link grace timer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

const oauth = (n, extra = {}) => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
})), 0.9, extra);

async function direct(am, handler, { queue = { enabled: false }, body, headers = {}, retry } = {}) {
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; }); req.on('end', () => handler(req, res, b));
  });
  const upPort = await listen(up);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue, ...(retry ? { retry } : {}) });
  const port = await listen(proxy);
  let status = 0; let text = '';
  try {
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers },
        body: body || JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'hi' }] }),
      });
      status = r.status; text = await r.text();
    });
    return { lines, status, text };
  } finally { await close(proxy); await close(up); }
}

const tok = req => String(req.headers.authorization || '').replace('Bearer ', '');
const json = (res, status, obj, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };
const OK = { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

// ---------------------------------------------------------------- #5 queued vs surfaced

test('#5: a hold that commits then gives up prints ONE queued attempt line + a hold-gave-up line, never an attempt surfaced', async () => {
  const { lines } = await direct(oauth(1), (req, res) => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { 'retry-after': '30' }),
    { queue: { enabled: true, nonStreamMaxWaitMs: 800, capacityMaxWaitMs: 800, pollMs: 50 } });
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(rate_limited\) on "a1" — HTTP 429, benched 30s; no other route → queued$/);
  assert.ok(lines.some(l => l === '[Maxpool] hold gave up for the (rate_limited) attempt on "a1" → surfaced'), lines.join('\n'));
});

// #9: the request-wide server-side 429 → queued (shared throttle opened).
test('#9: every account returns the same server-side 429 → the last attempt is queued (request-wide)', async () => {
  const { lines } = await direct(oauth(2), (req, res) => json(res, 429,
    { type: 'error', error: { type: 'rate_limit_error', message: 'Anthropic is temporarily limiting requests' } }, { 'retry-after': '5' }),
  { queue: { enabled: true, nonStreamMaxWaitMs: 600, capacityMaxWaitMs: 600, pollMs: 50 } });
  const a = attempts(lines);
  assert.ok(a.some(l => /\(upstream_429\) on "a\d" — request-wide server-side throttle → queued$/.test(l)), a.join('\n'));
  assert.ok(!a.some(l => l.endsWith('→ surfaced')), a.join('\n'));
});

// #9: 529 with no other route → queued.
test('#9: a 529 on the only route is queued (no-route), one line', async () => {
  let n = 0;
  const { lines, status } = await direct(oauth(1), (req, res) => {
    n++;
    if (n === 1) return json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, { 'retry-after': '1' });
    return json(res, 200, OK);
  }, { queue: { enabled: true, nonStreamMaxWaitMs: 6000, capacityMaxWaitMs: 6000, pollMs: 50 } });
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(upstream_529\) on "a1" — (overloaded; no other route|request-wide overload — shared throttle opened) → queued$/);
  assert.equal(status, 200, 'the hold recovered');
});

// ---------------------------------------------------------------- #6 silent sites

test('#6: direct request-shape refusal → moved to the apikey row', async () => {
  const BARE = { type: 'error', error: { type: 'rate_limit_error', message: 'Error' }, request_id: 'req_x' };
  const keyUp = http.createServer((req, res) => { req.resume(); req.on('end', () => json(res, 200, OK)); });
  const keyPort = await listen(keyUp);
  const mk = n => ({ name: n, type: n.startsWith('o') ? 'oauth' : 'apikey', apiKey: 'sk-ant-x', accountUuid: `U-${n}` });
  const am = new AccountManager([mk('o1'), { ...mk('k1'), upstream: `http://127.0.0.1:${keyPort}` }], 0.9, { routingMode: 'balance' });
  am.accounts[1].activeWeight = 50;   // o1 is the natural first pick
  try {
    const { lines, status } = await direct(am, (req, res) => json(res, 429, BARE), {
      body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, system: [{ type: 'text', text: 'You are a precise assistant.' }], messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(status, 200);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(request_shape_refused\) on "o1" — subscription refused the request shape \(not Claude Code\) → moved$/);
  } finally { await close(keyUp); }
});

test('#6: direct request-shape refusal with no serving route → surfaced', async () => {
  const BARE = { type: 'error', error: { type: 'rate_limit_error', message: 'Error' }, request_id: 'req_x' };
  const mk = n => ({ name: n, type: 'oauth', apiKey: 'sk-x', accountUuid: `U-${n}` });
  const am = new AccountManager([mk('o1'), mk('o2')], 0.9, { routingMode: 'balance' });
  const { lines, status } = await direct(am, (req, res) => json(res, 429, BARE), {
    body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 8, system: [{ type: 'text', text: 'You are a precise assistant.' }], messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(status, 429);
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(request_shape_refused\) on "o\d" — subscription refused the request shape; no route serves it → surfaced$/);
});

test('#6: transcript rejected by Anthropic → pinned to GLM → moved', async () => {
  const glm = http.createServer((req, res) => { req.resume(); req.on('end', () => json(res, 200, { ok: true, served: 'glm' })); });
  const glmPort = await listen(glm);
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000 }],
    0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  try {
    const { lines, status } = await direct(am, (req, res) => json(res, 400, { type: 'error', error: { type: 'invalid_request_error',
      message: "messages.9.content.3.server_tool_use.id: String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'" } }), {
      headers: { 'x-maxpool-profile': 'all', 'x-maxpool-session': 'heal-s', 'x-maxpool-zai-token': 'zg', 'x-maxpool-zai-base-url': `http://127.0.0.1:${glmPort}` },
      body: JSON.stringify({ model: 'claude-sonnet-test', messages: [{ role: 'user', content: 'go' }] }),
      retry: { maxAttemptsPerRequest: 3 },
    });
    assert.equal(status, 200);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(transcript_rejected\) on "claude" — Anthropic rejected the transcript; pinning to GLM\/Kimi → moved$/);
  } finally { await close(glm); }
});

// One Claude row with its OWN (good) upstream; prefer-glm makes the provider the
// first pick, the provider 400s, and the pinned-to-Claude retry must land on the row.
function providerRig(errBody) {
  return async () => {
    const zai = http.createServer((req, res) => { req.resume(); req.on('end', () => json(res, 400, errBody)); });
    const zaiPort = await listen(zai);
    const claude = http.createServer((req, res) => { req.resume(); req.on('end', () => json(res, 200, OK)); });
    const claudePort = await listen(claude);
    const prov = { name: 'zai-1', type: 'provider', provider: 'zai', authToken: 'z', upstream: `http://127.0.0.1:${zaiPort}`,
      authHeader: 'authorization', profiles: ['all'], modelMap: { default: 'glm-5.3' }, stripBetaHeaders: true };
    const am = new AccountManager([prov, { name: 'claude', type: 'oauth', accessToken: 'tc', refreshToken: 'rc', expiresAt: Date.now() + 3600_000, upstream: `http://127.0.0.1:${claudePort}` }],
      0.9, { routingMode: 'prefer-zai', crossProviderFallbackPolicy: 'when-exhausted' });
    am.accounts[1].quota = { unified5h: 0.10, unified7d: 0.10 };   // prefer-zai: the provider is home (priority 0), claude serves the pinned retry
    let lines = []; let status = 0; let text = '';
    const orig = console.log;
    console.log = (...a) => lines.push(a.join(' '));
    try {
      const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1', queue: { enabled: false }, retry: { maxAttemptsPerRequest: 4 } });
      const port = await listen(proxy);
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-profile': 'all', 'x-maxpool-session': 'big-s' },
          body: JSON.stringify({ model: 'claude-opus-5-5', messages: [{ role: 'user', content: 'go' }] }),
        });
        status = r.status; text = await r.text();
      } finally { await close(proxy); }
    } finally { console.log = orig; await close(zai); await close(claude); }
    return { lines, status, text };
  };
}

test('#6: provider context too small → pinned to Claude → moved', async () => {
  const { lines, status } = await providerRig({ error: { message: 'exceeded model token limit: 262144 (requested: 643557)' } })();
  assert.equal(status, 200, lines.join('\n'));
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(provider_context_too_small\) on "zai-1" — request exceeds the provider context; pinning to Claude → moved$/);
});

test('#6: provider rejects the request shape ([1210]) → retried on Claude → moved', async () => {
  const { lines, status } = await providerRig({ error: { code: '1210', message: 'bad params' } })();
  assert.equal(status, 200, lines.join('\n'));
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(provider_shape_rejected\) on "zai-1" — provider will not take this body; retrying on Claude → moved$/);
});

test('#6: thinking-signature fail-safe → back to the issuer → moved', async () => {
  const am = oauth(2, { routingMode: 'balance' });
  const acquire = am.acquireAccount.bind(am);
  let n = 0;
  am.acquireAccount = (ri, ex) => {
    const l = acquire(ri, ex);
    if (++n === 1 && l) l.migratedFromName = l.account.name === 'a1' ? 'a2' : 'a1';
    return l;
  };
  let first = null;
  const { lines, status } = await direct(am, (req, res) => {
    if (!first) { first = tok(req); return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages.3.content.0: Invalid `signature` in `thinking` block' } }); }
    json(res, 200, OK);
  }, { headers: { 'x-maxpool-session': 'sig-s' } });
  assert.equal(status, 200, lines.join('\n'));
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /\(invalid_thinking_signature\) on "a\d" — migrated replay rejected; back to issuer "a\d" → moved$/);
});

// ---------------------------------------------------------------- link sites

const STATUS = { accounts: [
  { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
] };

async function linkRig(onMsg, { queue = { enabled: false }, extraAccounts = [], upstreamHandler } = {}) {
  const hits = [];
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, STATUS);
    if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
    req.resume();
    hits.push(req.headers['x-maxpool-pin-account']);
    onMsg(req, res, hits.length);
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer(upstreamHandler || ((req, res) => { res.writeHead(500); res.end('{}'); }));
  const upPort = await listen(upstream);
  const am = new AccountManager(extraAccounts, 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue });
  const port = await listen(proxy);
  return { am, hits, port, cleanup: async () => { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); } };
}

const postLink = async (port, body) => {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
    body: JSON.stringify(body || { model: 'claude-opus-5-5', messages: [] }),
  });
  return { status: r.status, text: await r.text() };
};

test('#7 + #6: a slow-then-refused link turn still fails over after the keep-alive committed', async () => {
  // The linked pool refuses the shape at 2.5s — after the 1s grace committed the SSE
  // keep-alive (headersSent with only pings). A local apikey row can serve it.
  const keyUp = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_key"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); });
  });
  const keyPort = await listen(keyUp);
  const rig = await linkRig((req, res) => {
    const t = setTimeout(() => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'refused' } }, { 'x-maxpool-request-shape-refused': '1' }), 2500);
    res.on('close', () => clearTimeout(t));
  }, {
    queue: { enabled: true, streamForwardGraceMs: 1000 },
    extraAccounts: [{ name: 'key', type: 'apikey', apiKey: 'sk-ant-x', upstream: `http://127.0.0.1:${keyPort}` }],
  });
  rig.am.accounts.find(a => a.name === 'key').activeWeight = 80;   // a remote row is the first pick
  try {
    let out;
    const lines = await captureLog(async () => { out = await postLink(rig.port, { model: 'claude-opus-5-5', stream: true, messages: [] }); });
    assert.ok(out.text.includes('event: ping'), 'the keep-alive had committed before the refusal');
    assert.ok(out.text.includes('msg_key'), `failed over to the apikey row:\n${out.text.slice(0, 300)}\n${lines.join('\n')}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(request_shape_refused\) on ".* ☁" — linked pool refused the request shape \(not Claude Code\) → moved$/);
  } finally { await rig.cleanup(); await close(keyUp); }
});

test('#6: link answer >=400 on a held (queue-resumed) stream → surfaced', async () => {
  // Both rows 503 first (→ hold commits the keep-alive), then the resumed hop gets a 400.
  const rig = await linkRig((req, res, n) => {
    if (n <= 2) return json(res, 503, {}, { 'retry-after': '1' });
    json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } });
  }, { queue: { enabled: true, capacityMaxWaitMs: 8000, pollMs: 50, heartbeatMs: 1000 } });
  try {
    let out;
    const lines = await captureLog(async () => { out = await postLink(rig.port, { model: 'claude-opus-5-5', stream: true, messages: [] }); });
    const a = attempts(lines);
    assert.ok(a.some(l => /\(remote-400\) on ".* ☁" — linked pool answered an error on a held stream → surfaced$/.test(l)), `${a.join('\n')}\n${out.text.slice(0, 200)}`);
  } finally { await rig.cleanup(); }
});

test('#9: a link error on the last route is queued (and recovers), one line for that attempt', async () => {
  const rig = await linkRig((req, res, n) => {
    if (n <= 2) { req.socket.destroy(); return; }
    json(res, 200, { id: 'msg_link_ok' });
  }, { queue: { enabled: true, capacityMaxWaitMs: 8000, networkMaxWaitMs: 60_000, pollMs: 50 } });
  try {
    let out;
    const lines = await captureLog(async () => { out = await postLink(rig.port, { model: 'claude-opus-5-5', stream: true, messages: [] }); });
    assert.ok(out.text.includes('msg_link_ok'), `${out.text.slice(0, 200)}\n${lines.join('\n')}`);
    const a = attempts(lines);
    assert.ok(a.some(l => /\(pool_link_unreachable\) on ".* ☁" — no answer after .* → queued$/.test(l)), a.join('\n'));
    assert.ok(!a.some(l => l.endsWith('→ surfaced')), a.join('\n'));
  } finally { await rig.cleanup(); }
});

test('#9: the link grace timer is cleared once the link answers — a later hold keeps its heartbeat', async () => {
  // Both rows refuse at once (before the 2s grace deadline) → the request holds with
  // its own heartbeat (1s). A stale grace timer firing at 2s would see headersSent and
  // tear down the hold's heartbeat + ticket. Rows recover at ~4.5s.
  const t0 = Date.now();
  const rig = await linkRig((req, res) => {
    if (Date.now() - t0 < 4500) return json(res, 503, {}, { 'retry-after': '1' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_late"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }, { queue: { enabled: true, streamForwardGraceMs: 2000, heartbeatMs: 1000, capacityMaxWaitMs: 10_000, pollMs: 100 } });
  try {
    const out = await postLink(rig.port, { model: 'claude-opus-5-5', stream: true, messages: [] });
    assert.ok(out.text.includes('msg_late'), out.text.slice(0, 300));
    const pings = out.text.split('event: ping').length - 1;
    assert.ok(pings >= 3, `heartbeat kept ticking through the ~4.5s hold (got ${pings} pings)`);
  } finally { await rig.cleanup(); }
});

// ---------------------------------------------------------------- #7 class: direct gates after keep-alive

// Every pre-first-byte failover gate on the direct path reads clientHasRealBytes, not
// headersSent: a streaming turn whose upstream answers the failure AFTER the grace
// keep-alive committed (pings only) must still move — not fall to the queue.
async function slowFail(status, bodyObj, extraHeaders = {}) {
  const am = oauth(2);
  am.accounts[1].activeWeight = 5;   // a1 is the natural first pick
  const { lines, text } = await direct(am, (req, res) => {
    if (tok(req) === 't1') {
      const t = setTimeout(() => json(res, status, bodyObj, { 'retry-after': '5', ...extraHeaders }), 1500);
      res.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_a2"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }, { queue: { enabled: true, streamForwardGraceMs: 300, capacityMaxWaitMs: 3000, pollMs: 50 },
    body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
  return { a: attempts(lines), text };
}

for (const [label, status, bodyObj, kind] of [
  ['local 429', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, 'rate_limited'],
  ['server-side 429', 429, { type: 'error', error: { type: 'rate_limit_error', message: 'Anthropic is temporarily limiting requests' } }, 'upstream_429'],
  ['529', 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 'upstream_529'],
]) {
  test(`#7 class: a slow ${label} after the keep-alive committed still MOVES`, async () => {
    const { a, text } = await slowFail(status, bodyObj);
    assert.ok(text.includes('event: ping'), 'the keep-alive had committed');
    assert.ok(text.includes('msg_a2'), `served by a2:\n${text.slice(0, 300)}`);
    assert.equal(a.length, 1, a.join('\n'));
    assert.ok(a[0].includes(`(${kind}) on "a1"`) && a[0].endsWith('→ moved'), a[0]);
  });
}

// #4: the cancel line after the keep-alive committed (pings only) says still waiting.
test('#4: a client that leaves after only keep-alive pings is "still waiting", not "mid-response"', async () => {
  const up = http.createServer((req) => { req.resume(); /* never answers */ });
  const upPort = await listen(up);
  const proxy = createProxyServer(oauth(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`,
    queue: { enabled: true, streamForwardGraceMs: 200 } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const ctl = new AbortController();
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }), signal: ctl.signal,
      });
      const reader = r.body.getReader();
      const first = await reader.read();
      assert.ok(Buffer.from(first.value).toString().includes('event: ping'), 'only a ping went out');
      ctl.abort();
      await reader.read().catch(() => {});
      await new Promise(rs => setTimeout(rs, 400));
    });
    const left = lines.find(l => l.startsWith('[Maxpool] Client left after '));
    assert.ok(left && left.endsWith('(still waiting, nothing sent)'), `${left}\n${lines.join('\n')}`);
    assert.ok(attempts(lines).some(l => /client left after [\d.]+s \(still waiting\) → released-cancel$/.test(l)), attempts(lines).join('\n'));
  } finally { await close(proxy); await close(up); }
});

test('#6: link request-shape refusal with no serving route → surfaced', async () => {
  const rig = await linkRig((req, res) => json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'refused' } }, { 'x-maxpool-request-shape-refused': '1' }));
  try {
    let out;
    const lines = await captureLog(async () => { out = await postLink(rig.port); });
    assert.equal(out.status, 429);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(request_shape_refused\) on ".* ☁" — linked pool refused the request shape; no route serves it → surfaced$/);
  } finally { await rig.cleanup(); }
});

test('#7 class: a slow provider 403 after the keep-alive committed still MOVES', async () => {
  const zai = http.createServer((req, res) => {
    req.resume();
    if (String(req.headers.authorization || '').endsWith('zai-bad')) {
      const t = setTimeout(() => json(res, 403, { error: { type: 'permission_error', message: 'forbidden' } }), 1500);
      res.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_good"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const zaiPort = await listen(zai);
  const mk = (name, token) => ({ name, type: 'provider', provider: 'zai', authToken: token, upstream: `http://127.0.0.1:${zaiPort}`,
    authHeader: 'authorization', profiles: ['all'], priority: 10, modelMap: { default: 'glm-5.3' }, stripBetaHeaders: true });
  const am = new AccountManager([mk('zai-bad', 'zai-bad'), mk('zai-good', 'zai-good')], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  am.accounts[1].activeWeight = 5;   // zai-bad is the first pick
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: 'http://127.0.0.1:1',
    queue: { enabled: true, streamForwardGraceMs: 300, capacityMaxWaitMs: 3000, pollMs: 50 }, retry: { maxAttemptsPerRequest: 4 } });
  const port = await listen(proxy);
  try {
    let text = '';
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }),
      });
      text = await r.text();
    });
    assert.ok(text.includes('event: ping'), 'the keep-alive had committed');
    assert.ok(text.includes('msg_good'), `${text.slice(0, 300)}\n${lines.join('\n')}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(provider_403\) on "zai-bad" — HTTP 403 → moved$/);
  } finally { await close(proxy); await close(zai); }
});

test('#7 class: a slow direct request-shape refusal after the keep-alive committed still MOVES', async () => {
  const BARE = { type: 'error', error: { type: 'rate_limit_error', message: 'Error' }, request_id: 'req_x' };
  const keyUp = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_key"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); });
  });
  const keyPort = await listen(keyUp);
  const mk = n => ({ name: n, type: n.startsWith('o') ? 'oauth' : 'apikey', apiKey: 'sk-ant-x', accountUuid: `U-${n}` });
  const am = new AccountManager([mk('o1'), { ...mk('k1'), upstream: `http://127.0.0.1:${keyPort}` }], 0.9, { routingMode: 'balance' });
  am.accounts[1].activeWeight = 50;
  try {
    const { lines, text } = await direct(am, (req, res) => {
      const t = setTimeout(() => json(res, 429, BARE), 1500);
      res.on('close', () => clearTimeout(t));
    }, {
      queue: { enabled: true, streamForwardGraceMs: 300, capacityMaxWaitMs: 3000, pollMs: 50 },
      body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 8, system: [{ type: 'text', text: 'You are a precise assistant.' }], messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.ok(text.includes('event: ping'), 'the keep-alive had committed');
    assert.ok(text.includes('msg_key'), `${text.slice(0, 300)}\n${lines.join('\n')}`);
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    assert.match(a[0], /\(request_shape_refused\) on "o1" — .* → moved$/);
  } finally { await close(keyUp); }
});
