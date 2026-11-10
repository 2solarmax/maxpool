// 2026-11-10: the terminal "resets" column showed "2~119d" for an account, then went
// blank — no reset was claimed. Cause: one failed grant check (non-2xx / throw)
// nulled the whole listing silently. FIX A keeps the last good count, marks it stale,
// never lets stale data claim, and logs once per transition. FIX B adds ttfb= to the
// request log line (appended LAST so existing parsers are untouched).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { decideClaude } from '../src/reset-policy.js';
import { TUI, __tuiTest } from '../src/tui.js';
import { PoolLink } from '../src/pool-link.js';
import { createProxyServer, markFirstByte } from '../src/server.js';

const strip = __tuiTest.strip;
const DAY = 86400_000;

const grant = (o = {}) => ({ id: 'g1', usableNow: true, paused: false, expired: false,
  endsAt: Date.now() + 119 * DAY, clears: ['seven_day'], requiresLimit: false, ...o });
const GOOD = () => ({ grants: [grant(), grant({ id: 'g2' })], nextGrantId: 'g1', cooldownUntil: null, eligible: true });

function am1() {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  return am;
}

// ── FIX A: account-manager ────────────────────────────────────────────────────
test('failed listing keeps the previous grants and marks them stale', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD(), 1000);
  am.applyResetGrants(0, { error: 'HTTP 503' }, 2000);
  const rg = am.accounts[0].resetGrants;
  assert.equal(rg.grants.length, 2, 'count survives the failed check');
  assert.equal(rg.stale, true);
  assert.equal(rg.lastError, 'HTTP 503');
  assert.equal(rg.lastErrorAt, 2000);
  assert.equal(rg.checkedAt, 1000, 'checkedAt stays the last GOOD read');
});

test('a successful listing clears stale', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD(), 1000);
  am.applyResetGrants(0, { error: 'HTTP 503' }, 2000);
  am.applyResetGrants(0, GOOD(), 3000);
  const rg = am.accounts[0].resetGrants;
  assert.equal(rg.stale, false);
  assert.equal(rg.checkedAt, 3000);
});

test('never-good stays null on a failed listing', () => {
  const am = am1();
  am.applyResetGrants(0, { error: 'unauthorized' });
  assert.ok(am.accounts[0].resetGrants == null, 'nothing to show');
});

test('a stale listing never triggers a claim decision', () => {
  const acct = { name: 'a1', enabled: true, quota: { unified7d: 0.995, unified7dReset: Date.now() + 3 * DAY, lastProbeOkAt: Date.now() } };
  const fresh = GOOD();
  assert.ok(decideClaude(acct, fresh), 'control: the same listing at the wall DOES claim when fresh');
  assert.equal(decideClaude(acct, { ...fresh, stale: true }), null, 'stale must not claim');
});

test('prober: failing listing never claims and the stored count is kept', async () => {
  const am = am1();
  am.applyResetGrants(0, GOOD());
  am.accounts[0].quota.unified7d = 0.99;
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ status: 500, error: 'x' }), grantsFn: async () => ({ error: 'HTTP 500' }) });
  let claims = 0;
  prober._claimClaudeGrant = async () => { claims++; };
  await prober.probeOne(am.accounts[0]);
  assert.equal(claims, 0);
  assert.equal(am.accounts[0].resetGrants.grants.length, 2);
  assert.equal(am.accounts[0].resetGrants.stale, true);
});

test('prober logs once per transition: ok→failing, failing→ok (no per-poll spam)', async () => {
  const am = am1();
  const logs = [];
  let mode = 'ok';
  // A2: grants are listed at most once per GRANTS_EVERY_MS (5 min) — the test's
  // back-to-back probeOne calls must each land in a NEW listing window, so the
  // injected clock advances a full window per sweep.
  let clock = 1_700_000_000_000;
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ status: 500, error: 'x' }), now: () => clock,
    grantsFn: async () => (mode === 'ok' ? GOOD() : mode === 'throw' ? (() => { throw new Error('boom'); })() : { error: 'HTTP 502' }) });
  prober._claimClaudeGrant = async () => {};
  const rg = () => logs.filter(l => l.startsWith('[reset-grant] a1:'));
  const sweep = () => { clock += 6 * 60_000; return prober.probeOne(am.accounts[0]); };
  await sweep();
  assert.equal(rg().length, 0, 'healthy: silent');
  mode = 'fail';
  await sweep(); await sweep(); mode = 'throw'; await sweep();
  assert.equal(rg().length, 1, 'three failures in a row log ONE line');
  assert.match(rg()[0], /listing FAILED \(HTTP 502\)/);
  assert.equal(am.accounts[0].resetGrants.stale, true, 'a throw is a failed listing too');
  mode = 'ok';
  await sweep(); await sweep();
  assert.equal(rg().length, 2, 'recovery logs ONE line');
  assert.match(rg()[1], /listing recovered/);
  assert.equal(am.accounts[0].resetGrants.stale, false);
});

test('prober: a listing timeout is a failed listing (stale, logged), not silence', async () => {
  const am = am1();
  am.applyResetGrants(0, GOOD());
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, timeoutMs: 5, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ status: 500, error: 'x' }), grantsFn: () => new Promise(() => {}) });
  const keepAlive = setTimeout(() => {}, 5000); // the prober's own timer is unref'd
  await prober.probeOne(am.accounts[0]);
  clearTimeout(keepAlive);
  assert.equal(am.accounts[0].resetGrants.stale, true);
  assert.ok(logs.some(l => /listing FAILED \(timed out\)/.test(l)));
});

// ── TUI ───────────────────────────────────────────────────────────────────────
function rstCell(am) {
  const tui = new TUI({ accountManager: am });
  return strip(tui._renderAcct(0, 11, true));
}

test('TUI: fresh count renders "2~119d" (no ?), stale renders a trailing "?"', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD());
  assert.match(rstCell(am), /2~119d(?!\?)/);
  am.applyResetGrants(0, { error: 'HTTP 503' });
  const line = rstCell(am);
  assert.match(line, /2~119d\?/, 'stale count keeps suffix + ? at width 8');
});

test('TUI: stale with a short suffix keeps the suffix and appends "?"', () => {
  const am = am1();
  am.applyResetGrants(0, { grants: [grant({ endsAt: Date.now() + 3 * DAY })], eligible: true });
  am.applyResetGrants(0, { error: 'HTTP 503' });
  assert.match(rstCell(am), /1~3d\?/);
});

test('TUI: stale marker uses gray, fresh uses green', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD());
  const tui = new TUI({ accountManager: am });
  const fresh = tui._renderAcct(0, 11, true);
  am.applyResetGrants(0, { error: 'HTTP 503' });
  const stale = tui._renderAcct(0, 11, true);
  assert.ok(/\x1b\[[0-9;]*m2~119d/.test(fresh));
  assert.ok(!/2~119d\?/.test(strip(fresh)) && /2~119d\?/.test(strip(stale)));
  assert.notEqual(fresh, stale);
});

// ── snapshot (cloud → Mac) ────────────────────────────────────────────────────
test('snapshot carries the stale flag cloud→Mac', () => {
  const cloud = am1();
  cloud.applyResetGrants(0, GOOD());
  cloud.applyResetGrants(0, { error: 'HTTP 503' });
  const row = cloud.getStatus().accounts[0];
  assert.equal(row.resetGrants.stale, true);
  assert.equal(row.resetGrants.grants.length, 2);
  const mac = new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k' }], 0.9);
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1', key: 'mp-x' });
  link.lastError = null; link.lastOkAt = Date.now(); link.status = { accounts: [row] };
  mac.syncRemoteMirrors(link);
  const mirror = mac.accounts.find(a => a.remote);
  assert.equal(mirror.resetGrants.stale, true, 'mirror keeps the stale marker');
  assert.equal(mirror.resetGrants.grants.length, 2);
});

// ── FIX B: ttfb ───────────────────────────────────────────────────────────────
test('markFirstByte fires once, on the first flush, and never alters the response', async () => {
  let n = 0;
  const srv = http.createServer((req, res) => {
    markFirstByte(res, () => { n++; });
    assert.equal(n, 0, 'nothing flushed yet');
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('a'); res.write('b'); res.end('c');
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    assert.equal(await r.text(), 'abc');
    assert.equal(n, 1);
  } finally { srv.close(); }
});

test('request log line keeps its exact prefix and gains ttfb= at the END', async () => {
  const lines = [];
  const orig = console.log;
  const tui = Object.create(TUI.prototype);
  tui.am = { accounts: [] };
  tui.log = []; tui.running = false; tui.render = () => {}; tui.active = new Map();
  tui._addLog = m => lines.push(m);
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_01X', type: 'message', role: 'assistant', model: 'claude-3-5-haiku',
        content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
    }, 300);
  }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const upPort = up.address().port;
  const am = new AccountManager([{ name: 'acct-a', type: 'apikey', apiKey: 'sk', upstream: `http://127.0.0.1:${upPort}` }], 0.9, {});
  const proxy = createProxyServer(am, { proxy: { apiKey: 't' }, upstream: `http://127.0.0.1:${upPort}` }, {
    onRequestStart: (id, i) => tui.onRequestStart(id, i),
    onRequestRouted: (id, i) => tui.onRequestRouted(id, i),
    onRequestFirstByte: id => tui.onRequestFirstByte(id),
    onRequestEnd: (id, i) => tui.onRequestEnd(id, i),
  });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  try {
    console.log = () => {};
    await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 't', 'x-maxpool-session': 'term-abcdef-1234' },
      body: JSON.stringify({ model: 'claude-3-5-haiku', max_tokens: 8,
        system: [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }],
        messages: [{ role: 'user', content: 'build X' }] }) });
    const line = lines.find(l => l.includes('→ acct-a'));
    assert.ok(line, lines.join(' | '));
    assert.match(line, /^POST \/v1\/messages → acct-a \((\w+), ([0-9.]+)s\)  \[cv [0-9a-f]{8} term-abc\] ttfb=[0-9.]+s$/);
    const total = Number(/, ([0-9.]+)s\)/.exec(line)[1]);
    const ttfb = Number(/ttfb=([0-9.]+)s$/.exec(line)[1]);
    assert.ok(ttfb >= 0.3 && ttfb <= total, `ttfb ${ttfb} reflects the 300ms upstream wait and is <= total ${total}`);
  } finally { console.log = orig; proxy.close(); up.close(); }
});

test('request with no byte sent omits ttfb (log line unchanged)', () => {
  const lines = [];
  const tui = Object.create(TUI.prototype);
  tui.am = { accounts: [] }; tui.log = []; tui.running = false; tui.render = () => {}; tui.active = new Map();
  tui._addLog = m => lines.push(m);
  tui.onRequestStart(1, { method: 'POST', path: '/v1/messages' });
  tui.onRequestRouted(1, { account: 'a1' });
  tui.onRequestEnd(1, { method: 'POST', path: '/v1/messages', account: 'a1', status: 499 });
  assert.match(lines[0], /^POST \/v1\/messages → a1 \(499, [0-9.]+s\)$/);
});

test('index.js forwards the first-byte hook to the TUI (production wiring pin)', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /onRequestFirstByte:\s*\(id\)\s*=>\s*\{\s*tui\?\.onRequestFirstByte\(id\);?\s*\}/);
});

// ── TEST 31 (D): ttfb measures the UPSTREAM wait of the attempt that served ────
// Shared harness: a TUI capturing the request log line, a proxy over oauth
// accounts pointed at `up`, and the line's (total, ttfb) parsed.
function ttfbHarness() {
  const lines = [];
  const tui = Object.create(TUI.prototype);
  tui.am = { accounts: [] }; tui.log = []; tui.running = false; tui.render = () => {}; tui.active = new Map();
  tui._addLog = m => lines.push(m);
  const hooks = {
    onRequestStart: (id, i) => tui.onRequestStart(id, i),
    onRequestRouted: (id, i) => tui.onRequestRouted(id, i),
    onRequestFirstByte: id => tui.onRequestFirstByte(id),
    onRequestEnd: (id, i) => tui.onRequestEnd(id, i),
  };
  const parse = (acct) => {
    const line = lines.find(l => l.includes(`→ ${acct}`));
    assert.ok(line, lines.join(' | '));
    assert.match(line, /ttfb=[0-9.]+s$/);
    return { line, total: Number(/, ([0-9.]+)s\)/.exec(line)[1]), ttfb: Number(/ttfb=([0-9.]+)s$/.exec(line)[1]) };
  };
  return { lines, hooks, parse };
}
const oauthAccts = (n) => Array.from({ length: n }, (_, i) =>
  ({ name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000 }));

test('queued request: ttfb = the upstream wait only — the queue wait (heartbeats included) is excluded', async () => {
  const { hooks, parse } = ttfbHarness();
  // Upstream answers 800ms after the request reaches it.
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: {"type":"message_delta","usage":{"output_tokens":1}}\n\n');
    }, 800);
  }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  // The only account is benched for ~600ms: the request QUEUES (heartbeat pings
  // reach the client during the wait) before it is forwarded.
  const am = new AccountManager(oauthAccts(1), 0.9);
  am.accounts[0].status = 'throttled';
  am.accounts[0].rateLimitedUntil = Date.now() + 600;
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up.address().port}`,
    queue: { enabled: true, maxWaitMs: 5000, pollMs: 20, heartbeatMs: 50 },
  }, hooks);
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const orig = console.log;
  try {
    console.log = () => {};
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', stream: true, messages: [] }) });
    const text = await res.text();
    assert.match(text, /event: ping/, 'precondition: the request really QUEUED (heartbeat pings were sent)');
    const { total, ttfb } = parse('a1');
    assert.ok(total >= 1.3, `precondition: total ${total}s covers queue (~0.6s) + upstream (~0.8s)`);
    assert.ok(ttfb >= 0.7, `ttfb ${ttfb}s reflects the ~800ms upstream wait`);
    assert.ok(ttfb <= total - 0.4, `ttfb ${ttfb}s excludes the ~600ms queue wait (total ${total}s)`);
  } finally { console.log = orig; proxy.closeAllConnections?.(); proxy.close(); up.close(); }
});

test('failover: ttfb is the SERVING attempt\'s upstream wait — a quick 429 on the first account never anchors it', async () => {
  const { hooks, parse } = ttfbHarness();
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    if (req.headers.authorization === 'Bearer t1') {          // first attempt: instant 429
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error' } }));
      return;
    }
    setTimeout(() => {                                         // failover attempt: 800ms upstream wait
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    }, 800);
  }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const am = new AccountManager(oauthAccts(2), 0.9);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up.address().port}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  }, hooks);
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const orig = console.log;
  try {
    console.log = () => {};
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', messages: [] }) });
    assert.equal(res.status, 200);
    await res.text();
    const { ttfb } = parse('a2');
    assert.ok(ttfb >= 0.7, `ttfb ${ttfb}s is the serving attempt's ~800ms wait, not the first attempt's instant 429`);
  } finally { console.log = orig; proxy.closeAllConnections?.(); proxy.close(); up.close(); }
});

test('an upstream that never answers stamps no upstream ttfb (a failed fetch is not a first byte)', async () => {
  const { lines, hooks } = ttfbHarness();
  // Nothing listens on this port: every fetch fails before any upstream byte.
  const dead = http.createServer();
  await new Promise(r => dead.listen(0, '127.0.0.1', r));
  const deadPort = dead.address().port;
  await new Promise(r => dead.close(r));
  const am = new AccountManager(oauthAccts(1), 0.9);
  const ends = [];
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${deadPort}` },
    { ...hooks, onRequestEnd: (id, i) => { ends.push(i); hooks.onRequestEnd(id, i); } });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const orig = console.log;
  try {
    console.log = () => {};
    const res = await fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', messages: [] }) });
    await res.text();
    assert.ok(ends.length >= 1, lines.join(' | '));
    assert.equal(ends.at(-1).firstUpstreamByteAt, null, 'no upstream-byte stamp on a failed fetch');
    assert.equal(ends.at(-1).upstreamForwardStartAt, null, 'and no forward-start pair either');
  } finally { console.log = orig; proxy.closeAllConnections?.(); proxy.close(); }
});

// ── Restart persistence (2026-11-10, live during the 1.24.84 rollout: local rows
// blanked 17:18–17:22Z because the serialized grants sweep takes minutes to re-list
// all accounts after every seamless reload). A grants snapshot rides the quota state
// file; restore marks it STALE (count shown, never claimed off a restored listing).
test('resetGrants snapshot survives export → restore across a restart (marked stale)', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD(), 1000);
  const saved = am.exportQuotaState();
  assert.equal(saved[0].resetGrants.grants.length, 2, 'snapshot carries the grants');

  const am2 = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  am2.restoreQuotaState(saved);
  const rg = am2.accounts[0].resetGrants;
  assert.ok(rg, 'restored account has grants');
  assert.equal(rg.grants.length, 2, 'count survives the restart');
  assert.equal(rg.stale, true, 'restored listing is STALE — proof, not a live read');
});

test('restore never overwrites a live listing the new process already made', () => {
  const am = am1();
  am.applyResetGrants(0, GOOD(), 1000);
  const saved = am.exportQuotaState();

  const am2 = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  am2.applyResetGrants(0, GOOD(), 5000);          // live listing BEFORE restore
  am2.restoreQuotaState(saved);
  assert.equal(am2.accounts[0].resetGrants.checkedAt, 5000, 'live listing wins over the restored snapshot');
  assert.notEqual(am2.accounts[0].resetGrants.stale, true);
});

test('no grants → no resetGrants key in the snapshot (null stays null)', () => {
  const am = am1();
  const saved = am.exportQuotaState();
  assert.equal(saved[0].resetGrants, undefined, 'never-good account persists no grants');
});
