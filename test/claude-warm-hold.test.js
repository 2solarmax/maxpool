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
// Claude sibling. With this turn's 10 units it sits UNDER the F1 depth ceiling (target 3 +
// 2x40 = 83 units), so the hold keeps this conversation; past the ceiling it moves as today.
const loadHolder = (a) => { a.activeWeight = 60; a.inFlight = 6; };
const loadHolderPastCeiling = (a) => { a.activeWeight = 74; a.inFlight = 8; };   // 74 + 10 = 84

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
  assert.ok(logs.some(l => /warm-hold=a1:kept\(pick a[23] depth=\d+\/\d+\)/.test(l)), `one kept line naming the pick: ${logs.join(' | ')}`);
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
  // a1 is deep with other conversations' turns (6 x 10 = 60 units, under the 83-unit
  // depth ceiling) and just refused busy for new placements.
  const others = [];
  for (let i = 0; i < 6; i++) {
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
test('RT-F1: the ceiling edge — 73 units + this 10-unit turn = exactly 83 still holds', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); a1.activeWeight = 73; a1.inFlight = 8;
  assert.equal(pick(m).name, 'a1', 'at the ceiling (counting this turn) the hold keeps the conversation');
});
test('RT-F1: the ceiling is tighter on a reserve holder (scaled by reserve/target)', () => {
  const m = claude3(); const a1 = byName(m, 'a1');
  served(m, a1); loadHolder(a1);
  const orig = m._weeklyRawState.bind(m);
  m._weeklyRawState = (a) => (a === a1 ? 'reserve' : orig(a));
  const r = m.scheduler.reserveConcurrencyTarget / m.scheduler.perAccountConcurrencyTarget;
  const ceiling = m.scheduler.perAccountConcurrencyTarget + 2 * m.scheduler.cacheAffinityMaxExtraDepth * Math.min(1, r);
  assert.ok(a1.activeWeight > ceiling, `fixture: 60 units sits past the reserve ceiling ${ceiling}`);
  assert.notEqual(pick(m).name, 'a1', 'reserve holder past its tighter ceiling lets go');
});
