// CLAUDE WARM HOLD (owner 2026-11-18: "stop moving warm conversations between Claude
// accounts — sure, red team and go"). Anthropic's prompt cache is per account, so a
// Claude->Claude move re-writes the whole conversation prefix on the new account
// (measured: 75 Claude->Claude moves in 2 h, why=outscored; 68% of Claude cache writes
// were such re-writes). In scored modes, a WARM conversation whose holder is a Claude
// account that can serve it stays there when the pick is another Claude account —
// whatever the score. The hold still lets go on every existing release/availability
// gate. Provider (GLM/Kimi) rows are outside the rule; scheduler.claudeWarmHold=false
// restores the score-based behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const claude = (n) => ({ name: n, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, upstream: 'http://127.0.0.1:1' });
const glm = (n) => ({ name: n, type: 'provider', provider: 'zai', apiKey: `k-${n}` });
const mgr = (accts, opts = {}, threshold = 0.9) => new AccountManager(accts, threshold,
  { routingMode: 'balance', crossProviderFallbackPolicy: 'always', ...opts });
const claude3 = (opts, threshold) => mgr([claude('a1'), claude('a2'), claude('a3')], opts, threshold);
const ri = (over = {}) => ({ sessionKey: 's', affinityKey: 's:h', model: 'claude-opus-5-5', weight: 10, bodyBytes: 10_000, profile: 'all', ...over });
const byName = (m, n) => m.accounts.find(a => a.name === n);
// A turn SERVED by `account` (what releaseAccount / the server do on the first real byte).
const served = (m, account, over = {}) => { const r = ri(over); m._noteConversationAccount(r, account); m.noteConversationServed(r, account); };
const FAR = () => Date.now() + 3 * 86400_000;
const pick = (m, excluded, over) => {
  const logs = []; const orig = console.log;
  console.log = l => { if (typeof l === 'string' && l.startsWith('[Maxpool]')) logs.push(l); };
  let lease;
  try { lease = m.acquireAccount(ri(over), excluded); } finally { console.log = orig; }
  if (lease) m.releaseAccount(lease, { status: 200, success: true });
  return { name: lease?.account.name ?? null, logs };
};
// The holder a1 carries 60 weight units from OTHER conversations: past the 400-point
// affinity bonus (~33 units), so today's score loop moves the conversation to an idle
// Claude sibling. The hold's depth ceiling counts in-flight REQUESTS (this turn included):
// 5 in flight + this turn = 6 holds; 6 + 1 = 7 moves. Weight (60/74, past the old
// 83-unit weight ceiling's neighbourhood) no longer decides the release.
const loadHolder = (a) => { a.activeWeight = 60; a.inFlight = 5; };
const loadHolderPastCeiling = (a) => { a.activeWeight = 60; a.inFlight = 6; };

test('knob: scheduler.claudeWarmHold defaults to true', () => {
  assert.equal(claude3().scheduler.claudeWarmHold, true);
  assert.equal(claude3({ claudeWarmHold: false }).scheduler.claudeWarmHold, false, 'settable from config.scheduler');
});

// ── 1. the rule ──────────────────────────────────────────────────────────────
test('HOLD: a warm conversation stays on its available Claude holder although a Claude sibling scores far better', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  const { name, logs } = pick(m);
  assert.equal(name, 'a1', `kept on the holder: ${logs.join(' | ')}`);
  assert.ok(!logs.some(l => l.includes('conversation moved:')), 'no move line');
  assert.ok(logs.some(l => /warm-hold=a1:kept\(pick a[23] depth=\d+\/\d+ inflight=\d+\/\d+\)/.test(l)), `one kept line naming the pick: ${logs.join(' | ')}`);
});

test('HOLD applies in prefer-claude mode too (scored mode)', () => {
  const m = claude3({ routingMode: 'prefer-claude' }); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  assert.equal(pick(m).name, 'a1');
});

test('HOLD keeps the holder even when it is soft-cooled for new placements', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.softCooldownUntil = Date.now() + 30_000;
  assert.equal(pick(m).name, 'a1');
});

test('HOLD is only for a WARM conversation: a stored copy older than the cache window moves on score as today', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  m.conversationLastServedAt.set('s:h', Date.now() - 2 * 3600_000);
  assert.notEqual(pick(m).name, 'a1', 'cold copy: nothing to protect');
});

test('HOLD does not apply in sticky mode (its own binding decides)', () => {
  const m = claude3({ routingMode: 'sticky' }); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  // Sticky's score loop runs only when the binding decided to leave; no binding here, so
  // the loop scores freely and the hold must not interfere.
  assert.notEqual(pick(m).name, 'a1');
});

// ── 2. release gates still move it ─────────────────────────────────────────────
test('RELEASE: holder weekly exhausted → moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.quota.unified7d = 0.9995; a1.quota.unified7dReset = FAR();
  assert.equal(m._weeklyRawState(a1), 'exhausted');
  assert.notEqual(pick(m).name, 'a1');
});

test('RELEASE: holder at the 5h wall (available, but the hold gate lets go) → moves', () => {
  const m = claude3({}, 0.99); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.quota.unified5h = 0.98; a1.quota.unified5hReset = Date.now() + 3600_000;
  assert.match(m._affinityRelease(a1), /^5h-/, 'fixture: the 5h release gate fires');
  assert.ok(m._isAvailable(a1, { allowWeeklyReserve: true }), 'fixture: still a candidate (switchThreshold 0.99)');
  assert.notEqual(pick(m).name, 'a1');
});

test('RELEASE: holder failure streak → moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.consecutiveFailures = 1;
  assert.ok(m._isAvailable(a1, { allowWeeklyReserve: true }), 'fixture: still a candidate');
  assert.notEqual(pick(m).name, 'a1');
});

test('RELEASE: holder on cooldown → moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.cooldownUntil = Date.now() + 30_000;
  assert.notEqual(pick(m).name, 'a1');
});

test('RELEASE: holder excluded (failed attempt / busy wait spent) → moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  assert.notEqual(pick(m, new Set([a1.index])).name, 'a1');
});

test('RELEASE: holder at the hard in-flight cap (safetyMaxActivePerAccount) → moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.inFlight = m.scheduler.safetyMaxActivePerAccount;
  assert.notEqual(pick(m).name, 'a1');
});

test('RELEASE: holder in a worse priority tier → the tier still wins', () => {
  const m = claude3({ routingMode: 'prefer-zai' }); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  a1.priority = 5;
  assert.notEqual(pick(m).name, 'a1');
});

// ── 3. provider rows untouched ──────────────────────────────────────────────────
test('PROVIDER: GLM holder + better-scoring GLM sibling → still moves (z.ai cache is shared)', () => {
  const m = mgr([glm('g1'), glm('g2'), claude('c1')]); const g1 = byName(m, 'g1');
  served(m, g1); loadHolder(g1);
  assert.equal(pick(m, new Set([byName(m, 'c1').index])).name, 'g2');
});

test('PROVIDER: GLM holder + Claude pick → moves (cross-family untouched)', () => {
  const m = mgr([glm('g1'), claude('c1'), claude('c2')]); const g1 = byName(m, 'g1');
  served(m, g1); loadHolder(g1);
  const { name } = pick(m);
  assert.ok(name === 'c1' || name === 'c2', name);
});

test('PROVIDER: Claude holder + GLM pick → moves (cross-family untouched)', () => {
  const m = mgr([claude('a1'), claude('a2'), glm('g1')]); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  assert.equal(pick(m, new Set([byName(m, 'a2').index])).name, 'g1');
});

test('PROVIDER: GLM→Claude return-home still goes to the home account', () => {
  const m = claude3(); m.addAccount(glm('glm'));
  const a2 = byName(m, 'a2');
  served(m, a2); served(m, byName(m, 'glm'));
  a2.activeWeight = 6;   // home a little busier than its siblings
  const { name, logs } = pick(m, new Set([byName(m, 'glm').index]));
  assert.equal(name, 'a2', logs.join(' | '));
  assert.ok(logs.some(l => /glm → a2 .*home=a2:returned$/.test(l)), logs.join(' | '));
});

test('PROVIDER: return-home then the warm hold keeps the conversation on home on the next turn', () => {
  const m = claude3(); m.addAccount(glm('glm'));
  const a2 = byName(m, 'a2');
  served(m, a2); served(m, byName(m, 'glm'));
  assert.equal(pick(m, new Set([byName(m, 'glm').index])).name, 'a2');
  loadHolder(a2);
  assert.equal(pick(m, new Set([byName(m, 'glm').index])).name, 'a2', 'home is now the warm holder');
});

// ── 4. knob off = today ──────────────────────────────────────────────────────────
test('KNOB: claudeWarmHold=false restores score-based moves', () => {
  const m = claude3({ claudeWarmHold: false }); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  const { name, logs } = pick(m);
  assert.notEqual(name, 'a1');
  assert.ok(logs.some(l => /conversation moved: a1 → a[23] .*why=outscored/.test(l)), logs.join(' | '));
  assert.ok(!logs.some(l => l.includes('warm-hold=')), 'no hold note with the knob off');
});

// ── 5. busy holder: the conversation waits on its holder, NEW work spreads ──────────
test('BUSY holder: the warm conversation keeps landing on its busy holder (no sibling re-write) while NEW conversations spread', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1);
  // a1 is deep with other conversations' turns (5 in-flight leases, one under the
  // 6-request in-flight ceiling) and just refused busy for new placements.
  const others = [];
  for (let i = 0; i < 5; i++) {
    others.push(m.acquireAccount(ri({ affinityKey: `s:other-${i}` }), new Set([byName(m, 'a2').index, byName(m, 'a3').index])));
  }
  assert.ok(others.every(l => l.account.name === 'a1'));
  m.markPinBusy(a1.index, 5000);
  assert.ok(m._pinBusyForNew(a1), 'fixture: a1 repels new placements');
  // Three turns of the warm conversation, each served on a1 while a1 stays busy.
  for (let t = 0; t < 3; t++) assert.equal(pick(m).name, 'a1', `turn ${t + 1} stayed on the holder`);
  // A brand-new conversation does not stack on the busy row.
  assert.notEqual(pick(m, undefined, { affinityKey: 's:new' }).name, 'a1', 'new work spreads');
  others.forEach(l => m.releaseAccount(l, { status: 200, success: true }));
  assert.equal(pick(m).name, 'a1', 'served on the holder once it frees');
});


// Red-team round 1
// F2: a degraded identity (no per-conversation key: the terminal-wide key stands in) must
// route exactly as with the hold OFF — the hold would otherwise pin a whole terminal.
const spread = (holdOn) => {
  const m = claude3({ claudeWarmHold: holdOn }); const a1 = byName(m, 'a1');
  m.identityHealth = { degraded: true };
  served(m, a1, { affinityKey: undefined }); loadHolder(a1);
  return pick(m, undefined, { affinityKey: undefined }).name;
};
test('RT-F2: degraded identity — the warm hold does not fire (routes as with the hold off)', () => {
  assert.notEqual(spread(false), 'a1', 'fixture: with the hold off the loaded holder loses');
  assert.equal(spread(true), spread(false), 'hold on == hold off when identity is degraded');
});

// F1: the hold never stacks its holder past target + 2x the anti-dogpile allowance.
test('RT-F1: past the depth ceiling the warm conversation moves as today', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolderPastCeiling(a1);
  const { name, logs } = pick(m);
  assert.notEqual(name, 'a1', `moved off an over-ceiling holder: ${logs.join(' | ')}`);
  assert.ok(!logs.some(l => l.includes('warm-hold=a1:kept')), 'no kept line past the ceiling');
});
test('RT-F1: the ceiling edge — 5 in flight + this turn = 6 holds, 6 in flight moves', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); a1.activeWeight = 60; a1.inFlight = 5;
  assert.equal(pick(m).name, 'a1', 'at the ceiling (counting this turn) the hold keeps the conversation');
  const m2 = claude3(); const b1 = byName(m2, 'a1');
  served(m2, b1); b1.activeWeight = 60; b1.inFlight = 6;
  assert.notEqual(pick(m2).name, 'a1', 'one request past the ceiling moves');
});
test('RT-F1: conversation size does not decide — a huge turn on a 5-in-flight holder still holds', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1, { weight: 44, bodyBytes: 2_800_000 }); a1.activeWeight = 90; a1.inFlight = 5;
  assert.equal(pick(m, undefined, { weight: 44, bodyBytes: 2_800_000 }).name, 'a1');
});
const reserveHolder = () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1);
  const orig = m._weeklyRawState.bind(m);
  m._weeklyRawState = (a) => (a === a1 ? 'reserve' : orig(a));
  return { m, a1 };
};
test('RT-F1: the ceiling is tighter on a reserve holder — holds at 3 in flight, moves at 4', () => {
  const { m, a1 } = reserveHolder();
  a1.activeWeight = 60; a1.inFlight = 3;
  assert.equal(pick(m).name, 'a1', '3 + this turn = 4 holds under the reserve ceiling');
  const r2 = reserveHolder();
  r2.a1.activeWeight = 60; r2.a1.inFlight = 4;
  assert.notEqual(pick(r2.m).name, 'a1', 'reserve holder past its tighter ceiling lets go');
});
test('KNOB: claudeWarmHoldMaxInFlight is settable and defaults to 6', () => {
  assert.equal(claude3().scheduler.claudeWarmHoldMaxInFlight, 6);
  const m = claude3({ claudeWarmHoldMaxInFlight: 3 }); const a1 = byName(m, 'a1');
  served(m, a1); a1.activeWeight = 60; a1.inFlight = 3;
  assert.notEqual(pick(m).name, 'a1', 'max 3: 3 in flight + this turn moves');
  const m2 = claude3({ claudeWarmHoldMaxInFlight: 3 }); const b1 = byName(m2, 'a1');
  served(m2, b1); b1.activeWeight = 60; b1.inFlight = 2;
  assert.equal(pick(m2).name, 'a1', 'max 3: 2 in flight + this turn holds');
});

// ── red team round 2: log tokens, reserve knob, knob validation ─────────────────────
const holderAt = (inFlight, opts = {}, { reserve = false } = {}) => {
  const m = claude3(opts); const a1 = byName(m, 'a1');
  served(m, a1); a1.activeWeight = 60; a1.inFlight = inFlight;
  if (reserve) { const orig = m._weeklyRawState.bind(m); m._weeklyRawState = (a) => (a === a1 ? 'reserve' : orig(a)); }
  return pick(m);
};
test('C1: past the ceiling the move line says released:hold-ceiling(inflight=N/M), not outscored', () => {
  const { name, logs } = holderAt(6);
  assert.notEqual(name, 'a1');
  const mv = logs.find(l => l.includes('conversation moved:'));
  assert.ok(mv, logs.join(' | '));
  assert.ok(mv.endsWith('why=released:hold-ceiling(inflight=7/6)'), mv);
  assert.ok(!mv.includes('outscored'), mv);
});
test('C1: reserve holder past its ceiling reports its own ceiling (inflight=5/4)', () => {
  const { logs } = holderAt(4, {}, { reserve: true });
  assert.ok(logs.some(l => l.endsWith('why=released:hold-ceiling(inflight=5/4)')), logs.join(' | '));
});
test('C1: the kept line keeps depth=H/D and appends inflight=N/M after it', () => {
  const { name, logs } = holderAt(5);
  assert.equal(name, 'a1');
  const kept = logs.find(l => l.includes('warm-hold=a1:kept'));
  assert.match(kept, /^\[Maxpool\] warm-hold=a1:kept\(pick a[23] depth=60\/\d+ inflight=6\/6\) \(10000B\)$/);
  assert.match(kept, /depth=(\d+)\/(\d+)/, 'old parsers still match');
});
test('C1: a release gate still wins over the ceiling reason (holder on cooldown, deep)', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); a1.inFlight = 9; a1.cooldownUntil = Date.now() + 30_000;
  const { logs } = pick(m);
  assert.ok(logs.some(l => /why=released:unavailable\(cooldown\)/.test(l)), logs.join(' | '));
});
test('C3: reserve knob is separate and defaults to 4; reserve holds at 3, moves at 4', () => {
  assert.equal(claude3().scheduler.claudeWarmHoldReserveMaxInFlight, 4);
  assert.equal(holderAt(3, {}, { reserve: true }).name, 'a1');
  assert.notEqual(holderAt(4, {}, { reserve: true }).name, 'a1');
});
test('C3: perAccountConcurrencyTarget no longer moves either ceiling', () => {
  const o = { perAccountConcurrencyTarget: 5 };
  assert.equal(holderAt(5, o).name, 'a1', 'normal still holds at 5+1=6');
  assert.notEqual(holderAt(6, o).name, 'a1', 'normal still moves at 6+1=7');
  assert.equal(holderAt(3, o, { reserve: true }).name, 'a1', 'reserve still holds at 3+1=4');
  assert.notEqual(holderAt(4, o, { reserve: true }).name, 'a1', 'reserve still moves at 4+1=5');
});
test('C3: claudeWarmHoldReserveMaxInFlight is honoured for reserve holders and ignored for normal ones', () => {
  assert.equal(holderAt(5, { claudeWarmHoldReserveMaxInFlight: 7 }, { reserve: true }).name, 'a1');
  assert.equal(holderAt(5, { claudeWarmHoldReserveMaxInFlight: 7 }).name, 'a1', 'normal holder at 5 still holds');
  assert.notEqual(holderAt(6, { claudeWarmHoldReserveMaxInFlight: 7 }).name, 'a1', 'normal ceiling unaffected by the reserve knob');
});
test('C4: invalid knob values fall back to the default; fractions floor', () => {
  // 0 -> 6: holds at 5, moves at 6
  assert.equal(holderAt(5, { claudeWarmHoldMaxInFlight: 0 }).name, 'a1');
  assert.notEqual(holderAt(6, { claudeWarmHoldMaxInFlight: 0 }).name, 'a1');
  // 'x' -> 6
  assert.equal(holderAt(5, { claudeWarmHoldMaxInFlight: 'x' }).name, 'a1');
  assert.notEqual(holderAt(6, { claudeWarmHoldMaxInFlight: 'x' }).name, 'a1');
  // negative -> 6
  assert.equal(holderAt(5, { claudeWarmHoldMaxInFlight: -3 }).name, 'a1');
  // 2.7 -> 2: holds at 1, moves at 2
  assert.equal(holderAt(1, { claudeWarmHoldMaxInFlight: 2.7 }).name, 'a1');
  assert.notEqual(holderAt(2, { claudeWarmHoldMaxInFlight: 2.7 }).name, 'a1');
  // reserve knob: 0 -> 4 (holds at 3, moves at 4); 'x' -> 4
  assert.equal(holderAt(3, { claudeWarmHoldReserveMaxInFlight: 0 }, { reserve: true }).name, 'a1');
  assert.notEqual(holderAt(4, { claudeWarmHoldReserveMaxInFlight: 'x' }, { reserve: true }).name, 'a1');
});
test('C4: 0.5 and Infinity fall back to the default; 2.7 reports the floored ceiling 2 in the log', () => {
  assert.equal(holderAt(5, { claudeWarmHoldMaxInFlight: 0.5 }).name, 'a1', '0.5 is < 1 -> default 6, not a ceiling of 0');
  assert.notEqual(holderAt(6, { claudeWarmHoldMaxInFlight: Infinity }).name, 'a1', 'Infinity is not finite -> default 6');
  const { logs } = holderAt(2, { claudeWarmHoldMaxInFlight: 2.7 });
  assert.ok(logs.some(l => l.endsWith('why=released:hold-ceiling(inflight=3/2)')), logs.join(' | '));
});
