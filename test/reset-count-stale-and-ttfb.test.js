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
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ status: 500, error: 'x' }),
    grantsFn: async () => (mode === 'ok' ? GOOD() : mode === 'throw' ? (() => { throw new Error('boom'); })() : { error: 'HTTP 502' }) });
  prober._claimClaudeGrant = async () => {};
  const rg = () => logs.filter(l => l.startsWith('[reset-grant] a1:'));
  await prober.probeOne(am.accounts[0]);
  assert.equal(rg().length, 0, 'healthy: silent');
  mode = 'fail';
  await prober.probeOne(am.accounts[0]); await prober.probeOne(am.accounts[0]); mode = 'throw'; await prober.probeOne(am.accounts[0]);
  assert.equal(rg().length, 1, 'three failures in a row log ONE line');
  assert.match(rg()[0], /listing FAILED \(HTTP 502\)/);
  assert.equal(am.accounts[0].resetGrants.stale, true, 'a throw is a failed listing too');
  mode = 'ok';
  await prober.probeOne(am.accounts[0]); await prober.probeOne(am.accounts[0]);
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
  assert.match(line, /2\?/, 'stale count still shown, marked');
  assert.doesNotMatch(line, /2~119d/, 'long expiry suffix is trimmed to keep the column width');
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
  assert.ok(!/2\?/.test(fresh) && /2\?/.test(strip(stale)));
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
