// Cache-affinity routing (owner 2026-11-08): in balance mode a conversation stays
// on the account it used last unless real pressure (load gap, quota wall,
// exclusion, failure) says move — because the prompt cache is per account and a
// hop re-writes the whole prefix (72% of all Anthropic cache writes over 24h).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { __serverTest } from '../src/server.js';

const acct = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const am = (n = 3, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => acct(`a${i + 1}`)), 0.9,
  { routingMode: 'balance', ...opts });
const release = (l) => am_ref.releaseAccount(l, { status: 200, success: true });
let am_ref;
const acquire = (mgr, sessionKey = 'sess-x', excluded) => mgr.acquireAccount({ sessionKey, model: 'claude-opus-5-5', weight: 10 }, excluded);

test('balance: consecutive turns stay on the same account at comparable load', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); assert.ok(first, 'first acquire');
  const name1 = first.account.name; release(first);
  const second = acquire(m);
  assert.equal(second.account.name, name1, 'second turn stays on the first account');
  release(second);
});

test('balance: a major load gap moves the session (two large turns of extra depth)', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const sibling = m.accounts.find(a => a.name !== name1);
  sibling.activeWeight = 0; sibling.inFlight = 0;
  // ~100 weight units of extra depth on the bound account (≈1200 points) — far past the bonus:
  first.account.activeWeight = 1200;
  const moved = acquire(m, 'sess-x');
  assert.notEqual(moved.account.name, name1, 'session moved off the heavily loaded account');
  release(moved);
});

test('balance: exclusion of the last-used account fails over immediately', () => {
  const m = am(); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const second = acquire(m, 'sess-x', new Set([first.account.index]));
  assert.ok(second && second.account.name !== name1, 'served by another account');
  release(second);
});

test('bonus is configurable: 0 restores pure balancing (turn can hop)', () => {
  const m = am(2, { cacheAffinityBonus: 0 }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  m.accounts.forEach(a => { a.activeWeight = 0; });
  // Without the bonus the sibling is now strictly lighter → pure balancing hops.
  const sibling = m.accounts.find(a => a.name !== name1); sibling.activeWeight = 0;
  first.account.activeWeight = 20;
  const second = acquire(m);
  assert.notEqual(second.account.name, name1, 'no bonus → hops to the lighter account');
  release(second);
});

test('sticky mode: binding path unchanged (returns the bound account regardless of siblings)', () => {
  const m = am(2, { routingMode: 'sticky' }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.activeWeight = 500; // heavy home still returned in sticky mode
  const second = acquire(m);
  assert.equal(second.account.name, name1);
  release(second);
});

// ── HOLD-UNTIL-CANNOT-SERVE (owner 2026-11-08) ─────────────────────────────────
// Replaces the old rule that dropped affinity at the 85% weekly reserve tier / 85% of
// the 5h window. A move costs one full re-store whenever it happens, so leaving at 85%
// buys nothing; the conversation now stays until the account truly cannot serve.
// switchThreshold 0.99 here: Claude benches its 5h window at switchThreshold (0.90 in
// prod) — below that the account is a normal candidate and the hold must survive.
const am99 = (n = 2, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => acct(`a${i + 1}`)), 0.99, { routingMode: 'balance', ...opts });
const captureLogs = (fn) => {
  const logs = []; const orig = console.log;
  console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  try { fn(); } finally { console.log = orig; }
  return logs;
};
const FAR = () => Date.now() + 3 * 86400_000;

test('HOLD: stays through the 5-hour window at 0.90 (old rule released at 0.85)', () => {
  const m = am99(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified5h = 0.9; first.account.quota.unified5hReset = Date.now() + 3600_000;
  first.account.activeWeight = 20; // modest extra load: only the hold keeps it here
  const next = acquire(m);
  assert.equal(next.account.name, name1, '5h at 0.90 still serves → conversation stays');
  release(next);
});

test('HOLD: stays in the weekly reserve tier (0.90 weekly; old rule released at 0.85)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified7d = 0.9; first.account.quota.unified7dReset = FAR();
  m.accounts.find(a => a !== first.account).quota.unified7d = 0.1;
  first.account.activeWeight = 20;
  assert.equal(m._weeklyRawState(first.account), 'reserve', 'fixture is in the reserve tier');
  const next = acquire(m);
  assert.equal(next.account.name, name1, 'reserve tier still serves → conversation stays');
  release(next);
});

test('HOLD: GLM weekly-less plan tiers on its 5h reading — held at 0.90, released at the wall', () => {
  const m = am(1); am_ref = m;
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const glm = m.accounts.find(a => a.type === 'provider');
  glm.quota.weeklyAbsent = true; // z.ai plan with no weekly window: _weeklyRawState follows the 5h reading
  m._noteConversationAccount({ sessionKey: 'sess-g' }, glm);
  glm.quota.providerSes = 0.9;
  assert.equal(m._weeklyRawState(glm), 'reserve', 'the exact state the old 0.85 gate released');
  assert.ok(m._cacheAffinity(glm, { sessionKey: 'sess-g' }) > 0, '0.90 → held (reserve tier: tighter-capped, 320)');
  glm.quota.providerSes = 0.96; // weekly ladder says critical (≥0.95), no unlock → cannot serve in pass 1
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 0, '0.96 → released');
  // Plan WITH a weekly window: only the 5h wall gate decides.
  glm.quota.weeklyAbsent = false; glm.quota.providerWk = 0.2;
  glm.quota.providerSes = 0.96;
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 400, '0.96 with a healthy weekly → still held (below the 0.97 wall)');
  glm.quota.providerSes = 0.975;
  assert.equal(m._cacheAffinity(glm, { sessionKey: 'sess-g' }), 0, 'at/over the wall → released');
});

test('RELEASE: 5-hour window at/over the wall (0.97) lets the conversation go; just under holds', () => {
  assert.equal(new AccountManager([acct('x')], 0.9, {}).scheduler.cacheAffinityFiveHourWall, 0.97, 'named scheduler constant');
  const m = am99(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified5hReset = Date.now() + 3600_000;
  first.account.activeWeight = 20;
  first.account.quota.unified5h = 0.96;
  assert.equal(m._affinityRelease(first.account), null, '0.96 → hold');
  first.account.quota.unified5h = 0.98;
  assert.match(m._affinityRelease(first.account), /^5h-0\.98$/, '0.98 → gate named');
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'at the 5h wall → conversation moves');
  release(next);
});

test('RELEASE: critical weekly without an unlock cannot serve → moves; an unlock keeps the hold', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified7d = 0.96; first.account.quota.unified7dReset = FAR();
  assert.equal(m._weeklyRawState(first.account), 'critical');
  assert.equal(m._affinityRelease(first.account, null), 'critical-no-unlock');
  assert.equal(m._affinityRelease(first.account, { reason: 'pressure' }), null, 'a situational unlock makes it servable → hold');
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'critical, no unlock → not selectable → conversation moves');
  release(next);
});

test('RELEASE: exhausted/capped weekly cannot serve (benched in every pass) — gate named', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); release(first);
  first.account.quota.unified7d = 0.9995; first.account.quota.unified7dReset = FAR();
  assert.equal(m._weeklyRawState(first.account), 'exhausted');
  assert.equal(m._affinityRelease(first.account), 'weekly-exhausted');
  first.account.quota.unified7d = 0.5; first.account.capUtilization = 0.4; first.account.capMode = 'reserve'; first.account.capCeiling = 0.3;
  assert.equal(m._weeklyRawState(first.account), 'capped', 'a usage cap outranks the tier ladder');
  assert.equal(m._affinityRelease(first.account), 'weekly-capped');
});

test('RELEASE: an unlocked critical account KEEPS the hold (unlock threads into the affinity)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified7d = 0.96; first.account.quota.unified7dReset = FAR();
  const orig = m._criticalUnlock.bind(m);
  m._criticalUnlock = (a) => (a === first.account ? { reason: 'prereset', etaMs: 30 * 60_000 } : orig(a));
  assert.ok(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }, { reason: 'prereset' }) > 0,
    'with the situational unlock the account is servable, so the hold is live');
  const next = acquire(m);
  assert.equal(next.account.name, name1, 'unlocked critical holds the conversation (cheapest: criticalDrain cost)');
  release(next);
});

test('RELEASE: a 429 on the bound account moves the conversation on the very next request', () => {
  const m = am(3); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  // Healthy and holding before the throttle:
  const again = acquire(m); assert.equal(again.account.name, name1); release(again);
  m.markRateLimited(first.account.index, 30); // what the proxy does on an upstream 429
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'throttled account releases its bound conversation immediately');
  release(next);
});

test('RELEASE: a cooldown on the bound account moves the conversation on the very next request', () => {
  const m = am(3); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.cooldownUntil = Date.now() + 30_000;
  const next = acquire(m);
  assert.notEqual(next.account.name, name1);
  release(next);
});

test('LOAD GAP beats the hold: deep in-flight from OTHER conversations moves a bound conversation', () => {
  const m = am(3); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  // Other conversations (same terminal, distinct hashes) pile onto the bound account:
  const others = [];
  for (let i = 0; i < 6; i++) {
    const l = m.acquireAccount({ sessionKey: 'sess-x', affinityKey: `sess-x:OTHER-${i}`, model: 'claude-opus-5-5', weight: 10 },
      new Set(m.accounts.filter(a => a.name !== name1).map(a => a.index)));
    assert.equal(l.account.name, name1); others.push(l);
  }
  assert.ok(first.account.activeWeight >= 60, 'bound account is carrying 6 concurrent turns');
  const moved = acquire(m, 'sess-x');
  assert.notEqual(moved.account.name, name1, 'depth past the hold → the bound conversation leaves');
  release(moved); others.forEach(release);
});

test('SPREAD: parallel conversations bound to ONE account fan out as depth grows (worst-case concentration)', () => {
  const m = am(3); am_ref = m;
  const home = m.accounts[0];
  const N = 8; const keys = Array.from({ length: N }, (_, i) => `term-1:C${i}`);
  keys.forEach(k => m._noteConversationAccount({ affinityKey: k }, home)); // all bound to a1
  const leases = keys.map(k => m.acquireAccount({ sessionKey: 'term-1', affinityKey: k, model: 'claude-opus-5-5', weight: 10 }));
  const per = {}; leases.forEach(l => { per[l.account.name] = (per[l.account.name] || 0) + 1; });
  // Measured shape at weight 10: the first 4 hold (depth 40 vs 0 → 120/turn past the target
  // against the 400 bonus), the 5th and 6th leave, then siblings are loaded too and a1 is
  // cheapest again. Without the load-gap escape all 8 would stay on a1.
  assert.ok(per[home.name] <= 5, `a1 must not take them all: ${JSON.stringify(per)}`);
  assert.equal(Object.keys(per).length, 3, `both siblings absorb the overflow: ${JSON.stringify(per)}`);
  assert.ok(home.activeWeight <= 50, `a1 depth stays bounded: ${home.activeWeight}`);
  leases.forEach(release);
});

test('SPREAD: NEW parallel conversations from one terminal never stack on one account', () => {
  const m = am(3); am_ref = m;
  const leases = Array.from({ length: 6 }, (_, i) => m.acquireAccount({ sessionKey: 'term-1', affinityKey: `term-1:N${i}`, model: 'claude-opus-5-5', weight: 10 }));
  const per = {}; leases.forEach(l => { per[l.account.name] = (per[l.account.name] || 0) + 1; });
  assert.equal(Object.keys(per).length, 3, `all three accounts used: ${JSON.stringify(per)}`);
  assert.ok(Math.max(...Object.values(per)) <= 3, JSON.stringify(per));
  leases.forEach(release);
});

test('STEERING terms do not move a held conversation: they are zeroed for the bound account only', () => {
  // Bonus 12: above the reserve account's tighter concurrency-target step (+10, a LOAD term that
  // deliberately stays) but below its steering terms (~16) — only the structural exclusion holds it.
  const m = am(2, { cacheAffinityBonus: 12 }); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  const q = first.account.quota;
  q.unified7d = 0.9; q.unified7dReset = FAR();   // reserve overflow cost ≥ 5+
  q.unified5h = 0.8; q.unified5hReset = Date.now() + 4 * 3600_000; // pace + utilization cost
  const held = m._scoreTerms(first.account, { sessionKey: 'sess-x' }, null);
  for (const k of ['paceCost', 'utilizationCost', 'scopedPace', 'spread', 'ramp', 'reserveCost', 'criticalCost']) assert.equal(held[k], 0, `${k} zeroed while held`);
  const other = m._scoreTerms(first.account, { sessionKey: 'someone-else' }, null);
  assert.ok(other.reserveCost > 0 && other.utilizationCost > 0, 'a NEW conversation still pays them (they steer new work)');
  const next = acquire(m);
  assert.equal(next.account.name, name1, 'quota pressure alone does not pull a bound conversation');
  release(next);
});

// ── why= reason on the move line ───────────────────────────────────────────────
const movedLine = (m, firstAcct, excl, mutate, profile) => {
  let line;
  const logs = captureLogs(() => {
    mutate?.(firstAcct);
    const l = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000, profile }, excl);
    m.releaseAccount(l, { status: 200, success: true });
  });
  line = logs.find(x => x.includes('conversation moved:'));
  return line;
};
const bindFirst = (m) => {
  const f = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000 });
  m.releaseAccount(f, { status: 200, success: true });
  return f.account;
};

test('why=: failure streak → released:failures-N', () => {
  const m = am(2); am_ref = m; const a = bindFirst(m);
  assert.match(movedLine(m, a, undefined, x => { x.consecutiveFailures = 2; }), /why=released:failures-2$/);
});
test('why=: 5h wall → released:5h-0.98', () => {
  const m = am99(2); am_ref = m; const a = bindFirst(m);
  assert.match(movedLine(m, a, undefined, x => { x.quota.unified5h = 0.98; x.quota.unified5hReset = Date.now() + 3600_000; }), /why=released:5h-0\.98$/);
});
test('why=: exclusion → released:excluded', () => {
  const m = am(2); am_ref = m; const a = bindFirst(m);
  assert.match(movedLine(m, a, new Set([a.index])), /why=released:excluded$/);
});
test('why=: 429 bench → released:unavailable(rate-limited)', () => {
  const m = am(2); am_ref = m; const a = bindFirst(m);
  assert.match(movedLine(m, a, undefined, x => m.markRateLimited(x.index, 30)), /why=released:unavailable\(rate-limited\)$/);
});
test('why=: critical weekly → released:unavailable(weekly-critical)', () => {
  const m = am(2); am_ref = m; const a = bindFirst(m);
  assert.match(movedLine(m, a, undefined, x => { x.quota.unified7d = 0.96; x.quota.unified7dReset = FAR(); }), /why=released:unavailable\(weekly-critical\)$/);
});
test('why=: load gap → outscored:<delta>(dominant terms; bonus; depth)', () => {
  const m = am(2); am_ref = m; const a = bindFirst(m);
  const line = movedLine(m, a, undefined, x => { x.activeWeight = 1200; });
  assert.match(line, /why=outscored:\d+\.\d\((capPenalty|concurrency)\+[\d.]+,(capPenalty|concurrency)\+[\d.]+;bonus=400;depth=1200\/0\)$/, line);
});
test('why=: peak-suppressed provider (priority tier) → released:priority-tier', () => {
  const m = am(1, { crossProviderFallbackPolicy: 'always' }); am_ref = m;
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const glm = m.accounts.find(a => a.type === 'provider');
  m._peakTier = (a) => (a.type === 'provider' ? 1 : 0); // provider peak de-preference active
  m._noteConversationAccount({ sessionKey: 's', affinityKey: 's:h' }, glm);
  assert.match(movedLine(m, glm, undefined, undefined, 'all'), /why=released:priority-tier$/);
});

test('affinity releases after a failure on the last-used account', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.consecutiveFailures = 1; // failed recently, not cooling down
  first.account.activeWeight = 20;
  const next = acquire(m);
  assert.notEqual(next.account.name, name1, 'a failing account loses its hold on the conversation');
  release(next);
});

test('sticky mode: no affinity discount (its rebalance must be able to leave a hot account)', () => {
  const m = am(2, { routingMode: 'sticky' }); am_ref = m;
  const first = acquire(m); release(first);
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 0);
});

test('prefer-claude mode: affinity applies too (scored mode)', () => {
  const m = am(2, { routingMode: 'prefer-claude' }); am_ref = m;
  const first = acquire(m); release(first);
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 400);
});

test('affinity HOLDS in the soft weekly tier (65-85% — normal mid-week)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); release(first);
  first.account.quota.unified7d = 0.72; first.account.quota.unified7dReset = Date.now() + 3 * 86400_000;
  assert.equal(m._weeklyRawState(first.account), 'soft', 'fixture is in the soft tier');
  assert.equal(m._cacheAffinity(first.account, { sessionKey: 'sess-x' }), 400);
});

test('fan-out: subagents on other accounts do not drag the MAIN conversation off its account', () => {
  const m = am(3); am_ref = m;
  const main = { sessionKey: 'term-1', affinityKey: 'term-1:MAIN', model: 'claude-opus-5-5', weight: 10 };
  const first = m.acquireAccount(main); const home = first.account.name;
  m.releaseAccount(first, { status: 200, success: true });
  // Same terminal, different conversations (subagents) forced onto the OTHER accounts.
  for (const a of m.accounts.filter(x => x.name !== home)) {
    const l = m.acquireAccount({ sessionKey: 'term-1', affinityKey: `term-1:SUB-${a.name}`, model: 'claude-opus-5-5', weight: 10 },
      new Set(m.accounts.filter(x => x !== a).map(x => x.index)));
    assert.equal(l.account.name, a.name); m.releaseAccount(l, { status: 200, success: true });
  }
  const again = m.acquireAccount(main);
  assert.equal(again.account.name, home, 'main conversation returns to ITS account, not the last subagent\'s');
  m.releaseAccount(again, { status: 200, success: true });
});

test('no readable quota (Kimi console-only) → no affinity', () => {
  const m = am(1); am_ref = m;
  m.addAccount({ name: 'kimi', type: 'provider', provider: 'kimi', apiKey: 'kk' });
  const kimi = m.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerQuotaSource = 'console-only';
  m._noteConversationAccount({ sessionKey: 'k' }, kimi);
  assert.equal(m._cacheAffinity(kimi, { sessionKey: 'k' }), 0);
});

test('bonus is scaled to the row\'s per-unit price (discounted rows tolerate the same depth)', () => {
  const m = am(1); am_ref = m;
  const a = m.accounts[0];
  m._noteConversationAccount({ sessionKey: 's' }, a);
  assert.equal(m._cacheAffinity(a, { sessionKey: 's' }), 400, 'undiscounted row: full bonus');
  const orig = m._fastRefillMultiplier.bind(m);
  m._fastRefillMultiplier = () => 0.4;
  assert.ok(Math.abs(m._cacheAffinity(a, { sessionKey: 's' }) - 160) < 1e-9, 'unit at 0.4x → bonus at 0.4x');
  m._fastRefillMultiplier = orig;
});

test('conversation map is bounded (LRU)', () => {
  const m = am(1); am_ref = m;
  for (let i = 0; i < 5005; i++) m._noteConversationAccount({ affinityKey: `k${i}` }, m.accounts[0]);
  assert.equal(m.conversationLastAccount.size, 5000);
  assert.equal(m.conversationLastAccount.has('k0'), false, 'oldest dropped');
  assert.equal(m.conversationLastAccount.has('k5004'), true);
});

test('conversation hash: stable across turns, distinct per conversation (main vs subagent)', () => {
  const req = { method: 'POST', url: '/v1/messages' };
  const body = (sys, msgs) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: sys, messages: msgs }));
  const sys = [{ type: 'text', text: "You are Claude Code, Anthropic's official CLI for Claude." }];
  const t1 = __serverTest.describeRequest(req, body(sys, [{ role: 'user', content: 'build X' }]));
  const t2 = __serverTest.describeRequest(req, body(sys, [{ role: 'user', content: 'build X' }, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'next' }]));
  const sub = __serverTest.describeRequest(req, body([{ type: 'text', text: 'You are a search agent.' }], [{ role: 'user', content: 'find Y' }]));
  assert.ok(t1.conversationHash && t1.conversationHash === t2.conversationHash, 'same conversation, later turn → same key');
  assert.notEqual(t1.conversationHash, sub.conversationHash, 'a subagent is its own conversation');
});

test('bonus scales with conversation size but is CAPPED at cacheAffinityMaxExtraDepth units (anti-dogpile)', () => {
  const m = am(2); am_ref = m;
  const first = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 20_000 });
  const a = first.account; m.releaseAccount(first, { status: 200, success: true });
  const at = (bodyBytes) => m._cacheAffinity(a, { sessionKey: 's', affinityKey: 's:h', bodyBytes });
  assert.equal(at(20_000), 400, 'small conversation: base bonus');
  assert.equal(at(500_000), 480, '500K conversation: size would give 1200, cap = 40 units x 12 points = 480');
  assert.equal(at(450_000), 480);
  m.scheduler.cacheAffinityMaxExtraDepth = 100;
  assert.equal(at(500_000), 1200, 'raising the cap restores the 3x size scaling (the cap, not the multiplier, is binding)');
  m.scheduler.cacheAffinityMaxExtraDepth = 0;
  assert.equal(at(20_000), 0, 'cap 0 = the hold buys no depth at all');
});

test('cap is priced per row: a discounted GLM row buys the same DEPTH (units), fewer points', () => {
  const m = am(1); am_ref = m;
  const a = m.accounts[0];
  m._noteConversationAccount({ sessionKey: 's' }, a);
  const orig = m._fastRefillMultiplier.bind(m);
  m._fastRefillMultiplier = () => 0.4;
  const unit = 2 * 0.4 + 10 * 0.4;
  assert.ok(Math.abs(m._cacheAffinity(a, { sessionKey: 's', bodyBytes: 500_000 }) - 40 * unit) < 1e-9);
  m._fastRefillMultiplier = orig;
});

test('cap is tighter for a reserve-tier account (reserve/perAccount concurrency-target ratio)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); release(first);
  const a = first.account;
  const ri = { sessionKey: 'sess-x', bodyBytes: 500_000 };
  assert.equal(m._cacheAffinity(a, ri), 480);
  a.quota.unified7d = 0.9; a.quota.unified7dReset = FAR();
  assert.equal(m._weeklyRawState(a), 'reserve');
  assert.ok(Math.abs(m._cacheAffinity(a, ri) - 480 * (2 / 3)) < 1e-9, 'reserve: 40 x 2/3 units x 12');
});

test('cap is tighter for an UNLOCKED critical account too (lowest-headroom tier)', () => {
  const m = am(2); am_ref = m;
  const first = acquire(m); release(first);
  const a = first.account;
  a.quota.unified7d = 0.96; a.quota.unified7dReset = FAR();
  const ri = { sessionKey: 'sess-x', bodyBytes: 500_000 };
  assert.ok(Math.abs(m._cacheAffinity(a, ri, { reason: 'prereset' }) - 480 * (2 / 3)) < 1e-9);
});

// ── anti-dogpile: parallel conversations must SPREAD at production body sizes ──
// The first red-team pass found the spread test only passed at bodyBytes ~0 (sizeMult 1);
// at 450KB the unbounded 3x bonus stacked 11 conversations on one account at depth 110.
const SIZES = [0, 20_000, 450_000, 500_000];
const TURN = 10; // weight of a ~450-500KB Claude Code turn (ceil(bytes/64KB) + thinking/max_tokens)
const fleet = (n, opts = {}) => new AccountManager(
  Array.from({ length: n }, (_, i) => acct(`a${i + 1}`)), 0.9, { routingMode: 'balance', ...opts });
const dist = (leases) => leases.reduce((o, l) => { o[l.account.name] = (o[l.account.name] || 0) + 1; return o; }, {});

for (const bytes of SIZES) {
  test(`SPREAD @${bytes}B: 20 conversations bound to one account fan out; its depth stays within cap of the shallowest sibling`, () => {
    const m = fleet(8); am_ref = m;
    const home = m.accounts[0];
    const keys = Array.from({ length: 20 }, (_, i) => `term-1:C${i}`);
    keys.forEach(k => m._noteConversationAccount({ affinityKey: k }, home));
    const leases = keys.map(k => m.acquireAccount({ sessionKey: 'term-1', affinityKey: k, model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes }));
    const per = dist(leases);
    const shallowest = Math.min(...m.accounts.slice(1).map(a => a.activeWeight));
    const bound = m.scheduler.cacheAffinityMaxExtraDepth + TURN;
    assert.ok(home.activeWeight - shallowest <= bound, `bound a1 depth ${home.activeWeight} vs shallowest sibling ${shallowest} (allowed gap ${bound}): ${JSON.stringify(per)}`);
    assert.ok(per.a1 <= 7, `no stacking: ${JSON.stringify(per)}`);
    assert.equal(Object.keys(per).length, 8, `every account takes load: ${JSON.stringify(per)}`);
    // absolute ceiling: 7 turns even though 450K bonus used to allow 11+ at depth 110
    assert.ok(home.activeWeight <= 70, `a1 depth ${home.activeWeight}`);
    leases.forEach(release);
  });

  test(`SPREAD @${bytes}B: a RESERVE-tier home (weekly 0.90) is no deeper than the same bound`, () => {
    const m = fleet(8); am_ref = m;
    const home = m.accounts[0];
    home.quota.unified7d = 0.9; home.quota.unified7dReset = FAR();
    const keys = Array.from({ length: 20 }, (_, i) => `term-1:C${i}`);
    keys.forEach(k => m._noteConversationAccount({ affinityKey: k }, home));
    const leases = keys.map(k => m.acquireAccount({ sessionKey: 'term-1', affinityKey: k, model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes }));
    const shallowest = Math.min(...m.accounts.slice(1).map(a => a.activeWeight));
    const reserveCap = m.scheduler.cacheAffinityMaxExtraDepth * (m.scheduler.reserveConcurrencyTarget / m.scheduler.perAccountConcurrencyTarget);
    assert.ok(home.activeWeight - shallowest <= reserveCap + TURN, `reserve home ${home.activeWeight} vs shallowest ${shallowest}: ${JSON.stringify(dist(leases))}`);
    assert.ok(dist(leases).a1 <= 6);
    leases.forEach(release);
  });

  test(`SPREAD @${bytes}B: NEW parallel conversations never stack on a busy bound account`, () => {
    const m = fleet(4); am_ref = m;
    const home = m.accounts[0];
    const bound = Array.from({ length: 6 }, (_, i) => `term-1:B${i}`);
    bound.forEach(k => m._noteConversationAccount({ affinityKey: k }, home));
    const held = bound.map(k => m.acquireAccount({ sessionKey: 'term-1', affinityKey: k, model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes }));
    const fresh = Array.from({ length: 12 }, (_, i) => m.acquireAccount({ sessionKey: 'term-1', affinityKey: `term-1:N${i}`, model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes }));
    const depths = m.accounts.map(a => a.activeWeight);
    assert.ok(Math.max(...depths) - Math.min(...depths) <= m.scheduler.cacheAffinityMaxExtraDepth + TURN,
      `fleet depth spread bounded: ${depths}`);
    assert.ok(fresh.filter(l => l.account.name === 'a1').length <= 3, `new work avoids the busy bound account: ${JSON.stringify(dist(fresh))}`);
    [...held, ...fresh].forEach(release);
  });

  test(`LOAD GAP @${bytes}B: depth from OTHER conversations still moves a bound conversation`, () => {
    const m = fleet(3); am_ref = m;
    const req = { sessionKey: 'sess-x', affinityKey: 'sess-x:H', model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes };
    const first = m.acquireAccount(req); const name1 = first.account.name; release(first);
    const others = [];
    for (let i = 0; i < 8; i++) {
      others.push(m.acquireAccount({ sessionKey: 'sess-x', affinityKey: `sess-x:O${i}`, model: 'claude-opus-5-5', weight: TURN, bodyBytes: bytes },
        new Set(m.accounts.filter(a => a.name !== name1).map(a => a.index))));
    }
    assert.ok(first.account.activeWeight >= 80);
    const moved = m.acquireAccount(req);
    assert.notEqual(moved.account.name, name1, 'cap-bounded hold lets go of a deep account');
    release(moved); others.forEach(release);
  });
}

// ── production settings (switchThreshold 0.90): the Claude 5h hold ──────────────
test('PROD SETTINGS (switchThreshold 0.90): Claude 5h at 0.88 is still a candidate and HOLDS; at 0.91 it is benched and the conversation moves', () => {
  const m = am(2); am_ref = m; // am() = 0.90, the production constant
  assert.equal(m.switchThreshold, 0.9);
  const first = acquire(m); const name1 = first.account.name; release(first);
  first.account.quota.unified5hReset = Date.now() + 3600_000;
  first.account.quota.unified5h = 0.88;
  first.account.activeWeight = 20;
  assert.equal(m._isAvailable(first.account, { allowWeeklyReserve: true, model: 'claude-opus-5-5' }), true);
  const held = acquire(m);
  assert.equal(held.account.name, name1, '0.85-0.90 range: bench does not fire, hold survives (old rule moved at 0.85)');
  release(held);
  first.account.quota.unified5h = 0.91;
  assert.equal(m._isAvailable(first.account, { allowWeeklyReserve: true, model: 'claude-opus-5-5' }), false, 'benched at the real 0.90');
  const logs = captureLogs(() => { const l = acquire(m); assert.notEqual(l.account.name, name1); release(l); });
  assert.ok(logs.some(l => /why=released:unavailable\(5h-wall\)/.test(l)), logs.join(' | '));
});

test('conversation-move evidence log: fires once when a known conversation changes account', async () => {
  const logs = [];
  const origLog = console.log; console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  try {
    const m = am(2); am_ref = m;
    const first = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000 });
    m.releaseAccount(first, { status: 200, success: true });
    m._noteConversationAccount({ affinityKey: 's:h' }, m.accounts.find(a => a.name !== first.account.name)); // pretend it ran elsewhere
    // Force a move back: exclude everyone except the first account.
    const excl = new Set(m.accounts.filter(a => a.name !== first.account.name).map(a => a.index));
    const next = m.acquireAccount({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000 }, excl);
    m.releaseAccount(next, { status: 200, success: true });
    assert.ok(logs.some(l => l.includes('conversation moved:') && l.includes('→')), `log line present: ${logs.filter(Boolean).join(' | ')}`);
  } finally { console.log = origLog; }
});

// ── RETURN HOME after a provider detour (owner 2026-11-09) ─────────────────────────
// A turn went to GLM; the next turn routed back to Claude must go to the Claude account
// that still holds the conversation's stored copy — unless that account cannot serve.
// Measured before the change: 42 of 64 returns landed on a different Claude account.
const detourMgr = (threshold = 0.9, opts = {}) => {
  const m = new AccountManager(Array.from({ length: 3 }, (_, i) => acct(`a${i + 1}`)), threshold,
    { routingMode: 'balance', crossProviderFallbackPolicy: 'always', ...opts });
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  am_ref = m;
  return m;
};
const RI = (extra = {}) => ({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000, profile: 'all', ...extra });
const byName = (m, n) => m.accounts.find(a => a.name === n);
// Conversation used a2, then a GLM turn; a2 is a little busier than its siblings.
const detour = (m, ri = RI()) => {
  const a2 = byName(m, 'a2'); const glm = byName(m, 'glm');
  m._noteConversationAccount(ri, a2);
  m._noteConversationAccount(ri, glm);
  a2.activeWeight = 6;
  return { a2, glm };
};
// The retry after a failed GLM attempt: GLM excluded, so the pick is Claude.
const returnTurn = (m, ri = RI()) => {
  let lease;
  const logs = captureLogs(() => { lease = m.acquireAccount(ri, new Set([byName(m, 'glm').index])); });
  return { lease, logs, line: logs.find(l => l.includes('conversation moved:')) || '' };
};

test('RETURN HOME: after a GLM turn the next Claude turn goes back to the last Claude account', () => {
  const m = detourMgr(); detour(m);
  const { lease, line } = returnTurn(m);
  assert.equal(lease.account.name, 'a2', `went home despite a2 being busier: ${line}`);
  assert.match(line, /glm → a2 .* why=released:excluded home=a2:returned$/, line);
  assert.equal(lease.returnedHome, true);
  assert.equal(lease.returnedHomeSwitched, true, 'a1 was lighter; the switch put the turn on a2');
  release(lease);
});

test('RETURN HOME natural: the loop already picked home → not switched, line says natural', () => {
  const m = detourMgr(); const { a2 } = detour(m);
  a2.activeWeight = 0; byName(m, 'a1').activeWeight = 20; byName(m, 'a3').activeWeight = 20;
  const { lease, line } = returnTurn(m);
  assert.equal(lease.account.name, 'a2', line);
  assert.equal(lease.returnedHome, true);
  assert.equal(lease.returnedHomeSwitched, false);
  const logs = captureLogs(() => m.releaseAccount(lease, { status: 429, error: 'rate_limited' }));
  assert.ok(logs.some(l => /\(429 rate_limited, natural\): a2 depth=10$/.test(l)), logs.join(' | '));
});

test('RETURN HOME is never forced: home rate-limited → normal pick, reason logged', () => {
  const m = detourMgr(); const { a2 } = detour(m);
  m.markRateLimited(a2.index, 30);
  const { lease, line } = returnTurn(m);
  assert.notEqual(lease.account.name, 'a2');
  assert.match(line, /home=a2:skipped\(released:unavailable\(rate-limited\)\)$/, line);
  assert.equal(lease.returnedHome, false);
  release(lease);
});

test('RETURN HOME is never forced: home at the 5h wall → normal pick', () => {
  const m = detourMgr(0.99); const { a2 } = detour(m);
  a2.quota.unified5h = 0.98; a2.quota.unified5hReset = Date.now() + 3600_000;
  const { lease, line } = returnTurn(m);
  assert.notEqual(lease.account.name, 'a2');
  assert.match(line, /home=a2:skipped\(released:5h-0\.98\)$/, line);
  release(lease);
});

test('RETURN HOME is never forced: home past the anti-dogpile cap → normal pick, outscored named', () => {
  const m = detourMgr(); const { a2 } = detour(m);
  a2.activeWeight = 1200;
  const { lease, line } = returnTurn(m);
  assert.notEqual(lease.account.name, 'a2');
  assert.match(line, /home=a2:skipped\(outscored:[\d.]+\(.*bonus=400;depth=1200\/0\)\)$/, line);
  release(lease);
});

test('RETURN HOME is never forced: home in a worse priority tier → normal pick', () => {
  const m = detourMgr(); detour(m);
  m._peakTier = (a) => (a.name === 'a2' ? 1 : 0);
  const { lease, line } = returnTurn(m);
  assert.notEqual(lease.account.name, 'a2');
  assert.match(line, /home=a2:skipped\(released:priority-tier\)$/, line);
  release(lease);
});

test('RETURN HOME only while the stored copy lives: older than the window → normal pick; inside → home', () => {
  const m = detourMgr(); detour(m);
  m.conversationLastClaudeAccount.get('s:h').at = Date.now() - 2 * 3600_000;
  const stale = returnTurn(m);
  assert.notEqual(stale.lease.account.name, 'a2');
  assert.match(stale.line, /home=a2:skipped\(stale-120m\)$/, stale.line);
  release(stale.lease);

  const m2 = detourMgr(); detour(m2);
  m2.conversationLastClaudeAccount.get('s:h').at = Date.now() - 59 * 60_000;
  const fresh = returnTurn(m2);
  assert.equal(fresh.lease.account.name, 'a2', fresh.line);
  am_ref = m2; release(fresh.lease);
});

test('RETURN HOME memory holds only Claude accounts (allow-list): GLM, pool rows never become home', () => {
  const m = detourMgr();
  const ri = RI();
  m._noteConversationAccount(ri, byName(m, 'a3'));
  m._noteConversationAccount(ri, byName(m, 'glm'));
  m._noteConversationAccount(ri, { name: 'legacy-pool', type: 'pool' });
  assert.equal(m.conversationLastClaudeAccount.get('s:h').name, 'a3');
  m._noteConversationAccount(ri, { name: 'key-acct', type: 'apikey' });
  assert.equal(m.conversationLastClaudeAccount.get('s:h').name, 'key-acct', 'API-key accounts carry their own cache too');
});

test('RETURN HOME: sticky mode is untouched (no hold bonus → home never wins on score)', () => {
  const m = detourMgr(0.9, { routingMode: 'sticky' }); detour(m);
  const { lease, line } = returnTurn(m);
  assert.notEqual(lease.account.name, 'a2', line);
  release(lease);
});

test('RETURN HOME bookkeeping names home: Switched-to line and lease flag', () => {
  const m = detourMgr(); detour(m);
  m.currentIndex = byName(m, 'a1').index;
  const { lease, logs } = returnTurn(m);
  assert.ok(logs.includes('[Maxpool] Switched to account "a2"'), logs.join(' | '));
  assert.equal(m.currentIndex, lease.account.index);
  release(lease);
});

test('RETURN HOME spread: 20 detoured conversations sharing one home stay within the hold cap', () => {
  const m = fleet(8, { crossProviderFallbackPolicy: 'always' }); am_ref = m;
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });
  const home = m.accounts[0]; const glm = byName(m, 'glm');
  const keys = Array.from({ length: 20 }, (_, i) => `term-1:D${i}`);
  keys.forEach(k => { m._noteConversationAccount({ affinityKey: k }, home); m._noteConversationAccount({ affinityKey: k }, glm); });
  const leases = keys.map(k => m.acquireAccount({ sessionKey: 'term-1', affinityKey: k, model: 'claude-opus-5-5', weight: TURN, bodyBytes: 450_000, profile: 'all' }, new Set([glm.index])));
  const claude = m.accounts.filter(a => a.type === 'oauth');
  const shallowest = Math.min(...claude.slice(1).map(a => a.activeWeight));
  const bound = m.scheduler.cacheAffinityMaxExtraDepth + TURN;
  assert.ok(home.activeWeight - shallowest <= bound, `home depth ${home.activeWeight} vs shallowest ${shallowest}: ${JSON.stringify(dist(leases))}`);
  // Natural rotation over 8 equal accounts lands on home by itself, so count only the
  // turns the return-home SWITCH put there — the cap must hold against those.
  assert.ok(leases.filter(l => l.returnedHomeSwitched).length >= 1, `switch moved some home: ${JSON.stringify(dist(leases))}`);
  const homeLease = leases.find(l => l.returnedHome);
  const logs = captureLogs(() => m.releaseAccount(homeLease, { status: 429, error: 'rate_limited' }));
  assert.ok(logs.some(l => new RegExp(`^\\[Maxpool\\] return-home lease throttled \\(429 rate_limited, (switched|natural)\\): ${home.name} depth=\\d+$`).test(l)), logs.join(' | '));
  leases.filter(l => l !== homeLease).forEach(release);
});

test('RETURN HOME throttle line tags a pool-wide throttle so it is not blamed on home depth', () => {
  const m = detourMgr();
  const line = (outcome) => {
    detour(m); // each return needs a fresh GLM detour — the previous return made a2 the last account
    const { lease } = returnTurn(m);
    assert.ok(lease.returnedHome, 'went home');
    return captureLogs(() => m.releaseAccount(lease, outcome)).find(l => l.includes('return-home lease throttled')) || '';
  };
  // Pool-wide throttle (server markUpstreamThrottled path): tagged.
  assert.match(line({ status: 429, error: 'upstream_throttled', upstreamThrottled: true, neutral: true }),
    /^\[Maxpool\] return-home lease throttled \(429 upstream_throttled pool-wide, (switched|natural)\): a2 depth=\d+$/);
  // Per-account throttle (markProvisionalUpstreamFailure path): NOT tagged — it counts against home.
  assert.match(line({ status: 429, error: 'upstream_throttled', neutral: true }),
    /^\[Maxpool\] return-home lease throttled \(429 upstream_throttled, (switched|natural)\): a2 depth=\d+$/);
});

test('RETURN HOME with degraded conversation identity (per-terminal key) still goes home, capped', () => {
  // Degraded: the per-request key churns, so only sessionKey ('s') can join the turns.
  const setup = () => {
    const m = detourMgr(); m.identityHealth.degraded = true;
    const a2 = byName(m, 'a2'); const glm = byName(m, 'glm');
    m._noteConversationAccount(RI({ affinityKey: 's:h1' }), a2);
    m._noteConversationAccount(RI({ affinityKey: 's:h1' }), glm);
    return { m, a2 };
  };
  const { m, a2 } = setup();
  a2.activeWeight = 6;
  const { lease, line } = returnTurn(m, RI({ affinityKey: 's:h2' }));
  assert.equal(lease.account.name, 'a2', line);
  release(lease);

  // Cap half: a fresh manager, home past the anti-dogpile cap → does NOT go home.
  const c = setup();
  c.a2.activeWeight = 1200;
  const capped = returnTurn(c.m, RI({ affinityKey: 's:h2' }));
  assert.notEqual(capped.lease.account.name, 'a2', capped.line);
  am_ref = c.m; release(capped.lease);
});

test('RETURN HOME stale window: a non-finite or negative config falls back to one hour', () => {
  for (const bad of ['abc', -5]) {
    const m = detourMgr(0.9, { cacheAffinityReturnWindowMs: bad }); detour(m);
    m.conversationLastClaudeAccount.get('s:h').at = Date.now() - 2 * 3600_000;
    const stale = returnTurn(m);
    assert.notEqual(stale.lease.account.name, 'a2', `${bad}: ${stale.line}`);
    assert.match(stale.line, /home=a2:skipped\(stale-120m\)$/, stale.line);
    release(stale.lease);
  }
  // Negative: without the fallback every age is "stale"; a 59-minute-old home must still go home.
  const m = detourMgr(0.9, { cacheAffinityReturnWindowMs: -5 }); detour(m);
  m.conversationLastClaudeAccount.get('s:h').at = Date.now() - 59 * 60_000;
  const fresh = returnTurn(m);
  assert.equal(fresh.lease.account.name, 'a2', fresh.line);
  release(fresh.lease);
});

test('RETURN HOME a reused requestInfo does not carry returnedHome into a later acquire', () => {
  const m = detourMgr(); const { a2 } = detour(m);
  const ri = RI();
  const first = m.acquireAccount(ri, new Set([byName(m, 'glm').index]));
  assert.equal(first.account.name, 'a2');
  assert.equal(first.returnedHome, true);
  release(first);
  // Second turn: hold on home through the normal path, no detour.
  m._noteConversationAccount(ri, a2);
  a2.activeWeight = 0;
  const second = m.acquireAccount(ri, new Set([byName(m, 'glm').index]));
  assert.equal(second.account.name, 'a2');
  assert.equal(second.returnedHome, false, 'normal hold is not a return-home');
  release(second);
});

test('RETURN HOME throttle line: request_shape_refused is excluded; a remote 503 is counted', () => {
  const m = detourMgr(); detour(m);
  const l1 = returnTurn(m).lease;
  assert.equal(l1.returnedHome, true);
  const refused = captureLogs(() => m.releaseAccount(l1, { status: 429, error: 'request_shape_refused' }));
  assert.equal(refused.some(l => l.includes('return-home lease throttled')), false, refused.join(' | '));

  const m2 = detourMgr(); detour(m2);
  const l2 = returnTurn(m2).lease;
  assert.equal(l2.returnedHome, true);
  l2.account.remote = true;
  const logs = captureLogs(() => m2.releaseAccount(l2, { status: 503, error: 'remote_pinned_unavailable' }));
  assert.ok(logs.some(l => /^\[Maxpool\] return-home lease throttled \(503 remote_pinned_unavailable, (switched|natural)\): a2 depth=\d+$/.test(l)), logs.join(' | '));
});

test('RETURN HOME never overrides a GLM pick, even one whose hold was released (pick stays GLM)', () => {
  const m = detourMgr(); const { glm } = detour(m);
  glm.consecutiveFailures = 1;   // GLM hold released, but GLM is still the lightest candidate
  byName(m, 'a1').activeWeight = 20; byName(m, 'a3').activeWeight = 20;
  let lease;
  const logs = captureLogs(() => { lease = m.acquireAccount(RI()); });
  assert.equal(lease.account.name, 'glm', logs.join(' | '));
  assert.equal(lease.returnedHome, false);
  release(lease);
});

test('RETURN HOME: why= explains why the conversation LEFT GLM (against the pre-return pick)', () => {
  const m = detourMgr(); const { glm } = detour(m);
  glm.activeWeight = 1200;       // GLM held but outscored by load; loop picks a1 (depth 0), home a2 wins
  let lease;
  const logs = captureLogs(() => { lease = m.acquireAccount(RI()); });
  const line = logs.find(l => l.includes('conversation moved:')) || '';
  assert.equal(lease.account.name, 'a2', line);
  assert.match(line, /glm → a2 .* why=outscored:[\d.]+\(.*depth=1200\/0\) home=a2:returned$/, line);
  release(lease);
});

test('RETURN HOME onto an UNLOCKED critical home: unlock bookkeeping follows the switch', () => {
  const m = detourMgr(); const { a2 } = detour(m);
  a2.quota.unified7d = 0.96; a2.quota.unified7dReset = FAR();
  const orig = m._criticalUnlock.bind(m);
  m._criticalUnlock = (a, ...rest) => (a === a2 ? { reason: 'prereset', etaMs: 30 * 60_000 } : orig(a, ...rest));
  const { lease, logs } = returnTurn(m);
  assert.equal(lease.account.name, 'a2', logs.join(' | '));
  assert.ok(logs.some(l => l.startsWith('[Maxpool] Critical unlock "prereset": routing to "a2"')), logs.join(' | '));
  release(lease);
});
