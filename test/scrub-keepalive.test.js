// Release B (batch 2) T8 / B9: a SCRUBBED provider stream must not go silent.
//
// GLM thinks for tens of seconds. The scrubber drops every thinking event, so the client
// (and the Mac's link idle timer) sees NOTHING between message_start and the first text.
// Claude Code reads that silence as a dead stream and falls back to a non-streaming retry
// (the failure behind the link give-ups). B9 writes `event: ping` at MAXPOOL_SCRUB_PING_MS,
// armed only after the first real client write and only while a scrubber is active.
//
//   1. single pool  — a client-side idle watchdog stands in for the Mac's idle timer (runs now)
//   2. two pools, scaled   — a real Mac pool linked to a real cloud pool, link idle 2.5s (runs now)
//   3. two pools, full-scale (30s of thinking, idle 10s, ping 3s) — MAXPOOL_TWO_POOL_TESTS=1
//
// Every socket is 127.0.0.1; the provider is a local stub; no account token is real.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { PoolLink } from '../src/pool-link.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };

async function captureLog(fn) {
  const lines = [];
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}

const sse = j => `event: ${j.type}\ndata: ${JSON.stringify(j)}\n\n`;

/** A GLM-style stream: thinking chunks every `intervalMs`, optionally a slow mcp tool block, then text. */
function glmStub({ chunks, intervalMs, withTool = false }) {
  return http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const steps = [];
      steps.push(() => res.write(sse({ type: 'message_start', message: { id: 'msg_glm', model: 'glm-5.3', content: [] } })));
      steps.push(() => res.write(sse({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })));
      for (let i = 0; i < chunks; i++) steps.push(() => res.write(sse({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: `t${i}` } })));
      steps.push(() => res.write(sse({ type: 'content_block_stop', index: 0 })));
      let textIdx = 1;
      if (withTool) {
        steps.push(() => res.write(sse({ type: 'content_block_start', index: 1, content_block: { type: 'mcp_tool_use', id: 'mcp_1', name: 'webReader', server_name: 'web', input: {} } })));
        for (const part of ['{"url":', '"https://x', '.test"}']) steps.push(() => res.write(sse({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: part } })));
        steps.push(() => res.write(sse({ type: 'content_block_stop', index: 1 })));
        textIdx = 2;
      }
      steps.push(() => res.write(sse({ type: 'content_block_start', index: textIdx, content_block: { type: 'text', text: '' } })));
      steps.push(() => res.write(sse({ type: 'content_block_delta', index: textIdx, delta: { type: 'text_delta', text: 'Hello from glm' } })));
      steps.push(() => res.write(sse({ type: 'content_block_stop', index: textIdx })));
      steps.push(() => res.write(sse({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })));
      steps.push(() => res.end(sse({ type: 'message_stop' })));
      // Thinking/tool deltas are spaced; the rest of the frames follow their predecessor at once.
      const slow = new Set();
      steps.forEach((_, i) => { if (i >= 2 && i < 2 + chunks) slow.add(i); });
      if (withTool) { const b = 2 + chunks + 2; [b, b + 1, b + 2].forEach(i => slow.add(i)); }
      let i = 0; let dead = false;
      res.on('close', () => { dead = true; });
      const next = () => {
        if (dead || i >= steps.length) return;
        const step = steps[i]; const wait = slow.has(i) ? intervalMs : 0; i++;
        if (wait) setTimeout(() => { if (!dead) { step(); next(); } }, wait); else { step(); next(); }
      };
      next();
    });
  });
}

/** Strict SSE parse: whole events only, `event:` name == data.type, nothing else, clean end. */
function strictParse(text) {
  assert.ok(text.endsWith('\n\n'), `stream must end on an event boundary, tail=${JSON.stringify(text.slice(-60))}`);
  const out = [];
  for (const ev of text.split('\n\n').slice(0, -1)) {
    const lines = ev.split('\n');
    assert.equal(lines.length, 2, `an event is exactly "event:" + "data:" lines, got ${JSON.stringify(ev)}`);
    assert.match(lines[0], /^event: [a-z_]+$/, `bad event line in ${JSON.stringify(ev)}`);
    assert.match(lines[1], /^data: \{.*\}$/, `bad data line in ${JSON.stringify(ev)}`);
    const data = JSON.parse(lines[1].slice(6));
    assert.equal(lines[0].slice(7), data.type, `event name must equal data.type in ${JSON.stringify(ev)}`);
    out.push(data);
  }
  return out;
}

function assertScrubbedShape(events, { withTool }) {
  const pings = events.filter(e => e.type === 'ping');
  const real = events.filter(e => e.type !== 'ping');
  assert.ok(!real.some(e => e.delta?.type === 'thinking_delta' || e.content_block?.type === 'thinking'), 'thinking scrubbed');
  const starts = real.filter(e => e.type === 'content_block_start').map(e => e.index);
  const stops = real.filter(e => e.type === 'content_block_stop').map(e => e.index);
  const want = withTool ? [0, 1] : [0];
  assert.deepEqual(starts, want, 'block indexes contiguous after renumbering');
  assert.deepEqual(stops, want, 'every block closed at its renumbered index');
  assert.ok(real.some(e => e.delta?.text === 'Hello from glm'), 'text delivered');
  if (withTool) assert.ok(real.some(e => e.type === 'content_block_delta' && e.index === 0 && /webReader/.test(e.delta?.text || '')), 'tool block converted to text at index 0');
  return pings;
}

const glmAccount = (port) => ({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'k', upstream: `http://127.0.0.1:${port}`, profiles: ['all'], priority: 0 });
const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, max_tokens: 50, messages: [{ role: 'user', content: 'hi' }] });

// ------------------------------------------------------------------------- 1. single pool

async function singlePool({ withTool }) {
  const prevPing = process.env.MAXPOOL_SCRUB_PING_MS;
  process.env.MAXPOOL_SCRUB_PING_MS = '400';
  const stub = glmStub({ chunks: 4, intervalMs: 1000, withTool });
  const upPort = await listen(stub);
  const am = new AccountManager([glmAccount(upPort)], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false }, providerThinkingScrub: true });
  const port = await listen(proxy);
  try {
    let text = ''; let maxGapMs = 0; let status = 0;
    const lines = await captureLog(async () => {
      await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/v1/messages', method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-profile': 'all' } }, res => {
          status = res.statusCode;
          let last = Date.now();
          res.on('data', c => { const now = Date.now(); maxGapMs = Math.max(maxGapMs, now - last); last = now; text += c; });
          res.on('end', resolve);
        });
        req.on('error', reject);
        req.end(body);
      });
    });
    return { status, text, maxGapMs, lines };
  } finally {
    if (prevPing === undefined) delete process.env.MAXPOOL_SCRUB_PING_MS; else process.env.MAXPOOL_SCRUB_PING_MS = prevPing;
    await close(proxy); await close(stub);
  }
}

test('T8 single pool: a scrubbed GLM stream keeps bytes flowing (client idle watchdog 2s vs 4s of thinking)', async () => {
  const r = await singlePool({ withTool: false });
  assert.equal(r.status, 200, r.lines.join('\n'));
  const pings = assertScrubbedShape(strictParse(r.text), { withTool: false });
  assert.ok(r.maxGapMs < 2000, `longest silence ${r.maxGapMs}ms: a 2s client idle timer would have fired (no keep-alive during scrubbed thinking)`);
  assert.ok(pings.length >= 4, `pings during ~4s of silent thinking: ${pings.length}`);
});

test('T8 single pool: a ping landing inside an open converted tool block stays BETWEEN events; indexes intact', async () => {
  const r = await singlePool({ withTool: true });
  assert.equal(r.status, 200, r.lines.join('\n'));
  const events = strictParse(r.text);
  const pings = assertScrubbedShape(events, { withTool: true });
  // The converted block's start is emitted at once; its deltas are buffered ~3s. Pings must land after the
  // start and before the converted delta, as whole events.
  const startAt = events.findIndex(e => e.type === 'content_block_start' && e.index === 0);
  const deltaAt = events.findIndex(e => e.type === 'content_block_delta' && e.index === 0 && /webReader/.test(e.delta?.text || ''));
  assert.ok(pings.length >= 4);
  assert.ok(events.slice(startAt + 1, deltaAt).some(e => e.type === 'ping'), 'a ping landed inside the open converted block, between whole events');
  assert.ok(r.maxGapMs < 2000, `longest silence ${r.maxGapMs}ms`);
});

test('T8 single pool: no scrubber (Claude account) means NO pings are added', async () => {
  const prevPing = process.env.MAXPOOL_SCRUB_PING_MS;
  process.env.MAXPOOL_SCRUB_PING_MS = '200';
  const up = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ type: 'message_start', message: { id: 'msg_c' } }));
    setTimeout(() => res.end(sse({ type: 'message_stop' })), 900);
  });
  const upPort = await listen(up);
  const am = new AccountManager([{ name: 'c1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 }], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false }, providerThinkingScrub: true });
  const port = await listen(proxy);
  try {
    let text = '';
    await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body });
      text = await r.text();
    });
    assert.ok(!text.includes('event: ping'), `a Claude stream is never padded: ${text}`);
  } finally {
    if (prevPing === undefined) delete process.env.MAXPOOL_SCRUB_PING_MS; else process.env.MAXPOOL_SCRUB_PING_MS = prevPing;
    await close(proxy); await close(up);
  }
});

// ------------------------------------------------------------------------- 2/3. two real pools

async function twoPools({ chunks, intervalMs, idleMs, pingMs, withTool = false }) {
  const prev = { idle: process.env.MAXPOOL_LINK_IDLE_MS, ping: process.env.MAXPOOL_SCRUB_PING_MS };
  process.env.MAXPOOL_LINK_IDLE_MS = String(idleMs);
  process.env.MAXPOOL_SCRUB_PING_MS = String(pingMs);
  const stub = glmStub({ chunks, intervalMs, withTool });
  const upPort = await listen(stub);
  const cloudAm = new AccountManager([glmAccount(upPort)], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  const cloud = createProxyServer(cloudAm, { proxy: { apiKey: 'mp-max' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 }, providerThinkingScrub: true });
  const cloudPort = await listen(cloud);
  const macAm = new AccountManager([], 0.9, { crossProviderFallbackPolicy: 'when-exhausted' });
  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  macAm.setPoolLinks([link]);
  const deadUp = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const deadPort = await listen(deadUp);
  const mac = createProxyServer(macAm, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } });
  const macPort = await listen(mac);
  try {
    let status = 0; let text = '';
    const lines = await captureLog(async () => {
      try {
      const r = await fetch(`http://127.0.0.1:${macPort}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-profile': 'all' }, body, signal: AbortSignal.timeout(Math.max(20_000, chunks * intervalMs * 2)) });
      status = r.status; text = await r.text();
      } catch (e) { status = `client-error:${e.name}`; }
    });
    return { status, text, lines };
  } finally {
    for (const [k, v] of [['MAXPOOL_LINK_IDLE_MS', prev.idle], ['MAXPOOL_SCRUB_PING_MS', prev.ping]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    macAm.setPoolLinks([]); await close(mac); await close(deadUp); await close(cloud); await close(stub);
  }
}

async function assertNoLinkIdle(r, withTool) {
  assert.ok(!r.lines.some(l => /link_idle|link body idle timeout/.test(l)), `no link_idle:\n${r.lines.join('\n')}`);
  assert.equal(r.status, 200, `${r.text.slice(0, 200)}\n${r.lines.join('\n')}`);
  assertScrubbedShape(strictParse(r.text), { withTool });
}

test('T8 two pools (scaled): thinking every 1s for 5s, link idle 2.5s, ping 0.8s → no link_idle, text delivered', { timeout: 60_000 }, async () => {
  const r = await twoPools({ chunks: 5, intervalMs: 1000, idleMs: 2500, pingMs: 800 });
  await assertNoLinkIdle(r, false);
});

test('T8 two pools (scaled) with a slow converted tool block: pings stay between whole events', { timeout: 60_000 }, async () => {
  const r = await twoPools({ chunks: 3, intervalMs: 1000, idleMs: 2500, pingMs: 800, withTool: true });
  await assertNoLinkIdle(r, true);
});

test('T8 two pools (full scale): thinking every 2s for 30s, link idle 10s, ping 3s', { skip: process.env.MAXPOOL_TWO_POOL_TESTS !== '1' && 'set MAXPOOL_TWO_POOL_TESTS=1 (takes ~35s)', timeout: 120_000 }, async () => {
  const r = await twoPools({ chunks: 15, intervalMs: 2000, idleMs: 10_000, pingMs: 3000 });
  await assertNoLinkIdle(r, false);
});
