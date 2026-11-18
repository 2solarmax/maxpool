// The weekly PAGE the owner reads (2026-10-13): columns must be tank-units
// throughout, partial (downtime) cycles must surface, and the no-weekly derived
// row must mark its derivation. Pairs with weekly-capacity-partial.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const SEVEN_D = 7 * 86400_000;

const oauth = (name = 'a1') => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });

function amWith(name = 'kira') {
  const am = new AccountManager([oauth(name)], 0.90);
  return am;
}

function closeWeek(am, name, { tokens, util, endedAt, complete }) {
  am.capacity.accrue(name, { input: tokens, output: 0 }, endedAt - SEVEN_D);
  const open = am.capacity.openCycle(name, 'wk');
  open.windowStartedAt = endedAt - SEVEN_D;
  open.complete = complete;
  am.capacity.closeCycle(name, 'wk', endedAt, { resetAt: endedAt, finalUtilization: util });
}

function renderWk(am, width = 120) {
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'wk';
  return tui._renderCapacityPage(width).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
}

test('P1: a downtime-partial weekly cycle fills Prev/Avg/N — no more "--"', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - SEVEN_D, complete: false });
  closeWeek(am, 'kira', { tokens: 6_000_000, util: 0.6, endedAt: end, complete: false });
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /10M\s+10M\s+10M\s+2/, 'Prev, Avg AND N all render from partial cycles');
});

test('P2: an open weekly cycle renders as the live Current, not empty', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - SEVEN_D, complete: false });
  // open cycle ticking + a live reading
  am.accrueCapacity(0, { input: 1_000_000, output: 0 });
  am.accounts[0].quota.unified7d = 0.5;
  am.capacity.noteUtilizationObserved();
  // AUDIT D2 + RED-TEAM F1 (2026-11-18): Current prefers the LIVE window, but this
  // fixture's open cycle is late-joined (started mid-window) with a single reading —
  // an understating lower bound, so history (10M) shows instead. The columns are
  // never empty and never a fiction.
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.ok(row, 'row present');
  assert.match(row, /10M\s+10M\s+10M\s+10M\s+1/, 'Current falls to history, Prev/Med-3/Med-all from history, N=1');
});

test('P3: the no-weekly derived row is marked "≈" so it reads as derived', () => {
  const am = new AccountManager([
    { name: 'glm-legacy', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] },
  ], 0.90);
  am.accounts[0].quota.weeklyAbsent = true;
  // two session cycles with readings → avg tank 1M → derived ≈ 33.6M
  for (const u of [0.5, 0.5]) {
    const end = Date.now() - 1000;
    am.capacity.accrue('glm-legacy', { input: 500_000, output: 0 }, end - 5 * 3600_000);
    const open = am.capacity.openCycle('glm-legacy', 'ses');
    open.windowStartedAt = end - 5 * 3600_000;
    am.capacity.closeCycle('glm-legacy', 'ses', end, { resetAt: end, finalUtilization: u });
  }
  const row = renderWk(am).split('\n').find(l => l.includes('glm-legacy'));
  // NO ≈ prefix: the owner removed it 2026-08-26 (bfe03bd) — "the row's own text
  // already states the ×33.6 derivation". This test now pins BOTH the number and
  // the absence of the marker, so it can't quietly come back.
  assert.match(row, /\s67M\s/, 'the ×33.6 derivation renders (2M tank × 33.6)');
  assert.match(row, /no weekly limit/, 'the row still says why');
  assert.doesNotMatch(row, /≈/, 'the owner-removed ≈ marker stays out');
});

// ── 2026-11-18 audit D2/D4: Current is the LIVE window; Prev is the newest FINISHED cycle ──
test('D2: Current shows the OPEN window, not the closed median, when history exists', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - SEVEN_D, complete: false });
  // An open week, watched from its start: util 0.20→0.77 with 2.7B counted → ~3.5B tank.
  const T0 = end;
  am.capacity.accrue('kira', { input: 2_700_000_000, output: 0 }, T0);
  am.capacity.noteUtilizationObserved(T0, [{ name: 'kira', window: 'wk', utilization: 0.20 }]);
  am.capacity.noteUtilizationObserved(end, [{ name: 'kira', window: 'wk', utilization: 0.77 }]);
  am.capacity.openCycle('kira', 'wk').windowStartedAt = T0;
  am.accounts[0].quota.unified7d = 0.77;
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /3\.5B/, `Current must be the live window (~3.5B), row: ${row}`);
  assert.doesNotMatch(row, /10M\s+--\s+10M/, 'Current must not repeat the closed median');
});
test('D4: Prev renders the newest finished cycle once Current is live', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - 2 * SEVEN_D, complete: false });
  closeWeek(am, 'kira', { tokens: 8_000_000, util: 0.8, endedAt: end - SEVEN_D, complete: false });
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /10M\s+10M\s+10M\s+2/, 'two finished cycles: Prev=10M (newest finished), Med columns, N=2');
});

// ── D8/D10: the price is monthly-normalized and never rounds to $0.00 ──
test('D8: $/1M divides the monthly price by 4.3486 weekly tanks (kira $200/mo, 3.0B tank → ≈$0.015)', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 1_500_000_000, util: 0.5, endedAt: end, complete: false });
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /\$0\.015/, `monthly-normalized price, row: ${row}`);
});
test('D10: a huge tank never renders $0.00 (significant digits, not toFixed(2))', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 10_000_000_000, util: 1.0, endedAt: end, complete: false });
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  // '$0.00' followed by a digit is fine ($0.005); a bare '$0.00' cell is the bug.
  assert.ok(!/\$0\.00(?![0-9])/.test(row), `no bare $0.00 cell, row: ${row}`);
  assert.match(row, /\$0\.0046/, `a real sub-cent price shows 2 significant digits ($0.0046), row: ${row}`);
});

// ── D11/D12: the no-weekly row's ceiling is peak-aware and N is labelled ──
const providerNoWeekly = (name) => {
  const a = {
    name, type: 'provider', provider: 'zai', authToken: 'k', upstream: 'http://x',
    profiles: ['all'],
  };
  return a;
};
const markNoWeekly = (am) => { am.accounts[0].quota.weeklyAbsent = true; };
test('D11/D12: a weeklyAbsent provider labels its ceiling max, its N as 5h cycles, and stays honest about the derivation', () => {
  const am = new AccountManager([providerNoWeekly('glm max')], 0.95);
  markNoWeekly(am);   // addAccount replaces quota with emptyQuota — set it after
  // Two 5h session cycles at 400M and 600M → ses median 500M.
  const now = Date.now();
  for (const [tok, end] of [[400e6, now - 5*3600e3], [600e6, now]]) {
    am.capacity.accrue('glm max', { input: tok, output: 0 }, end - 5 * 3600e3);
    const o = am.capacity.openCycle('glm max', 'ses');
    o.windowStartedAt = end - 5 * 3600e3;
    am.capacity.closeCycle('glm max', 'ses', end, { resetAt: end, finalUtilization: 0.9 });
  }
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'wk';
  const txt = tui._renderCapacityPage(160).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const row = txt.split('\n').find(l => l.includes('glm max'));
  assert.ok(row, 'row present');
  assert.match(row, /B max/, 'the derived weekly figure is labelled as a ceiling ("… max")');
  assert.match(row, /2 \(5h\)/, 'N is labelled "(5h)" — not the footer derivation text');
});

// ── D13: the Plan column shows the live z.ai price when no plan object exists ──
test('D13: a provider row with a live monthly price shows it in the Plan cell', () => {
  const am = new AccountManager([{
    name: 'glm priced', type: 'provider', provider: 'zai', authToken: 'k', upstream: 'http://x', profiles: ['all'],
  }], 0.95);
  am.accounts[0].monthlyPriceUSD = 111;
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'wk';
  const txt = tui._renderCapacityPage(160).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const row = txt.split('\n').find(l => l.includes('glm priced'));
  assert.match(row, /\$111\/mo/, `live z.ai price in the Plan cell, row: ${row}`);
});

// ── Red team 2026-11-18 (F1-F4): the live Current must respect the same floors the
// ledger applies; mirror rows use the cloud's live week even with history; exported
// est beats thinned samples; a final-utilization spike cannot smuggle a one-slice cycle. ──
test('F1: a low-fullness open week does NOT render an inflated Current — history shows instead', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - SEVEN_D, complete: false });
  am.capacity.accrue('kira', { input: 455_000, output: 0 }, end);
  am.capacity.noteUtilizationObserved(end, [{ name: 'kira', window: 'wk', utilization: 0.01 }]);
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /10M/, 'history shows — the 455k@1% window is rounding noise');
  assert.doesNotMatch(row, /46M/, 'no inflated 46M from 455k ÷ 1%');
});
test('F1: a late-joined open week does NOT render a low Current — history shows instead', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 5_000_000, util: 0.5, endedAt: end - SEVEN_D, complete: false });
  // Joined 4 days in; the ledger's open cycle started mid-window.
  am.capacity.accrue('kira', { input: 1_000_000, output: 0 }, end);
  am.capacity.noteUtilizationObserved(end, [{ name: 'kira', window: 'wk', utilization: 0.50 }]);
  const o = am.capacity.openCycle('kira', 'wk');
  o.windowStartedAt = end - 4 * SEVEN_D;   // window began 4d before the ledger did
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /10M/, 'history shows; a 2M lower-bound is not the tank');
  assert.doesNotMatch(row, /2\.0M/, 'no understated 2.0M from a late-joined divide');
});
