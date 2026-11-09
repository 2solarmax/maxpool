// D2 size-scaled first-byte wait + D3 retry-same on the DIRECT path.
// Module constants are read at import, and node --test runs each file in its own
// process — so the knobs are set here, BEFORE the dynamic import:
//   floor 5s (the minimum the code allows), 300KB × per-byte ≈ 7s on streaming turns.
process.env.MAXPOOL_TTFB_MS = '5000';
process.env.MAXPOOL_TTFB_MS_PER_BYTE = String(7000 / 300_000);

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer, __serverTest } = await import('../src/server.js');
const { clientWaitCeilingMs, scaledTtfbMs, retrySameEligible, ttfbKnobs } = __serverTest;

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };
const BIG = 300_000;
const SMALL = 5_000;

async function captureLog(fn) {
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines;
}
const attempts = lines => lines.filter(l => l.startsWith('[Maxpool] attempt failed ('));

function body(bytes, stream = false) {
  const pad = 'x'.repeat(Math.max(0, bytes - 120));
  return JSON.stringify({ model: 'claude-opus-5-5', stream, messages: [{ role: 'user', content: pad }] });
}

function accounts(n = 2) {
  return new AccountManager(Array.from({ length: n }, (_, i) => ({
    name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
  })), 0.90);
}

// Upstream stub: `plan(token, nthHitForThatToken)` returns 'hang' | 'ok' | 429.
function upstreamStub(plan) {
  const hits = [];
  const perToken = new Map();
  const server = http.createServer((req, res) => {
    req.resume();
    const tok = String(req.headers.authorization || '').replace('Bearer ', '');
    const n = (perToken.get(tok) || 0) + 1; perToken.set(tok, n);
    hits.push(tok);
    const what = plan(tok, n);
    if (what === 'hang') return;   // never sends headers → the TTFB timer fires
    if (what === 'reset') { req.socket.destroy(); return; }   // connection drop, not a timeout
    if (what === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_scaled_ok"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n'); return; }
    if (what === 429) { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '30' }); res.end('{"type":"error","error":{"type":"rate_limit_error","message":"limit"}}'); return; }
    if (typeof what === 'number' && what > 1000) {   // delayed SSE answer (streaming turns)
      const t = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_scaled_ok"}}\n\n'
          + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
      }, what);
      res.on('close', () => clearTimeout(t));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  return { server, hits };
}

async function run(am, stub, reqBody, queue = { enabled: false }) {
  const upPort = await listen(stub.server);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue });
  const port = await listen(proxy);
  let status = 0; let text = '';
  try {
    const lines = await captureLog(async () => {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test' }, body: reqBody,
      });
      status = r.status; text = await r.text();
    });
    return { lines, status, text };
  } finally { await close(proxy); await close(stub.server); }
}

// ---------------------------------------------------------------- T3 / T5 (unit)

test('T3: 640KB at 0.6 ms/byte waits 384s; 5KB keeps the 120s floor; 0 disables scaling', () => {
  const cc = clientWaitCeilingMs({ stream: true, clientToleranceMs: 3 * 3600_000 * 0.8 });
  assert.equal(scaledTtfbMs(120_000, 0.6, 640_000, cc), 384_000);
  assert.equal(scaledTtfbMs(120_000, 0.6, 5_000, cc), 120_000);
  assert.equal(scaledTtfbMs(120_000, 0, 640_000, cc), 120_000, 'per-byte 0 = flat floor');
});

test('T5: the scaled wait clamps at the client patience ceiling', () => {
  // bare `claude`: no tolerance header → the 240s conservative default
  const bare = clientWaitCeilingMs({ stream: true }, {});
  assert.equal(bare, 240_000);
  assert.equal(scaledTtfbMs(120_000, 0.6, 640_000, bare), 240_000, '384s clamps to 240s');
  // cc alias with a 3h idle watchdog: the CLI's absolute 25-min stream ceiling still binds
  const huge = clientWaitCeilingMs({ stream: true, clientToleranceMs: 3 * 3600_000 * 0.8 });
  assert.equal(huge, ttfbKnobs().CLI_STREAM_CEILING_MS);
  assert.equal(scaledTtfbMs(120_000, 0.6, 5_000_000, huge), ttfbKnobs().CLI_STREAM_CEILING_MS);
  // explicit queue tolerance
  assert.equal(clientWaitCeilingMs({ stream: true }, { streamClientToleranceMs: 90_000 }), 90_000);
  // never below the floor even if the ceiling is lower
  assert.equal(scaledTtfbMs(120_000, 0.6, 640_000, 60_000), 120_000);
  // non-streaming: nothing keeps the client alive pre-headers → no scaling at all
  assert.equal(clientWaitCeilingMs({ stream: false }), null);
  assert.equal(scaledTtfbMs(120_000, 0.6, 640_000, null), 120_000);
});

test('T7/T8 unit: retry-same eligibility — size threshold, once, account health, real bytes', () => {
  const res = { headersSent: false };
  const ok = { status: 'active' };
  assert.equal(ttfbKnobs().BIG_PROMPT_BYTES, 250_000);
  assert.equal(retrySameEligible(ok, { bodyBytes: 250_000 }, res), true, 'at the threshold');
  assert.equal(retrySameEligible(ok, { bodyBytes: 249_999 }, res), false, 'below the threshold');
  assert.equal(retrySameEligible(ok, { bodyBytes: BIG, sameAccountRetried: true }, res), false, 'once per request');
  assert.equal(retrySameEligible({ status: 'throttled' }, { bodyBytes: BIG }, res), false, 'throttled');
  assert.equal(retrySameEligible({ status: 'error' }, { bodyBytes: BIG }, res), false, 'auth-dead');
  assert.equal(retrySameEligible({ status: 'active', cooldownUntil: Date.now() + 5000 }, { bodyBytes: BIG }, res), false, 'cooling');
  assert.equal(retrySameEligible(ok, { bodyBytes: BIG }, { headersSent: true }), false, 'real bytes already sent');
  assert.equal(retrySameEligible(ok, { bodyBytes: BIG, queueHeartbeatActive: true }, { headersSent: true }), true, 'heartbeat-only stream is still retryable');
});

// ---------------------------------------------------------------- T3 (wiring)

test('T3 wiring: a streaming 300KB turn waits the SCALED ~7s, not the 5s floor', async () => {
  // Answers at 6s: inside the scaled wait, past the floor. A timer still on the floor
  // would TTFB at 5s and retry.
  const stub = upstreamStub(() => 6000);
  const { lines, status, text } = await run(accounts(1), stub, body(BIG, true), { enabled: true, streamForwardGraceMs: 1000 });
  assert.equal(status, 200);
  assert.ok(text.includes('msg_scaled_ok'), `the upstream answer reached the client:\n${text.slice(0, 300)}`);
  assert.equal(stub.hits.length, 1, `served on the first attempt; attempts:\n${attempts(lines).join('\n')}`);
  assert.ok(lines.some(l => /first-byte wait 7s for 300KB prompt on "a1" \(direct; floor 5s\)/.test(l)), `chosen wait logged once:\n${lines.join('\n')}`);
  assert.equal(lines.filter(l => l.includes('first-byte wait')).length, 1);
});

// ---------------------------------------------------------------- T6 / T7 / T8

test('T6: big prompt TTFBs once on a1 → retry-same on a1 (not excluded, normal acquire) → answers', async () => {
  const am = accounts(2);
  const stub = upstreamStub((tok, n) => (tok === 't1' && n === 1 ? 'hang' : 'ok'));
  const { lines, status } = await run(am, stub, body(BIG));
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't1'], 'the retry went to the SAME account');
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(UPSTREAM_TTFB\) on "a1" — no first byte after .* on a 300KB prompt → retry-same$/);
  // lease accounting: both leases released, no cooldown left on the account it retried
  assert.deepEqual(am.accounts.map(x => x.inFlight), [0, 0]);
  assert.equal(am.accounts[0].consecutiveFailures, 0, 'request-scoped: no streak');
});

test('T6: a second timeout after retry-same falls through to the move path (excluded)', async () => {
  const am = accounts(2);
  const stub = upstreamStub(tok => (tok === 't1' ? 'hang' : 'ok'));
  const { lines, status } = await run(am, stub, body(BIG));
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't1', 't2'], 'once on the same account, then moved');
  const a = attempts(lines);
  assert.equal(a.length, 2, a.join('\n'));
  assert.ok(a[0].endsWith('→ retry-same'));
  assert.ok(a[1].includes('(UPSTREAM_TTFB) on "a1"') && a[1].endsWith('→ moved'), a[1]);
});

test('T7: a small prompt that TTFBs moves immediately (no retry-same below the threshold)', async () => {
  const stub = upstreamStub(tok => (tok === 't1' ? 'hang' : 'ok'));
  const { lines, status } = await run(accounts(2), stub, body(SMALL));
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't2']);
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.ok(a[0].endsWith('→ moved'), a[0]);
  assert.ok(!lines.some(l => l.endsWith('→ retry-same')));
});

test('T8: a 429 on a big prompt never retries the same account', async () => {
  const stub = upstreamStub(tok => (tok === 't1' ? 429 : 'ok'));
  const { lines, status } = await run(accounts(2), stub, body(BIG));
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't2'], 'throttled account left alone');
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.match(a[0], /^\[Maxpool\] attempt failed \(rate_limited\) on "a1" — HTTP 429, benched 30s → moved$/);
});

test('T7: a connection DROP (not a timeout) on a big prompt moves — retry-same is TTFB-only', async () => {
  const stub = upstreamStub((tok, n) => (tok === 't1' && n === 1 ? 'reset' : 'ok'));
  const { lines, status } = await run(accounts(2), stub, body(BIG));
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't2']);
  const a = attempts(lines);
  assert.equal(a.length, 1, a.join('\n'));
  assert.ok(a[0].endsWith('→ moved'), a[0]);
});

test('T6 (streaming): retry-same works on a heartbeat-committed stream; the wait is logged once', async () => {
  // grace 1s commits the SSE heartbeat before the scaled 7s TTFB fires — the retry
  // must still go to the same account and the client must get the real answer.
  const stub = upstreamStub((tok, n) => (n === 1 ? 'hang' : 'sse'));
  const { lines, status, text } = await run(accounts(2), stub, body(BIG, true), { enabled: true, streamForwardGraceMs: 1000 });
  assert.equal(status, 200);
  assert.deepEqual(stub.hits, ['t1', 't1'], 'same account on the retry');
  assert.ok(text.includes('event: ping'), 'heartbeat committed pre-headers');
  assert.ok(text.includes('msg_scaled_ok'), 'the retry\'s answer reached the client');
  assert.ok(attempts(lines)[0].endsWith('→ retry-same'), attempts(lines).join('\n'));
  assert.equal(lines.filter(l => l.includes('first-byte wait')).length, 1, 'chosen wait logged once per request, not per attempt');
});
