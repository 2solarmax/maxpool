// Honest efficiency dashboard (2026-11-17, audit findings 2-6): the cache line shows
// the price-weighted WRITE SHARE OF COST next to hit% (finding 2 — a 91% hit line can
// carry writes worth half the spend); "Usage by person" / CLI Total book FULL prompt
// tokens incl. cache read+write and GLM (finding 3); moves split same-family vs
// cross-family (finding 4 — a GLM→GLM hop re-writes nothing, a GLM→Claude hop
// re-writes the whole prompt); miss is per provider, never a blended cross-tokenizer
// sum (finding 5); the wait figure says what it counts (finding 6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const acct = (n, type = 'oauth', extra = {}) => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, ...extra });
const lease = (a, requestInfo = {}) => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo }; };
const served = (m, a, u = {}, extra = {}) => m.releaseAccount(lease(a), { success: true, status: 200, usage: u, ...extra });
const tui = (m) => new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });

// ── A (finding 2): write share of cost ───────────────────────────────────────

test('A: writeShare = 1.25·cc / (0.1·cr + 1.25·cc + in), per provider (Claude 55%, GLM 0)', () => {
  const m = new AccountManager([acct('c1'), { ...acct('g1', 'provider'), provider: 'zai' }], 0.9);
  // The audit's headline: cr=75.4M, cc=60.3M... take a small scaled copy — cr 75,400
  // cc 60,300 in 1,000 → cost = 7540 + 75375 + 1000 = 83,915 → 75375/83915 ≈ 0.898.
  for (let i = 0; i < 25; i++) served(m, m.accounts[0], { in: 1000, cr: 75400, cc: 60300, out: 10 });
  for (let i = 0; i < 25; i++) served(m, m.accounts[1], { in: 400, cr: 9600, cc: 0, out: 10 });
  const c = m._efficiencySummary(m.accounts[0], 15 * 60_000);
  const g = m._efficiencySummary(m.accounts[1], 15 * 60_000);
  assert.ok(Math.abs(c.writeShare - 75375 / 83915) < 1e-9, `Claude writeShare (got ${c.writeShare})`);
  assert.equal(g.writeShare, 0, 'GLM writes no cache: writeShare 0, not null');
});

test('A: writeShare null only when the window processed no prompt tokens at all', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  served(m, m.accounts[0], { in: 100, cr: 0, cc: 0, out: 5 });
  assert.equal(m._efficiencySummary(m.accounts[0], 15 * 60_000).writeShare, 0);
  const idle = new AccountManager([acct('c2')], 0.9);
  assert.equal(idle._efficiencySummary(idle.accounts[0], 15 * 60_000).writeShare, null);
});

test('A: the TUI cache line shows the write share beside hit%, and it colours on it', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  // Real volume, hit 90% — but writes carry 55% of cost-equivalent: not green.
  // (hit .9 needs cr=9(cc+in); share .55 then needs cc/in ≈ 15.5.)
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 14_850, cc: 1_550, out: 10 });
  const line = strip(tui(m)._efficiencyLine(160));
  assert.match(line, /Claude 90% \(w\/ 55% of cost\)/, `write share beside hit: ${line}`);
  // And a genuinely healthy window stays green with the figure present.
  const ok = new AccountManager([acct('c1')], 0.9);
  for (let i = 0; i < 30; i++) served(ok, ok.accounts[0], { in: 100, cr: 9900, cc: 100, out: 10 });
  const okLine = strip(tui(ok)._efficiencyLine(160));
  assert.match(okLine, /Claude 98% \(w\/ 10% of cost\)/, okLine);
  assert.doesNotMatch(okLine, /⚠/);
});

test('A: yellow at write share > 40%, red > 60% (Claude, real volume)', () => {
  const line = (u) => {
    const m = new AccountManager([acct('c1')], 0.9);
    for (let i = 0; i < 30; i++) served(m, m.accounts[0], { ...u, out: 1 });
    return strip(tui(m)._efficiencyLine(200));
  };
  // hit 90%, write share 47%: above the 40% yellow line, below the 60% red line.
  const y = line({ in: 1000, cr: 9 * 4630, cc: 3630 });
  assert.match(y, /Claude 90% \(w\/ 47% of cost\)/, y);
  assert.doesNotMatch(y, /⚠/, `47% is yellow, not red: ${y}`);
  // hit 51%, write share 70%: above the 60% red line (hit still over the 50% red floor).
  const r = line({ in: 10_000, cr: 37_000, cc: 25_300 });
  assert.match(r, /⚠ write share 70% of cost/, `red names the write share: ${r}`);
});

// ── C (finding 4): same-family vs cross-family moves ────────────────────────

function pool3() {
  const m = new AccountManager([
    acct('c1'), acct('c2'), { ...acct('z1', 'provider'), provider: 'zai' }, { ...acct('z2', 'provider'), provider: 'zai' },
  ], 0.9);
  return m;
}
/** Serve one request on `a` with move telemetry. A FRESH requestInfo per release —
 *  the live path never reuses a request object across turns (a second turn on the same
 *  conversation is a new request whose _prevServedName the first-byte stamp fills from
 *  the conversation map before noteConversationServed overwrites it). */
function servedOn(m, a, key, extra = {}) {
  m.releaseAccount(lease(a, { affinityKey: key }), { success: true, status: 200, usage: { in: 1, cr: 1, cc: 0, out: 1 }, ...extra });
}

test('C: same-family and cross-family moves are counted separately per account and overall', () => {
  const m = pool3();
  const [c1, , z1, z2] = m.accounts;
  // z1 → z2: same family (zai), near-free.
  servedOn(m, z1, 'same'); servedOn(m, z2, 'same');
  // c1 → z1: cross family.
  servedOn(m, c1, 'cross'); servedOn(m, z1, 'cross');
  const e = m.efficiencyOverall('last1h');
  assert.equal(e.glm.moved, 2, 'glm row serves both the same-family move and the cross move');
  assert.equal(e.glm.movedSame, 1);
  assert.equal(e.glm.movedCross, 1);
  // A move is booked on the row that SERVED the turn after it (the destination), so the
  // Claude→GLM cross move sits on the GLM side and Claude books none.
  assert.equal(e.claude.moved, 0);
  assert.equal(e.claude.movedCross, 0);
  // Totals reconcile.
  assert.equal(e.glm.moved, e.glm.movedSame + e.glm.movedCross);
  assert.equal(e.claude.moved, e.claude.movedSame + e.claude.movedCross);
});

test('C: outcome-passed moves are classified by family too (no requestInfo)', () => {
  const m = pool3();
  const [c1, , z1] = m.accounts;
  m.releaseAccount(lease(c1), { success: true, status: 200, usage: { in: 1, cr: 1 }, moved: true, moveCause: 'busy' });
  m.releaseAccount(lease(z1), { success: true, status: 200, usage: { in: 1, cr: 1 }, moved: true, moveCause: 'busy' });
  const e = m.efficiencyOverall('last1h');
  assert.equal(e.claude.movedCross, 1, 'no prev known → cross (the honest default)');
  assert.equal(e.glm.movedSame, 1, 'provider move without prev info: same family');
});

test('C: the red "forced moves/100" alarm fires on CROSS-FAMILY moves only', () => {
  const m = pool3();
  const [c1, c2, z1, z2] = m.accounts;
  // Volume on Claude so lowVolume is off.
  for (let i = 0; i < 40; i++) served(m, i % 2 ? c2 : c1, { in: 1000, cr: 9000, cc: 0, out: 10 });
  // GLM→GLM busy bounces, 5 of them (would be 5/100 = 5 > 2 under the old alarm).
  for (let i = 0; i < 5; i++) {
    servedOn(m, z1, `g${i}`); servedOn(m, z2, `g${i}`, { moveCause: 'busy' });
  }
  let line = strip(tui(m)._efficiencyLine(200));
  assert.doesNotMatch(line, /forced moves\/100/, `same-family bounces are not the red alarm: ${line}`);
  assert.match(line, /glm busy-bounced 5/, `they surface as a capacity note: ${line}`);
  // One cross-family move above the cross threshold... one move on 45 served is 2/100 —
  // use two cross moves on 40 served → 5/100 → red.
  const m2 = pool3();
  for (let i = 0; i < 40; i++) served(m2, i % 2 ? m2.accounts[1] : m2.accounts[0], { in: 1000, cr: 9000, cc: 0, out: 10 });
  for (let i = 0; i < 2; i++) {
    servedOn(m2, m2.accounts[0], `x${i}`); servedOn(m2, m2.accounts[2], `x${i}`, { moveCause: 'busy' });
  }
  line = strip(tui(m2)._efficiencyLine(200));
  assert.match(line, /⚠.*cross moves 5\/100/, `cross-family moves drive the red alarm: ${line}`);
});

test('C: the headline shows cross-family moves as the cost signal', () => {
  const m = pool3();
  const [c1, c2, z1, z2] = m.accounts;
  for (let i = 0; i < 40; i++) served(m, i % 2 ? c2 : c1, { in: 1000, cr: 9000, cc: 0, out: 10 });
  for (let i = 0; i < 3; i++) {
    servedOn(m, z1, `g${i}`); servedOn(m, z2, `g${i}`, { moveCause: 'busy' });
  }
  servedOn(m, c1, 'x'); servedOn(m, z1, 'x', { moveCause: 'busy' });
  const line = strip(tui(m)._efficiencyLine(200));
  assert.match(line, /cross-moves 2\/100/, `cost signal is cross-family per 100: ${line}`); // 2 cross / 44 served
  assert.doesNotMatch(line, /cross-moves 4\/100/, 'the blended 4/100 (moves/served on glm+claude rows) is not shown as cross');
});

// ── D (finding 5): miss per provider, no blended sum; capacity axis label ────

test('D: miss is shown per provider, never a blended cross-tokenizer sum', () => {
  const m = new AccountManager([acct('c1'), { ...acct('g1', 'provider'), provider: 'zai' }], 0.9);
  // Enough volume that neither side is lowVolume (the line renders numbers).
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 500, cr: 100_000, cc: 1500, out: 10 });
  for (let i = 0; i < 30; i++) served(m, m.accounts[1], { in: 300, cr: 100_000, cc: 0, out: 10 });
  const line = strip(tui(m)._efficiencyLine(200));
  assert.doesNotMatch(line, /(?:^|· )miss \d+k tok/, `no blended miss figure: ${line}`);
  assert.match(line, /Claude miss 60k tok/, line);
  assert.match(line, /GLM miss 9k tok/, line);
});

test('D: the capacity page axis says provider-native tokens', () => {
  const m = new AccountManager([acct('c1')], 0.9);
  const t = tui(m);
  assert.equal(typeof t._renderCapacityPage, 'function');
  const page = t._renderCapacityPage(200).map(l => strip(l)).join('\n');
  assert.match(page, /processed tokens \(provider-native\)/, page);
});

// ── E (finding 6): the wait figure says what it counts ───────────────────────

test('E: the wait figures say they count busy-bounce waits only', () => {
  const m = new AccountManager([acct('c1'), { ...acct('g1', 'provider'), provider: 'zai' }], 0.9);
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 9900, cc: 0, out: 1 }, { busyWaitMs: 8000 });
  const line = strip(tui(m)._efficiencyLine(160));
  assert.match(line, /busy-bounce waits 30 \(avg 8\.0s\)/, `relabeled: ${line}`);
  assert.doesNotMatch(line, /(?<![-a-z])waited 30/, `not the old ambiguous label: ${line}`);
});
