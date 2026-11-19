// Two-line Cache/Moves screen (owner question 2026-11-19: the single Cache line
// answered three questions with mixed denominators and could not be parsed). This
// file pins the NEW behaviours: the 24h figure beside the 15m one (hourly buckets,
// restart-safe), the move WHY split (outscored / hold-ceiling / released) booked from
// the routing loop's own reason string, and the separation itself — cache health on
// the Cache line, causes on the Moves line, nothing doubled.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const acct = (n, type = 'oauth', extra = {}) => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, ...extra });
const glmAcct = (n) => ({ ...acct(n, 'provider'), provider: 'zai', apiKey: `k-${n}` });
const lease = (a, requestInfo = {}) => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo }; };
const served = (m, a, u = {}, extra = {}) => m.releaseAccount(lease(a), { success: true, status: 200, usage: u, ...extra });
const tui = (m) => new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });

// ── 24h rollup ───────────────────────────────────────────────────────────────

test('24h: the Cache line shows the 24h hit beside the 15m one, and it survives restart', () => {
  const m = new AccountManager([acct('c1'), glmAcct('g1')], 0.9);
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 9900, cc: 100, out: 10 });
  const line = strip(tui(m)._cacheLine(200));
  assert.match(line, /\[15m\/24h\].*Claude 98%\/98%/, `Claude's two measured windows stay together: ${line}`);
  assert.match(line, /GLM —\/—/, 'idle providers retain named placeholders');
  // Export → a fresh manager (restart) → same 24h figure from the restored buckets.
  const saved = m.exportEfficiencyHours();
  assert.ok(saved && saved.c1, 'export carries the account buckets');
  const m2 = new AccountManager([acct('c1'), glmAcct('g1')], 0.9);
  m2.restoreEfficiencyHours(saved);
  assert.match(strip(tui(m2)._cacheLine(200)), /Claude —\/98% · GLM —\/—/, 'restored history is visible before the first new request');
  served(m2, m2.accounts[0], { in: 100, cr: 9900, cc: 100, out: 10 });
  assert.equal(m2.efficiency24h().claude.served, 31, 'restored 30 + 1 live');
  assert.match(strip(tui(m2)._cacheLine(200)), /Claude 98%\/98%/, 'a live reading sits beside the restored history');
});

test('24h: hourly buckets older than the window are dropped on restore and on fold', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  const a = m.accounts[0];
  a.efficiencyHours = {};
  const key = (hAgo) => new Date(Date.now() - hAgo * 3600_000).toISOString().slice(0, 13);
  a.efficiencyHours[key(30)] = { served: 999, in: 1, out: 1, cr: 1, cc: 1, bounced: 0, movedCross: 0, movedSame: 0 };
  a.efficiencyHours[key(2)] = { served: 10, in: 100, cr: 9900, cc: 0, bounced: 0, movedCross: 0, movedSame: 0 };
  const e24 = m.efficiency24h();
  assert.equal(e24.claude.served, 10, '30h-old bucket excluded by the window');
  assert.ok(Math.abs(e24.claude.hit - 0.99) < 1e-9);
  // restoreEfficiencyHours refuses the stale bucket too.
  const m2 = new AccountManager([acct('c1')], 0.9);
  m2.restoreEfficiencyHours(m.exportEfficiencyHours());
  assert.equal(m2.efficiency24h().claude.served, 10, 'restore dropped the stale bucket');
});

test('24h: the figure renders with real volume and hides when there is none', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  // lowVolume needs ≥20 served AND ≥100k prompt tokens in the 15m window.
  for (let i = 0; i < 25; i++) served(m, m.accounts[0], { in: 1000, cr: 9000, cc: 0, out: 1 });
  const line = strip(tui(m)._cacheLine(200));
  assert.match(line, /Claude 90%\/90%/, `real volume shows the 24h figure: ${line}`);
  // Wipe the buckets: 15m still has traffic, 24h has none → the dash family.
  m.accounts[0].efficiencyHours = {};
  const line2 = strip(tui(m)._cacheLine(200));
  assert.match(line2, /Claude 90%\/— · GLM —\/—/, `an unmeasured 24h has no percentage: ${line2}`);
});

// ── movedWhy plumbing ────────────────────────────────────────────────────────

const claudeForWhy = (n) => acct(n);
const riWhy = (over = {}) => ({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000, profile: 'all', ...over });

test('why: a warm-hold release reason from a REAL pick reaches the Moves line', () => {
  const m = new AccountManager([claudeForWhy('a1'), claudeForWhy('a2'), claudeForWhy('a3')], 0.9,
    { routingMode: 'balance', crossProviderFallbackPolicy: 'always' });
  const a1 = m.accounts.find(x => x.name === 'a1');
  // Warm the conversation on a1, then load a1 past the in-flight ceiling (6) so the
  // hold releases and the loop logs why=released:hold-ceiling(...).
  m._noteConversationAccount(riWhy(), a1); m.noteConversationServed(riWhy(), a1);
  a1.activeWeight = 60; a1.inFlight = 6;
  const pick = m.acquireAccount(riWhy());
  assert.ok(pick, 'a lease was acquired');
  assert.notEqual(pick.account.name, 'a1', 'the conversation moved off the overloaded holder');
  // The request now carries the why= the move log prints.
  assert.match(pick.requestInfo._moveWhy, /^released:hold-ceiling\(inflight=\d+\/\d+\)$/,
    `why stamped on the request: ${pick.requestInfo._moveWhy}`);
  // And the served event books it into movedByWhy.
  m.releaseAccount(pick, { success: true, status: 200, usage: { in: 10, cr: 990, cc: 0, out: 1 } });
  const e = m.efficiencyOverall('last15m').claude;
  assert.equal(e.movedByWhy.holdCeiling, 1, `booked: ${JSON.stringify(e.movedByWhy)}`);
  const moves = strip(tui(m)._movesLine(200));
  assert.match(moves, /hold-ceiling 1/, `shown on the Moves line: ${moves}`);
});

test('why: an outscored string and an unknown string classify into the right family', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  const a = m.accounts[0];
  const mk = (why) => m.releaseAccount(lease(a), { success: true, status: 200, usage: { in: 1, cr: 9, cc: 0, out: 1 },
    moved: true, movedSame: true, movedWhy: why });
  mk('outscored:12.3(concurrency+9.0;bonus=400;depth=60/10)');
  mk('released:hold-ceiling(inflight=7/6)');
  mk('released:quota(5h)');
  mk('error:boom');
  const e = m.efficiencyOverall('last15m').claude;
  assert.equal(e.movedByWhy.outscored, 1);
  assert.equal(e.movedByWhy.holdCeiling, 1);
  assert.equal(e.movedByWhy.released, 1);
  assert.equal(e.movedByWhy.other, 1);
});

// ── the split itself ─────────────────────────────────────────────────────────

test('layout: Cache and Moves render as TWO lines, Cache first, no cost proxy anywhere', () => {
  const m = new AccountManager([acct('c1'), glmAcct('g1')], 0.9);
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 9900, cc: 500, out: 10 });
  for (let i = 0; i < 10; i++) served(m, m.accounts[1], { in: 100, cr: 9900, cc: 0, out: 10 });
  const t = tui(m);
  const cache = strip(t._cacheLine(200));
  const moves = strip(t._movesLine(200));
  assert.match(cache, /^ Cache /);
  assert.match(moves, /^ Moves /);
  assert.doesNotMatch(cache, /of cost/, `no cost proxy on screen: ${cache}`);
  assert.doesNotMatch(moves, /of cost/, `no cost proxy on screen: ${moves}`);
  // No duplicated counts between the lines: cross/same/bounced appear on Moves only.
  assert.doesNotMatch(cache, /cross|bounced/, `cache line is health only: ${cache}`);
  assert.ok(moves.includes('cross'), `moves line carries the move figures: ${moves}`);
});

test('moves: bounced names its worst account only above 5%', () => {
  const m = new AccountManager([acct('c1'), acct('c2')], 0.9);
  for (let i = 0; i < 40; i++) served(m, i % 2 ? m.accounts[1] : m.accounts[0], { in: 1000, cr: 9000, cc: 0, out: 10 });
  // 2 bounces of 42 = 4.8% — below the 5% bar, no worst-account suffix.
  m.releaseAccount(lease(m.accounts[0]), { success: false, bounced: true, status: 503, refusal: 'busy' });
  m.releaseAccount(lease(m.accounts[0]), { success: false, bounced: true, status: 503, refusal: 'busy' });
  let moves = strip(tui(m)._movesLine(200));
  assert.match(moves, /bounced 5%/, `share shown: ${moves}`);
  assert.doesNotMatch(moves, /worst:/, `no account named at 5%: ${moves}`);
  // 6 bounces of 46 ≈ 13% — above the bar, the worst account is named inline.
  for (let i = 0; i < 4; i++) m.releaseAccount(lease(m.accounts[0]), { success: false, bounced: true, status: 503, refusal: 'busy' });
  moves = strip(tui(m)._movesLine(200));
  assert.match(moves, /bounced 13% \(worst: c1\)/, `worst named above 5%: ${moves}`);
});
