// Release B (batch 1) TWO-REAL-POOL tests: T1, T3, T10, T10b. A real Mac pool linked to a
// real cloud pool, both created in this process on 127.0.0.1 (no account token, no
// Anthropic / z.ai call: the cloud's upstream is a local stub).
//
// SKIPPED BY DEFAULT — they take minutes and bind several ports. Run later, against scratch
// pools only:   MAXPOOL_TWO_POOL_TESTS=1 node --test test/nonstream-deadline-two-pool.test.js
// T10b additionally needs a checkout of the OLD (v1.24.91) code:  MAXPOOL_OLD_MAC_DIR=<path>
//
// Module constants are read at import; node --test gives each file its own process, so the
// knobs are set here BEFORE the dynamic imports. The link hop cap is injected small so the
// one-number arithmetic is observable in tens of seconds, not 290s (B4: MAXPOOL_LINK_HOP_CAP_MS).
const ENABLED = process.env.MAXPOOL_TWO_POOL_TESTS === '1';
process.env.MAXPOOL_LINK_TTFB_MS = '15000';
process.env.MAXPOOL_LINK_HOP_CAP_MS ||= '60000';

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
  const orig = { log: console.log, error: console.error };
  console.log = (...a) => { lines.push(a.join(' ')); };
  console.error = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig.log; console.error = orig.error; }
  return lines;
}

// A real cloud pool (one account) whose upstream answers after `delayMs` (null = never).
async function bootTwoPools(delayMs, { macCreate = createProxyServer, macAm = new AccountManager([], 0.9), stripDeadline = false } = {}) {
  const upstreamHits = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      upstreamHits.push(Date.now());
      if (delayMs == null) return;
      const stream = /"stream":true/.test(raw);
      const t = setTimeout(() => {
        if (stream) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE_OK); }
        else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"msg_slow_ok","type":"message"}'); }
      }, delayMs);
      res.on('close', () => clearTimeout(t));
    });
  });
  const upPort = await listen(upstream);
  const cloudAm = new AccountManager([{ name: 'c1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3_600_000 }], 0.9);
  const cloudSeen = [];
  const cloud = createProxyServer(cloudAm, { proxy: { apiKey: 'mp-max' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } },
    { onRequestStart: (id, info) => { cloudSeen.push(info); } });
  const cloudPort = await listen(cloud);
  // Spy on what the Mac sends: wrap the cloud's request listener to record the deadline header.
  const sent = [];
  cloud.prependListener('request', req => {
    if (req.url !== '/v1/messages') return;
    sent.push(req.headers['x-maxpool-deadline-ms']);
    // stripDeadline: the cloud never sees the header, i.e. behaves like v1.24.91 (T10).
    if (stripDeadline) delete req.headers['x-maxpool-deadline-ms'];
  });

  const link = new PoolLink({ name: 'team', url: `http://127.0.0.1:${cloudPort}`, key: 'mp-max' });
  await link.poll();
  macAm.setPoolLinks([link]);
  const deadUp = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  const deadPort = await listen(deadUp);
  const mac = macCreate(macAm, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}`, queue: { enabled: true, streamForwardGraceMs: 1000 } });
  const macPort = await listen(mac);
  return {
    macAm, cloudAm, macPort, upstreamHits, sent,
    cleanup: async () => { macAm.setPoolLinks([]); await close(mac); await close(deadUp); await close(cloud); await close(upstream); },
  };
}

async function sendThroughMac(macPort, stream, headers = {}) {
  const out = { status: 0, text: '', headers: {}, elapsedMs: 0, lines: [] };
  out.lines = await captureLog(async () => {
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${macPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', ...headers },
      body: JSON.stringify({ model: 'claude-opus-5-5', stream, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(150_000),
    });
    out.status = r.status; out.headers = Object.fromEntries(r.headers); out.text = await r.text();
    out.elapsedMs = Date.now() - t0;
  });
  return out;
}

// T1 — the parked release-B test (was test/pending/link-cloud-keepalive.test.js).
for (const stream of [true, false]) {
  test(`T1: a ${stream ? 'streaming' : 'NON-streaming'} turn the cloud is still serving is not abandoned at the link floor`,
    { skip: !ENABLED && 'two-pool: set MAXPOOL_TWO_POOL_TESTS=1' }, async () => {
      const pools = await bootTwoPools(20_000);
      try {
        const r = await sendThroughMac(pools.macPort, stream, stream ? {} : { 'x-stainless-timeout': '300' });
        const gaveUp = r.lines.filter(l => /attempt failed \(link_ttfb\)/.test(l));
        assert.deepEqual(gaveUp, [], `the Mac gave up on a cloud request still being served:\n${r.lines.join('\n')}`);
        assert.equal(r.status, 200, `status ${r.status}: ${r.text.slice(0, 300)}`);
        assert.ok(r.text.includes('msg_slow_ok'));
      } finally { await pools.cleanup(); }
    });
}

// T3 — Stainless-Timeout 30, cloud upstream silent: the cloud answers 504 + request-scoped BEFORE
// the Mac's link timer; the cloud really waited ≈ header − margin (an instant 504 would pass
// r1's assertion for the wrong reason, S-1); the Mac's row counters are all unchanged (S-4).
test('T3: Stainless-Timeout 30 → cloud 504 + request-scoped before the Mac link timer; no link_ttfb; Mac row untouched',
  { skip: !ENABLED && 'two-pool: set MAXPOOL_TWO_POOL_TESTS=1' }, async () => {
    const pools = await bootTwoPools(null);
    try {
      const r = await sendThroughMac(pools.macPort, false, { 'x-stainless-timeout': '30' });
      assert.equal(r.status, 504, `${r.status} ${r.text.slice(0, 200)}\n${r.lines.slice(-8).join('\n')}`);
      assert.deepEqual(r.lines.filter(l => /attempt failed \(link_ttfb\)/.test(l)), [], 'no link_ttfb');
      const header = Number(pools.sent[0]);
      assert.ok(header > 0 && header < 15_000, `the cloud got a deadline below the Mac's remaining (15s): ${pools.sent[0]}`);
      assert.ok(r.elapsedMs >= (header - 3_000) - 1_500, `the cloud actually waited ≈ header − transit margin (header ${header}, got ${r.elapsedMs}ms): not an instant 504`);
      assert.ok(r.elapsedMs <= 15_000, `answered inside the Mac's 15s deadline (${r.elapsedMs}ms)`);
      assert.equal(pools.upstreamHits.length, 1);
      for (const row of pools.macAm.accounts) {
        assert.ok(!(row.cooldownUntil > Date.now()), `${row.name}: cooldownUntil unchanged`);
        assert.equal(row.failedRequests, 0, `${row.name}: failedRequests`);
        assert.equal(row.consecutiveFailures, 0, `${row.name}: consecutiveFailures`);
        assert.equal(pools.macAm._loadSummary(row, 15 * 60_000).failed, 0, `${row.name}: last15m.failed`);
      }
    } finally { await pools.cleanup(); }
  });

// T10 — a NEW Mac against an OLD cloud (header ignored): the Mac is still bounded by its own deadline.
test('T10: new Mac vs a cloud that ignores the deadline header → the Mac still answers inside its own deadline',
  { skip: !ENABLED && 'two-pool: set MAXPOOL_TWO_POOL_TESTS=1' }, async () => {
    const pools = await bootTwoPools(null, { stripDeadline: true });
    try {
      const r = await sendThroughMac(pools.macPort, false, { 'x-stainless-timeout': '40' });
      assert.ok(r.elapsedMs <= 26_000, `the Mac answered at ${r.elapsedMs}ms, inside 40s − 15s (+1s): bounded by its OWN deadline`);
      assert.ok([502, 503, 504].includes(r.status), `a retryable status, got ${r.status}`);
    } finally { await pools.cleanup(); }
  });

// T10b — OLD Mac (v1.24.91 code) vs NEW cloud, request WITHOUT the deadline header → today's 503, old Mac row unchanged.
test('T10b: OLD Mac vs new cloud, header-less request → cloud answers today\'s 503; old Mac row counters unchanged',
  { skip: (!ENABLED && 'two-pool: set MAXPOOL_TWO_POOL_TESTS=1') || (!process.env.MAXPOOL_OLD_MAC_DIR && 'needs MAXPOOL_OLD_MAC_DIR=<checkout of v1.24.91>') }, async () => {
    const oldServer = await import(`${process.env.MAXPOOL_OLD_MAC_DIR}/src/server.js`);
    const oldAm = await import(`${process.env.MAXPOOL_OLD_MAC_DIR}/src/account-manager.js`);
    const macAm = new oldAm.AccountManager([], 0.9);
    const pools = await bootTwoPools(null, { macCreate: oldServer.createProxyServer, macAm });
    try {
      const r = await sendThroughMac(pools.macPort, false, {});
      assert.ok(r.status === 503 || r.status === 502, `today's answer, got ${r.status}`);
      assert.deepEqual(pools.sent.filter(Boolean), [], 'the old Mac sent no deadline header, so the cloud must not 504');
      assert.notEqual(r.headers['x-maxpool-request-scoped'], '1');
    } finally { await pools.cleanup(); }
  });
