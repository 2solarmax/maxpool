// Release B (batch 1): the per-request deadline for NON-streaming requests (2026-11-13).
// Unit table: the header parser (S-1), the ONE-NUMBER link-hop arithmetic (BL-1, T3b),
// the env-knob caps (T6), the request-end `stream` field + TUI ' ns' tag (T9) and the
// retryable / neutral-release invariant (T11).
//
// Module constants are read at import and node --test runs each file in its own process,
// so the over-long knobs of T6 are set HERE, before the dynamic import: every one of them
// is 900s, far above what any client waits and above undici's own 300s.
process.env.MAXPOOL_TTFB_MS = '900000';
process.env.MAXPOOL_LINK_TTFB_MS = '900000';
process.env.MAXPOOL_BODY_MS = '900000';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

const { AccountManager } = await import('../src/account-manager.js');
const { createProxyServer, __serverTest } = await import('../src/server.js');
const { TUI } = await import('../src/tui.js');
const {
  parsePatience, computeDeadline, computeLinkHop, nonStreamFirstByteWait, nonStreamBodyWait,
  nonStreamRemainingMs, deadlineKnobs, deadlineErrorPayload, retrySameEligible, ttfbKnobs,
} = __serverTest;

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => { s.closeAllConnections?.(); return new Promise(r => s.close(r)); };

// ------------------------------------------------------------- header-parse table (S-1)

const GARBAGE = ['', 'abc', '0', '-1', 'Infinity', 'NaN', ' '];

test('header-parse table: garbled / non-positive / absent headers give NO deadline, never a 1ms timer', () => {
  for (const v of GARBAGE) {
    assert.equal(parsePatience({ 'x-stainless-timeout': v }), null, `x-stainless-timeout=${JSON.stringify(v)}`);
    assert.equal(parsePatience({ 'x-stainless-read-timeout': v }), null, `x-stainless-read-timeout=${JSON.stringify(v)}`);
    assert.equal(parsePatience({ 'x-maxpool-deadline-ms': v }), null, `x-maxpool-deadline-ms=${JSON.stringify(v)}`);
    assert.equal(computeDeadline({ 'x-stainless-timeout': v }, 1_000_000), null, `deadline for ${JSON.stringify(v)}`);
  }
  assert.equal(parsePatience({}), null, 'absent → no patience');
  assert.equal(computeDeadline({}, 1_000_000), null, 'header-less client keeps today\'s uncapped hops (S-9)');
  // Duplicated header (node joins repeats with ", ") is garbled, not "the first one".
  assert.equal(parsePatience({ 'x-stainless-timeout': '30, 40' }), null);
});

test('header-parse table: valid values are seconds (client) / ms (pool), clamped to 3600s, 30.5 kept', () => {
  assert.equal(parsePatience({ 'x-stainless-timeout': '1e9' }).ms, 3_600_000, '1e9 s clamps to 3600s');
  assert.equal(parsePatience({ 'x-stainless-timeout': '30.5' }).ms, 30_500);
  assert.equal(parsePatience({ 'x-stainless-timeout': '600' }).ms, 600_000);
  assert.equal(parsePatience({ 'x-stainless-read-timeout': '300' }).ms, 300_000);
  assert.equal(parsePatience({ 'x-maxpool-deadline-ms': '1e9' }).ms, 3_600_000);
  assert.equal(parsePatience({ 'x-maxpool-deadline-ms': '17000' }).ms, 17_000);
});

test('header-parse table: no input in the table can put a deadline in the past or within 1s of arrival', () => {
  const arrived = 5_000_000;
  const inputs = [...GARBAGE, '1e9', '30.5', '1', '3', '25', '30', '300', '3600', '99999'];
  for (const v of inputs) {
    for (const h of ['x-stainless-timeout', 'x-stainless-read-timeout', 'x-maxpool-deadline-ms']) {
      const d = computeDeadline({ [h]: v }, arrived);
      if (d === null) continue;
      assert.ok(Number.isFinite(d.deadlineAt), `${h}=${v}: finite`);
      assert.ok(d.deadlineAt - arrived >= 1000, `${h}=${v}: ${d.deadlineAt - arrived}ms after arrival is a timer-trip`);
    }
  }
});

test('patience precedence: pool header → X-Stainless-Timeout → read-timeout; the FIRST VALID one wins', () => {
  const h = { 'x-maxpool-deadline-ms': '40000', 'x-stainless-timeout': '3600', 'x-stainless-read-timeout': '300' };
  assert.equal(parsePatience(h).source, 'pool');
  assert.equal(parsePatience({ ...h, 'x-maxpool-deadline-ms': 'abc' }).source, 'stainless-timeout', 'invalid pool header falls through');
  assert.equal(parsePatience({ 'x-stainless-timeout': '-5', 'x-stainless-read-timeout': '300' }).source, 'stainless-read-timeout');
});

test('margins: a pool-supplied header gets ~3s transit margin, a client header the 15s margin; anchored at arrival', () => {
  const k = deadlineKnobs();
  assert.equal(k.NONSTREAM_MARGIN_MS, 15_000);
  assert.equal(k.POOL_TRANSIT_MARGIN_MS, 3_000);
  const arrived = 1_000_000;
  const client = computeDeadline({ 'x-stainless-timeout': '300' }, arrived);
  assert.equal(client.deadlineAt, arrived + 300_000 - 15_000);
  assert.equal(client.poolSupplied, false);
  const pool = computeDeadline({ 'x-maxpool-deadline-ms': '280000' }, arrived);
  assert.equal(pool.deadlineAt, arrived + 280_000 - 3_000);
  assert.equal(pool.poolSupplied, true);
  // Patience below margin + 15s is raised to it (deadline never before arrival, S-1).
  const tiny = computeDeadline({ 'x-stainless-timeout': '5' }, arrived);
  assert.equal(tiny.deadlineAt, arrived + 15_000, 'floor = margin + 15s of patience → 15s usable');
});

// ------------------------------------------------------------- T3b: ONE NUMBER (BL-1)

test('T3b: header + G <= linkWait for every remaining, including the 3585s of a cc session', () => {
  const G = deadlineKnobs().LINK_RETURN_MARGIN_MS;
  assert.equal(G, 10_000);
  const cap = deadlineKnobs().LINK_HOP_CAP_MS;
  assert.equal(cap, 290_000);
  for (const remainingS of [20, 285, 3585]) {
    const hop = computeLinkHop(remainingS * 1000);
    assert.ok(hop, `remaining ${remainingS}s gets a hop`);
    assert.ok(hop.headerMs + G <= hop.linkWaitMs, `remaining ${remainingS}s: header ${hop.headerMs} + G ${G} <= linkWait ${hop.linkWaitMs}`);
    assert.ok(hop.linkWaitMs <= cap, `linkWait ${hop.linkWaitMs} <= cap`);
    assert.ok(hop.linkWaitMs <= remainingS * 1000, `linkWait never past the deadline`);
    assert.ok(hop.headerMs >= 1000, 'a usable header');
  }
  // Exact values pin the formula (not just the inequality): linkWait = min(remaining − G, cap).
  assert.deepEqual(
    [computeLinkHop(285_000).linkWaitMs, computeLinkHop(285_000).headerMs], [275_000, 265_000]);
  assert.deepEqual(
    [computeLinkHop(3_585_000).linkWaitMs, computeLinkHop(3_585_000).headerMs], [290_000, 280_000], 'cc: the cap binds, the header follows the CAPPED wait');
  // 20s: remaining − G = 10s is under the 15s floor → floor 15s (still inside the deadline); header 5s.
  assert.deepEqual([computeLinkHop(20_000).linkWaitMs, computeLinkHop(20_000).headerMs], [15_000, 5_000]);
  assert.equal(computeLinkHop(20_000).deadlineBound, true);
  assert.equal(computeLinkHop(3_585_000).deadlineBound, false, 'a capped hop is a link-hop timeout, not the client deadline');
});

test('T3b: the cap is injectable and the header follows it; no time left → no hop (N-3)', () => {
  const hop = computeLinkHop(600_000, { capMs: 40_000, marginMs: 5_000 });
  assert.deepEqual([hop.linkWaitMs, hop.headerMs], [40_000, 35_000]);
  assert.equal(computeLinkHop(0), null);
  assert.equal(computeLinkHop(-5), null);
  assert.equal(computeLinkHop(10_000), null, 'header would be 0 → no hop rather than a header the cloud drops');
  process.env.MAXPOOL_LINK_HOP_CAP_MS = '30000';
  try {
    assert.equal(computeLinkHop(600_000).linkWaitMs, 30_000, 'MAXPOOL_LINK_HOP_CAP_MS read per call');
  } finally { delete process.env.MAXPOOL_LINK_HOP_CAP_MS; }
});

// ------------------------------------------------------------- T6: env knobs cannot outrun the client

test('T6: knobs of 900000 ms still give an effective wait <= 290s and <= patience minus margin', () => {
  const k = ttfbKnobs();
  assert.equal(k.UPSTREAM_TTFB_MS, 900_000, 'precondition: the knob really is 900s in this process');
  const now = Date.now();
  // cc: 3600s patience → ~3585s remaining
  const cc = { stream: false, deadlineAt: now + 3_585_000 };
  const w = nonStreamFirstByteWait(cc, k.UPSTREAM_TTFB_MS);
  assert.ok(w.ms <= 290_000, `first-byte wait ${w.ms} <= 290s`);
  assert.equal(w.deadlineBound, false);
  // bare claude: 300s patience → 285s remaining
  const bare = computeDeadline({ 'x-stainless-timeout': '300' }, now);
  const wb = nonStreamFirstByteWait({ stream: false, deadlineAt: bare.deadlineAt }, k.UPSTREAM_TTFB_MS);
  assert.ok(wb.ms <= 285_000 + 50 && wb.ms <= 290_000, `bare-claude wait ${wb.ms} <= patience − margin`);
  assert.equal(wb.deadlineBound, true);
  // 40s remaining: the deadline binds
  const short = nonStreamFirstByteWait({ stream: false, deadlineAt: now + 40_000 }, k.UPSTREAM_TTFB_MS);
  assert.ok(short.ms <= 40_000 && short.ms > 39_000, `short ${short.ms}`);
  assert.equal(short.deadlineBound, true);
  // the link side: MAXPOOL_LINK_TTFB_MS=900000 does not matter once a deadline exists
  assert.ok(computeLinkHop(3_585_000).linkWaitMs <= 290_000);
  // body read: MAXPOOL_BODY_MS=900000 is bounded too
  const body = nonStreamBodyWait({ stream: false, deadlineAt: now + 60_000 }, deadlineKnobs().UPSTREAM_BODY_MS);
  assert.ok(body.ms <= 60_000, `body wait ${body.ms}`);
  assert.equal(body.deadlineBound, true);
  const bodyFar = nonStreamBodyWait({ stream: false, deadlineAt: now + 3_000_000 }, deadlineKnobs().UPSTREAM_BODY_MS);
  assert.equal(bodyFar.ms, 900_000, 'far deadline: the body knob binds (undici is the outer bound, unchanged)');
  assert.equal(bodyFar.deadlineBound, false);
});

test('T6: with NO deadline (header-less client) the waits are today\'s: nothing new caps them (S-9)', () => {
  const k = ttfbKnobs();
  assert.deepEqual(nonStreamFirstByteWait({ stream: false }, 120_000), { ms: 120_000, deadlineBound: false });
  assert.deepEqual(nonStreamFirstByteWait({ stream: false }, k.UPSTREAM_TTFB_MS), { ms: 900_000, deadlineBound: false });
  assert.equal(nonStreamRemainingMs({ stream: false }), Infinity);
});

// ------------------------------------------------------------- B5 / B6 helpers

test('B5: a non-streaming request is never retry-same, whatever the prompt size', () => {
  const ok = { status: 'active' };
  assert.equal(retrySameEligible(ok, { bodyBytes: 300_000, stream: false }, { headersSent: false }), false);
  // (this file floors the first-byte wait at 900s, so give the streaming case a patient client: cc's 3h watchdog)
  assert.equal(retrySameEligible(ok, { bodyBytes: 300_000, stream: true, clientToleranceMs: 3 * 3_600_000 * 0.8 }, { headersSent: false }), true, 'streaming unchanged');
});

// ------------------------------------------------------------- T9: request-end carries `stream`

function accounts(n = 1) {
  return new AccountManager(Array.from({ length: n }, (_, i) => ({
    name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3_600_000,
  })), 0.9);
}

test('T9: onRequestEnd carries the stream flag for streaming and non-streaming requests', async () => {
  const upstream = http.createServer((req, res) => {
    req.resume();
    if (req.headers['x-want'] === 'sse') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n'); }
    else { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); }
  });
  const upPort = await listen(upstream);
  const ends = [];
  const proxy = createProxyServer(accounts(1), { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } },
    { onRequestEnd: (id, info) => ends.push(info) });
  const port = await listen(proxy);
  const origLog = console.log; console.log = () => {};
  try {
    for (const stream of [false, true]) {
      const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-want': stream ? 'sse' : 'json' },
        body: JSON.stringify({ model: 'claude-opus-5-5', stream, messages: [{ role: 'user', content: 'hi' }] }),
      });
      await r.text();
    }
  } finally { console.log = origLog; await close(proxy); await close(upstream); }
  assert.equal(ends.length, 2);
  assert.equal(ends[0].stream, false, 'non-streaming request-end says stream:false');
  assert.equal(ends[1].stream, true, 'streaming request-end says stream:true');
});

test('T9: the TUI tags a non-streaming request-end line " ns" and leaves streaming lines alone', () => {
  const tui = new TUI({ accountManager: new AccountManager([], 0.9), config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {}, onRestart() {} });
  tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a1', status: 200, stream: false });
  tui.onRequestEnd(2, { method: 'POST', path: '/v1/messages', account: 'a1', status: 200, stream: true });
  tui.onRequestEnd(3, { method: 'POST', path: '/v1/oauth/token', account: '(oauth relay)', status: 200 });
  const lines = tui.log.map(l => l.msg);
  assert.match(lines[2], /→ a1 \(200, [\d.?]+s\) ns\b/, lines[2]);
  assert.doesNotMatch(lines[1], / ns\b/, 'streaming line untagged');
  assert.doesNotMatch(lines[0], / ns\b/, 'a request with no stream field (oauth relay) untagged');
});

// ------------------------------------------------------------- T11: retryable invariant, neutral release

test('T11: the deadline answer is a 504 timeout_error — a shape every SDK retries — and says request-scoped only to a pool', () => {
  const p = deadlineErrorPayload();
  assert.equal(p.type, 'error');
  assert.equal(p.error.type, 'timeout_error');
  assert.ok(String(p.error.message).length > 20 && !/\bundefined\b/.test(p.error.message));
});

test('T11: a deadline-cut release is neutral — no streak, no cooldown, no failed count, no link-fault event', () => {
  const am = accounts(1);
  const a = am.accounts[0];
  const lease = am.acquireAccount({ profile: 'claude' });
  assert.ok(lease);
  am.releaseAccount(lease, { neutral: true, error: 'deadline', kind: 'deadline' });
  assert.equal(a.inFlight, 0, 'lease returned');
  assert.equal(a.failedRequests, 0);
  assert.equal(a.consecutiveFailures, 0);
  assert.equal(a.requestFaultStreak || 0, 0);
  assert.ok(!a.cooldownUntil && !a.softCooldownUntil, 'no cooldown');
  assert.equal(a.lastError, null);
  const w = am._loadSummary(a, 15 * 60_000);
  assert.equal(w.failed, 0);
  assert.equal(w.linkFailed || 0, 0, 'not a link fault either');
});
