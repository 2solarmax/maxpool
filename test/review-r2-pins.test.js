// Red-team round 2 pins (task-2026-11-09-maxpool-retry-before-move): request-scoped
// faults never evict held conversations (A), refusal reroute after the keep-alive (B),
// "real bytes" means a real body byte (D), the once-only give-up line (E), and the link
// close-listener hygiene (F).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';
import { ReadableStream } from 'node:stream/web';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));
const tok = req => String(req.headers.authorization || '').replace('Bearer ', '');
const json = (res, status, obj, h = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(obj)); };

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}

const mgr = (n = 2, extra = {}) => new AccountManager(Array.from({ length: n }, (_, i) => ({
  name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
})), 0.9, extra);

const TTFB = (am, i = 0) => am.markTransientFailure(i, 'UPSTREAM_TTFB', { network: true, scope: 'request' });
const pick = (am, info) => { const l = am.acquireAccount({ profile: 'claude', ...info }); const name = l?.account?.name ?? null; if (l) am.releaseAccount(l); return name; };

// ---------------------------------------------------------------- A: request-scoped faults

for (const mode of ['sticky', 'balance']) {
  const held = mode === 'sticky' ? { sessionKey: 'H' } : { affinityKey: 'H' };
  const cold = mode === 'sticky' ? { sessionKey: 'N' } : { affinityKey: 'N' };

  test(`A (${mode}): one request-scoped TTFB by ANOTHER request keeps held H on a1; only new placements skip a1`, () => {
    const am = mgr(2, { routingMode: mode });
    am.accounts[1].activeWeight = 30;   // a1 is the natural pick for ANY request
    assert.equal(pick(am, held), 'a1', 'control: H is placed on a1');
    assert.equal(pick(am, mode === 'sticky' ? { sessionKey: 'N0' } : { affinityKey: 'N0' }), 'a1', 'control: a cold pick lands on a1 too');
    TTFB(am);
    assert.equal(pick(am, held), 'a1', 'H stays on its account');
    assert.equal(pick(am, cold), 'a2', 'a cold pick is deprioritised off a1');
    assert.equal(am.accounts[0].consecutiveFailures, 0, 'no streak');
    assert.ok(!am.accounts[0].cooldownUntil || am.accounts[0].cooldownUntil <= Date.now(), 'no account cooldown');
    // The reviewer's probe: the account-scoped shape (old behaviour) evicts H.
    const am2 = mgr(2, { routingMode: mode });
    am2.accounts[1].activeWeight = 30;
    assert.equal(pick(am2, held), 'a1');
    am2.markTransientFailure(0, 'UPSTREAM_TTFB', { network: true });
    assert.equal(pick(am2, held), 'a2', 'control: an account-scoped fault releases H');
  });

  test(`A (${mode}): 3 consecutive request-scoped faults escalate to an account fault (H released), logged once`, async () => {
    const am = mgr(2, { routingMode: mode });
    assert.equal(pick(am, held), 'a1');
    const lines = await captureLog(() => { TTFB(am); TTFB(am); });
    assert.equal(pick(am, held), 'a1', 'two in a row: still request-scoped');
    assert.equal(lines.filter(l => l.includes('treating as an ACCOUNT fault')).length, 0);
    const more = await captureLog(() => { TTFB(am); TTFB(am); });
    assert.equal(pick(am, held), 'a2', 'third in a row: held conversation released');
    assert.equal(more.filter(l => l.includes('request-scoped faults in a row') && l.includes('"a1"')).length, 1, more.join('\n'));
    assert.ok(am.accounts[0].consecutiveFailures >= 1, 'escalation feeds the failures gate');
  });

  test(`A (${mode}): a success between request-scoped faults resets the count`, () => {
    const am = mgr(2, { routingMode: mode });
    assert.equal(pick(am, held), 'a1');
    TTFB(am); TTFB(am);
    const l = am.acquireAccount({ profile: 'claude', ...held });
    assert.equal(l.account.name, 'a1');
    am.releaseAccount(l, { success: true, status: 200 });
    assert.equal(am.accounts[0].requestFaultStreak, 0, 'reset on success');
    assert.equal(am.accounts[0].softCooldownUntil, null, 'success also ends the soft cooldown for new placements');
    TTFB(am); TTFB(am);
    assert.equal(pick(am, held), 'a1', 'the count restarted: 2 in a row, not 4');
  });
}

test('A: a soft-cooled account is deprioritised, never benched — the only route still serves a cold pick', () => {
  const am = mgr(1);
  TTFB(am);
  assert.equal(pick(am, { sessionKey: 'N' }), 'a1');
});

test('A: the retry-same hint is a held conversation — it keeps a soft-cooled a1 even with no affinity key', () => {
  const am = mgr(2, { routingMode: 'balance' });
  am.accounts[1].activeWeight = 30;
  TTFB(am);
  assert.equal(pick(am, {}), 'a2', 'control: a keyless cold pick skips a1');
  assert.equal(pick(am, { retrySameAccountName: 'a1' }), 'a1');
});

test('A: the escalation line is logged once per RUN — a success re-arms it', async () => {
  const am = mgr(2);
  const l = am.acquireAccount({ profile: 'claude', sessionKey: 'S' }, new Set([1]));
  assert.equal(l.account.name, 'a1');
  const lines = await captureLog(() => {
    TTFB(am); TTFB(am); TTFB(am); TTFB(am);
    am.releaseAccount(l, { success: true, status: 200 });   // a1 answers a request in flight
    TTFB(am); TTFB(am); TTFB(am);
  });
  assert.equal(lines.filter(l => l.includes('request-scoped faults in a row')).length, 2, lines.join('\n'));
});

test('A: the soft cooldown expires', () => {
  const am = mgr(2, { routingMode: 'balance' });
  TTFB(am);
  am.accounts[0].softCooldownUntil = Date.now() - 1;
  assert.equal(pick(am, { affinityKey: 'N' }), 'a1');
});

// ---------------------------------------------------------------- B: refusal reroute after the keep-alive

const REFUSAL_SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_r","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}\n\n'
  + 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction"}},"usage":{"output_tokens":0}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
const PROVIDER_SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_p","model":"glm-5.3","usage":{"input_tokens":10,"output_tokens":0}}}\n\n'
  + 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"provider answered"}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

for (const delay of [0, 1000]) {
  test(`B: a refused streaming turn reroutes to the provider at upstream delay ${delay}ms (grace 300ms)`, async () => {
    let call = 0;
    const up = http.createServer((req, res) => {
      req.resume();
      call += 1;
      const n = call;
      const t = setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(n === 1 ? REFUSAL_SSE : PROVIDER_SSE); }, n === 1 ? delay : 0);
      res.on('close', () => clearTimeout(t));
    });
    const upPort = await listen(up);
    const am = new AccountManager([
      { name: 'anth1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
      { name: 'glm1', type: 'provider', provider: 'zai', profiles: ['all'], accessToken: 'k', refreshToken: null, expiresAt: null, model: 'glm-5.3' },
    ], 0.9, { routingMode: 'balance' });
    am.accounts[1].activeWeight = 50;   // anth1 is the first pick
    const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 300 } });
    const port = await listen(proxy);
    try {
      let text = '';
      const lines = await captureLog(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
          body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });
        text = await r.text();
      });
      assert.equal(call, 2, `rerouted once:\n${lines.join('\n')}`);
      assert.ok(text.includes('provider answered'), text.slice(0, 300));
      assert.ok(!text.includes('"refusal"'), 'the refusal never reaches the client');
      if (delay > 0) assert.ok(text.indexOf('event: ping') >= 0 && text.indexOf('event: ping') < text.indexOf('msg_p'), 'the keep-alive had committed first');
      assert.deepEqual(attempts(lines), ['[Maxpool] attempt failed (safeguard_refusal) on "anth1" — reasoning_extraction; rerouting to a provider → moved']);
    } finally { await close(proxy); await close(up); }
  });
}

// B (eligibility): a re-forward AFTER the keep-alive committed (529 on anth1 at 1s) must
// still arm the refusal hold on anth2 — the eligibility latch reads real bytes, not headers.
test('B: a refusal on the account a slow 529 moved to (keep-alive committed) still reroutes', async () => {
  const hits = [];
  const up = http.createServer((req, res) => {
    req.resume();
    const t = tok(req); hits.push(t);
    if (t === 't1') {
      const h = setTimeout(() => json(res, 529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }), 1000);
      res.on('close', () => clearTimeout(h));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(t === 't2' ? REFUSAL_SSE : PROVIDER_SSE);
  });
  const upPort = await listen(up);
  const am = new AccountManager([
    { name: 'anth1', type: 'oauth', accessToken: 't1', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'anth2', type: 'oauth', accessToken: 't2', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'glm1', type: 'provider', provider: 'zai', profiles: ['all'], accessToken: 'k', refreshToken: null, expiresAt: null, model: 'glm-5.3' },
  ], 0.9, { routingMode: 'balance' });
  am.accounts[1].activeWeight = 20; am.accounts[2].activeWeight = 60;   // anth1 → anth2 → glm1
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 300 } });
  const port = await listen(proxy);
  try {
    let text = '';
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-maxpool-profile': 'all' },
        body: JSON.stringify({ model: 'claude-opus-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
      });
      text = await r.text();
    });
    assert.deepEqual(hits, ['t1', 't2', 'k'], lines.join('\n'));
    assert.ok(text.includes('provider answered'), text.slice(0, 300));
    assert.ok(!text.includes('"refusal"'));
  } finally { await close(proxy); await close(up); }
});

// ---------------------------------------------------------------- D: first REAL body byte

test('D: streamResponse never leaves the keep-alive running — an empty 2xx body stops it', async () => {
  const { __serverTest } = await import('../src/server.js');
  const { EventEmitter } = await import('node:events');
  const sink = Object.assign(new EventEmitter(), { headersSent: true, destroyed: false, writableEnded: false,
    writeHead() {}, write: () => true, end() { this.writableEnded = true; } });
  const requestInfo = { stream: true, queueHeartbeatActive: true, queueHeartbeatTimer: setInterval(() => {}, 60_000).unref() };
  const empty = new ReadableStream({ start(c) { c.close(); } });
  await __serverTest.streamResponse(empty, sink, 200, {}, 0, mgr(1), null, requestInfo);
  assert.equal(requestInfo.queueHeartbeatActive, false);
  assert.equal(requestInfo.queueHeartbeatTimer, null);
});

for (const grace of [300, 20_000]) {
  test(`D: upstream sends headers then dies before any body byte → moved to a2 (grace ${grace}ms)`, async () => {
    const hits = [];
    const up = http.createServer((req, res) => {
      req.resume();
      hits.push(tok(req));
      if (tok(req) === 't1') {
        const t = setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.flushHeaders();
          setTimeout(() => req.socket.destroy(), 100);
        }, 500);
        res.on('close', () => clearTimeout(t));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_a2"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const upPort = await listen(up);
    const am = mgr(2);
    const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: grace, heartbeatMs: 1000 } });
    const port = await listen(proxy);
    try {
      let text = '';
      const lines = await captureLog(async () => {
        const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }),
        });
        text = await r.text();
      });
      assert.deepEqual(hits, ['t1', 't2'], lines.join('\n'));
      assert.ok(text.includes('msg_a2'), `${text.slice(0, 300)}\n${lines.join('\n')}`);
      assert.ok(!text.includes('event: error'), text.slice(0, 300));
      const a = attempts(lines);
      assert.equal(a.length, 1, a.join('\n'));
      assert.match(a[0], /on "a1" — transient after [\d.]+s → moved$/);
    } finally { await close(proxy); await close(up); }
  });
}

test('D (link): a held link stream keeps its keep-alive until the first real chunk, never after', async () => {
  const STATUS = { accounts: [
    { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
    { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  ] };
  let n = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, STATUS);
    req.resume();
    n += 1;
    if (n <= 2) return json(res, 503, {}, { 'retry-after': '1' });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"type":"message_start"}\n\n');
    const t = setTimeout(() => res.end('data: {"type":"message_stop"}\n\n'), 1500);
    res.on('close', () => clearTimeout(t));
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, capacityMaxWaitMs: 8000, pollMs: 50, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  try {
    let text = '';
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      text = await r.text();
    });
    const firstReal = text.indexOf('data: {"type"');
    assert.ok(firstReal > 0 && text.slice(0, firstReal).includes('event: ping'), `held first:\n${text.slice(0, 300)}`);
    assert.ok(text.includes('message_stop'), text.slice(0, 300));
    assert.ok(!text.slice(firstReal).includes('event: ping'), `no ping after the first real chunk:\n${text}`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});

// ---------------------------------------------------------------- E: once-only give-up line

test('E: a queue-ENABLED decline (window 0) prints exactly one surfaced line for the attempt', async () => {
  const up = http.createServer((req, res) => { req.resume(); json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { 'retry-after': '30' }); });
  const upPort = await listen(up);
  const proxy = createProxyServer(mgr(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, nonStreamMaxWaitMs: 0, capacityMaxWaitMs: 0, maxWaitMs: 0, pollMs: 20 } });
  const port = await listen(proxy);
  try {
    let status = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }) });
      status = r.status; await r.text();
    });
    assert.equal(status, 429);
    const final = lines.filter(l => /→ surfaced$/.test(l) && (l.startsWith('[Maxpool] attempt failed (') || l.startsWith('[Maxpool] hold gave up')));
    assert.equal(final.length, 1, lines.join('\n'));
  } finally { await close(proxy); await close(up); }
});

test('E: a non-streaming hold that commits then expires prints exactly one hold-gave-up line', async () => {
  const up = http.createServer((req, res) => { req.resume(); json(res, 429, { type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }, { 'retry-after': '30' }); });
  const upPort = await listen(up);
  const proxy = createProxyServer(mgr(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, nonStreamMaxWaitMs: 600, capacityMaxWaitMs: 600, pollMs: 50 } });
  const port = await listen(proxy);
  try {
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', messages: [] }) });
      await r.text();
    });
    assert.equal(lines.filter(l => l.startsWith('[Maxpool] hold gave up')).length, 1, lines.join('\n'));
    assert.equal(lines.filter(l => /→ surfaced$/.test(l)).length, 1, lines.join('\n'));
  } finally { await close(proxy); await close(up); }
});

// ---------------------------------------------------------------- F: link close listeners

test('F: link hops detach their close listener — a 3-hop link chain leaves none behind', async () => {
  const STATUS = { accounts: [
    { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
    { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  ] };
  let n = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, STATUS);
    req.resume();
    n += 1;
    if (n <= 2) { req.socket.destroy(); return; }
    json(res, 200, { id: 'msg_link_ok' });
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, capacityMaxWaitMs: 8000, networkMaxWaitMs: 60_000, pollMs: 50 } });
  let atStart = -1; let atFinish = -1;
  proxy.on('request', (_req, res) => {
    atStart = res.listenerCount('close');
    res.on('finish', () => { atFinish = res.listenerCount('close'); });
  });
  const port = await listen(proxy);
  try {
    let text = '';
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      text = await r.text();
    });
    assert.ok(text.includes('msg_link_ok'), text.slice(0, 200));
    assert.equal(n, 3, 'three link hops');
    // Only the serving hop's own listener may still be attached when the body finishes.
    assert.ok(atFinish <= atStart + 1, `close listeners: start=${atStart} finish=${atFinish}`);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});

// ---------------------------------------------------------------- post-rejection repair (coordinator 2026-11-09)

const MCP_WORDING = "messages.1.content.2: Input tag 'mcp_tool_use' found using 'type' does not match any of the expected tags: 'text', 'tool_use', 'server_tool_use', 'thinking'";

async function mcpRig(messages, session) {
  const bodies = [];
  const up = http.createServer((req, res) => {
    let b = ''; req.on('data', c => { b += c; });
    req.on('end', () => {
      bodies.push(b);
      if (b.includes('mcp_tool_use')) return json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: MCP_WORDING } });
      json(res, 200, { id: 'msg_ok', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } });
    });
  });
  const upPort = await listen(up);
  const am = mgr(1);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    let status = 0; let text = '';
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-maxpool-session': session }, body: JSON.stringify({ model: 'claude-opus-5-5', max_tokens: 16, messages }) });
      status = r.status; text = await r.text();
    });
    return { am, bodies, lines, status, text };
  } finally { await close(proxy); await close(up); }
}

test('repair: nothing convertible (GLM call_N id collides with a client tool_use; valid Claude thinking) → no retry, no session mark, the original 400 surfaced', async () => {
  // collectForeignServerToolIds drops the colliding id, so neither the up-front strip
  // nor the post-rejection repair can convert it; stripping the thinking cannot cure an
  // mcp-tag 400. Before this fix: removed the thinking, retried into the same 400 and
  // latched the session to strip thinking on every later turn.
  const { am, bodies, lines, status, text } = await mcpRig([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'c2ln' },
      { type: 'tool_use', id: 'call_0', name: 'Read', input: {} },
      { type: 'mcp_tool_use', id: 'call_0', name: 'search', server_name: 'docs', input: {} },
    ] },
    { role: 'user', content: [
      { type: 'tool_result', tool_use_id: 'call_0', content: 'ok' },
      { type: 'mcp_tool_result', tool_use_id: 'call_0', content: [] },
    ] },
  ], 'sess-collide');
  assert.equal(bodies.length, 1, `one upstream call, no identical retry:\n${lines.join('\n')}`);
  assert.equal(status, 400);
  assert.ok(text.includes("Input tag 'mcp_tool_use'"), 'the original upstream 400 body');
  assert.equal(am.isSessionThinkingContaminated('sess-collide'), false, 'session left unmarked');
  assert.deepEqual(attempts(lines), ['[Maxpool] attempt failed (transcript_rejected) on "a1" — Anthropic rejected the transcript; nothing convertible to repair → surfaced']);
});

test('repair: a convertible foreign mcp pair is converted (thinking + tools) and served on Claude in ONE call — never a rejected round-trip', async () => {
  // The converted>0 case: detectTranscriptOrigin flags exactly the converter's id set,
  // so the up-front strip converts it before the first send.
  const { bodies, status, lines } = await mcpRig([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'glm plan', signature: 'glmhex' },
      { type: 'mcp_tool_use', id: 'call_7', name: 'search', server_name: 'docs', input: {} },
    ] },
    { role: 'user', content: [{ type: 'mcp_tool_result', tool_use_id: 'call_7', content: [{ type: 'text', text: 'r' }] }, { type: 'text', text: 'next' }] },
  ], 'sess-conv');
  assert.equal(status, 200, lines.join('\n'));
  assert.equal(bodies.length, 1);
  assert.ok(!bodies[0].includes('mcp_tool_use'), 'converted before the first send');
  assert.deepEqual(attempts(lines), []);
});

// ================================================================ review round 3

test('R3-1: a stalled non-streaming body is request-scoped like TTFB/IDLE; resets/DNS stay account-scoped', async () => {
  const { __serverTest } = await import('../src/server.js');
  const f = __serverTest.isRequestScopedTimeout;
  for (const code of ['UPSTREAM_TTFB', 'UPSTREAM_IDLE', 'UPSTREAM_BODY']) assert.equal(f({ code }), true, code);
  for (const code of ['ECONNRESET', 'ENOTFOUND', 'UND_ERR_SOCKET', undefined]) assert.equal(f({ code }), false, String(code));
});

test('R3-2: direct path — no ping after the first real chunk, none inside a partial event (heartbeat-committed, late first chunk)', async () => {
  const MS = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x","model":"claude-opus-5-5","usage":{"input_tokens":1,"output_tokens":0}}}\n\n'
    + 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
  const up = http.createServer((req, res) => {
    req.resume();
    const timers = [];
    timers.push(setTimeout(() => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); }, 600));
    timers.push(setTimeout(() => res.write(MS), 1800));                                                  // late first real chunk
    timers.push(setTimeout(() => res.write('event: content_block_delta\ndata: {"type":"content_block_d'), 2000));  // partial event
    timers.push(setTimeout(() => res.write('elta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'), 4500));
    timers.push(setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 7000));
    res.on('close', () => timers.forEach(clearTimeout));
  });
  const upPort = await listen(up);
  const proxy = createProxyServer(mgr(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 200, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  try {
    let text = '';
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [{ role: 'user', content: 'hi' }] }) });
      text = await r.text();
    });
    const firstReal = text.indexOf('event: message_start');
    assert.ok(firstReal > 0 && text.slice(0, firstReal).includes('event: ping'), `keep-alive committed first:\n${text.slice(0, 200)}`);
    assert.ok(text.includes('message_stop'), text);
    assert.equal((text.slice(firstReal).match(/event: ping/g) || []).length, 0, `no ping after the first real chunk:\n${text}`);
    assert.ok(text.includes('{"type":"content_block_delta","index":0'), 'the split event arrives whole');
    // E07: a stray stream-forward grace timer must not survive the body loop — it would
    // fire after the stream ended, see headersSent and tear down bookkeeping. Wait out
    // the grace window: no late ping may arrive.
    await new Promise(r => setTimeout(r, 2500));
    assert.equal((text.slice(firstReal).match(/event: ping/g) || []).length, 0, `no late grace-timer ping:\n${text}`);
  } finally { await close(proxy); await close(up); }
});

test('R3-3: a link that answers headers then goes silent is cut at the link idle bound (no real byte → failover)', async () => {
  const STATUS = { accounts: [
    { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
    { name: 'personal', type: 'oauth', accountUuid: 'U2', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } },
  ] };
  let n = 0;
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, STATUS);
    req.resume();
    n += 1;
    if (n === 1) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders(); return; }   // headers, then silence
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_row2"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 200, heartbeatMs: 1000 } });
  const port = await listen(proxy);
  const prev = process.env.MAXPOOL_LINK_IDLE_MS;
  process.env.MAXPOOL_LINK_IDLE_MS = '2500';
  try {
    let text = ''; const t0 = Date.now(); let elapsed = 0;
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      text = await r.text(); elapsed = Date.now() - t0;
    });
    assert.equal(n, 2, lines.join('\n'));
    assert.ok(text.includes('msg_row2'), `${text.slice(0, 300)}\n${lines.join('\n')}`);
    assert.ok(elapsed >= 2300 && elapsed < 8000, `cut at the bound, not undici's 300s: ${elapsed}ms`);
    const firstReal = text.indexOf('event: message_start');
    assert.ok(!text.slice(firstReal).includes('event: ping'), 'no ping after the real body');
    const a = attempts(lines);
    assert.equal(a.length, 1, a.join('\n'));
    // D6 (2026-11-12): the line also names the error code and the stream flag.
    assert.match(a[0], /\(link_idle\) on ".* ☁" — HTTP 200 after [\d.]+s \(link body idle timeout\) \[UPSTREAM_IDLE, streaming\] → moved$/);
    assert.deepEqual(am.accounts.map(x => x.inFlight), am.accounts.map(() => 0), 'every lease released');
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_LINK_IDLE_MS; else process.env.MAXPOOL_LINK_IDLE_MS = prev;
    am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream);
  }
});

// M2/E07: a link that dies INSIDE the grace window, failing over to a slow direct hop.
test('M2: link body dies inside the grace window → failover hop keeps its pings, no ERR_HTTP_HEADERS_SENT', async () => {
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, { accounts: [
      { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } }] });
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    setTimeout(() => res.socket.destroy(), 300);
  });
  const remotePort = await listen(remote);
  const up = http.createServer((req, res) => {   // the DIRECT hop-2 upstream: headers now, body at 4.5s
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const t = setTimeout(() => res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_direct"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'), 4500);
    res.on('close', () => clearTimeout(t));
  });
  const upPort = await listen(up);
  const am = mgr(1);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 1500, heartbeatMs: 500 } });
  const port = await listen(proxy);
  try {
    let text = '';
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      text = await r.text();
    });
    assert.ok(text.includes('msg_direct'), `${text.slice(0, 300)}\n${lines.join('\n')}`);   // lines: ${lines.join(' | ')}
    assert.ok(!lines.some(l => l.includes('ERR_HTTP_HEADERS_SENT')), lines.join('\n'));
    const firstReal = text.indexOf('event: message_start');
    assert.ok(firstReal >= 0, text.slice(0, 200));
    assert.ok(!text.slice(firstReal).includes('event: ping'), 'no ping after the first real byte');
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(up); }
});

// M1: pings must never land inside the real stream, even when the grace timer already
// fired before the first real chunk.
test('M1: link silent past the grace window, then a real chunk → zero pings after it', async () => {
  const STATUS = { accounts: [
    { name: 'reports@gomokka.com', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: { unified5h: 0.1, unified7d: 0.2 } }] };
  const remote = http.createServer((req, res) => {
    if (req.url === '/maxpool/status') return json(res, 200, STATUS);
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.flushHeaders();
    const timers = [];
    timers.push(setTimeout(() => res.write('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_x"}}\n\n'), 1900));   // past the 200ms grace
    timers.push(setTimeout(() => res.write('event: content_block_delta\ndata: {"type":"content_block_d'), 2100));
    timers.push(setTimeout(() => res.write('elta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n'), 3300));
    timers.push(setTimeout(() => res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'), 4200));
    res.on('close', () => timers.forEach(clearTimeout));
  });
  const remotePort = await listen(remote);
  const upstream = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const upPort = await listen(upstream);
  const am = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${remotePort}`, key: 'mp-max' });
  await link.poll();
  am.setPoolLinks([link]);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false, streamForwardGraceMs: 200, heartbeatMs: 500 } });
  const port = await listen(proxy);
  try {
    let text = '';
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'claude-opus-5-5', stream: true, messages: [] }) });
      text = await r.text();
    });
    const firstReal = text.indexOf('event: message_start');
    assert.ok(firstReal > 0, text.slice(0, 200));
    assert.ok(text.slice(0, firstReal).includes('event: ping'), 'the grace timer committed the keep-alive first');
    assert.equal((text.slice(firstReal).match(/event: ping/g) || []).length, 0, `no ping after the first real chunk:\n${text}`);
    assert.ok(text.includes('message_stop'), text);
  } finally { am.setPoolLinks([]); await close(proxy); await close(remote); await close(upstream); }
});

// R3-5: a soft-cooled HOME at better priority still wins return-home.
function homeRig(prio) {
  const m = new AccountManager(['a1', 'a2'].map(n => ({ name: n, type: 'oauth', accessToken: n, refreshToken: n, expiresAt: Date.now() + 3600_000 })), 0.9,
    { routingMode: 'balance', crossProviderFallbackPolicy: 'always' });
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const ri = { sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000, profile: 'all' };
  const by = n => m.accounts.find(a => a.name === n);
  m._noteConversationAccount(ri, by('a1'));
  m._noteConversationAccount(ri, by('glm'));          // a GLM detour: home is a1
  const base = m._effectivePriority.bind(m);
  m._effectivePriority = (acc, r, now) => (acc.name === 'a1' ? prio.a1 : acc.name === 'a2' ? prio.a2 : base(acc, r, now));
  m.markTransientFailure(by('a1').index, 'UPSTREAM_TTFB', { network: true, scope: 'request' });   // home soft-cooled
  return { m, ri, glm: by('glm') };
}

test('R3-5: home a1 (priority 0, soft-cooled) vs a2 (priority 1) → the turn returns home, switched', () => {
  const { m, ri, glm } = homeRig({ a1: 0, a2: 1 });
  let lease;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { lease = m.acquireAccount(ri, new Set([glm.index])); } finally { console.log = orig; }
  assert.equal(lease.account.name, 'a1', logs.join('\n'));
  assert.equal(lease.returnedHome, true);
  assert.equal(lease.returnedHomeSwitched, true);
});

test('R3-5: a soft-cooled home that cannot win names the soft cooldown — never an outscored line', () => {
  const { m, ri, glm } = homeRig({ a1: 2, a2: 1 });
  let lease;
  const logs = []; const orig = console.log; console.log = (...a) => logs.push(a.join(' '));
  try { lease = m.acquireAccount(ri, new Set([glm.index])); } finally { console.log = orig; }
  assert.equal(lease.account.name, 'a2');
  const line = logs.find(l => l.includes('home=a1:')) || '';
  assert.match(line, /home=a1:skipped\(soft-cooled;priority-tier\)/, logs.join('\n'));
  assert.ok(!line.includes('outscored'), line);
});
