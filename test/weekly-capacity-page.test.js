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
  closeWeek(am, 'kira', { tokens: 3_000_000, util: 0.3, endedAt: end - SEVEN_D, complete: false });
  closeWeek(am, 'kira', { tokens: 6_000_000, util: 0.6, endedAt: end, complete: false });
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.match(row, /10M\s+10M\s+10M\s+2/, 'Prev, Avg AND N all render from partial cycles');
});

test('P2: an open weekly cycle renders as the live Current, not empty', () => {
  const am = amWith('kira');
  const end = Date.now();
  closeWeek(am, 'kira', { tokens: 3_000_000, util: 0.3, endedAt: end - SEVEN_D, complete: false });
  // open cycle ticking + a live reading
  am.accrueCapacity(0, { input: 1_000_000, output: 0 });
  am.accounts[0].quota.unified7d = 0.5;
  am.capacity.noteUtilizationObserved();
  // The CURRENT window is open but already carries one usable closed cycle in
  // history: Current falls back to the measured tank average (10M) rather than the
  // 2M open-window estimate — the existing M4 precedence, kept. The open cycle's
  // own number will become a proper column when it closes. What must NOT happen is
  // an empty Current with history sitting right there.
  const row = renderWk(am).split('\n').find(l => l.includes('kira'));
  assert.ok(row, 'row present');
  assert.match(row, /10M\s+--\s+10M\s+1/, 'closed history renders (Current=tank avg, Avg, N)');
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
