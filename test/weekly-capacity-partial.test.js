// Weekly-capacity partial-cycle handling (owner report 2026-10-13:
// "for week we seem to be lacking data completely").
//
// A weekly window is 7 days; maxpool restarts/sleeps far more often than that, so
// restoreCapacityState's >60s downtime check marks essentially EVERY weekly cycle
// partial. tankStats filtered complete-only, so the Weekly (7d) page showed
// Prev/Avg/N as "--" for nearly every account while the data was sitting right
// there. The tank formula (tokens ÷ vendor %) is a lower bound whenever spend was
// unseen, so a downtime-partial cycle with a reading is still evidence — include
// it, bounded. Operator-disabled cycles and no-weekly retirements still never count.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger } from '../src/capacity-ledger.js';

const SEVEN_D = 7 * 86400_000;

function closeWeek(l, name, { tokens, util, startedAt, endedAt, complete = true, disabled = false, windowStartedAt = startedAt }) {
  l.accrue(name, { input: tokens, output: 0 }, startedAt);
  const open = l.openCycle(name, 'wk');
  open.windowStartedAt = windowStartedAt;
  open.complete = complete;
  open.disabledDuring = disabled;
  l.closeCycle(name, 'wk', endedAt, { resetAt: endedAt, finalUtilization: util });
}

// ── RC1: downtime-partial weekly cycles still yield a tank ────────────────────

test('W1: a partial (downtime-marked) weekly cycle with a reading still yields a tank', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'kira', { tokens: 7_000_000, util: 0.7, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  const t = l.tankStats('kira', 'wk');
  assert.ok(t, 'the reading is a lower bound, not nothing');
  assert.equal(t.avg, 10_000_000);
  assert.equal(t.n, 1);
  assert.equal(t.exact, 0, 'a joined-late/downtime cycle is counted as bounded, not exact');
  assert.equal(t.bounded, 1);
  assert.equal(t.lowerBound, true);
});

test('W2: windowStats (delivered/demand) still EXCLUDES partial cycles — strict gate unchanged', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'kira', { tokens: 7_000_000, util: 0.7, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  assert.equal(l.windowStats('kira', 'wk'), null, 'demand stats keep the all-or-nothing gate');
});

test('W2b: a markPartial() AFTER accrual is what a real downtime cycle looks like', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('kira', { input: 5_000_000, output: 0 }, end - SEVEN_D);
  const open = l.openCycle('kira', 'wk');
  open.windowStartedAt = end - SEVEN_D;
  l.markPartial('kira');                       // restoreCapacityState path
  l.closeCycle('kira', 'wk', end, { resetAt: end, finalUtilization: 0.5 });
  const t = l.tankStats('kira', 'wk');
  assert.ok(t, 'downtime-partial via markPartial still counts for the tank');
  assert.equal(t.avg, 10_000_000);
});

test('W3: disabledDuring and no-weekly retires NEVER count, partial or not', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'd1', { tokens: 7_000_000, util: 0.7, startedAt: end - SEVEN_D, endedAt: end, complete: false, disabled: true });
  closeWeek(l, 'n1', { tokens: 7_000_000, util: 0.7, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  l.closeCycle('n1', 'wk', Date.now(), {}); // (already closed; second close is a no-op)
  assert.equal(l.tankStats('d1', 'wk'), null, 'operator-disabled is never a capacity');
});

test('W3b: a partialReason of pre-v3-unverified still NEVER counts (trust boundary)', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'old', { tokens: 7_000_000, util: 0.7, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  const closed = l._accounts.get('old').wk.closed;
  closed[closed.length - 1].partialReason = 'pre-v3-unverified';
  assert.equal(l.tankStats('old', 'wk'), null);
});

test('W4: markPartial records a reason; restore passes "maxpool-downtime"', () => {
  const l = new CapacityLedger();
  l.accrue('a', { input: 1, output: 0 }, Date.now() - 1000);
  l.markPartial('a');
  assert.ok(!('partialReason' in l.openCycle('a', 'ses')), 'default keeps historic bare-false behaviour');
  const l2 = new CapacityLedger();
  l2.accrue('a', { input: 1, output: 0 }, Date.now() - 1000);
  l2.markPartial('a', { reason: 'maxpool-downtime' });
  assert.equal(l2.openCycle('a', 'ses').partialReason, 'maxpool-downtime');
});

// ── RC2: prev joins tankStats, page columns coherent ─────────────────────────

test('W5: tankStats exposes prev — second-newest usable reading, same units as avg', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'a', { tokens: 3_000_000, util: 0.3, startedAt: end - 2 * SEVEN_D, endedAt: end - SEVEN_D, complete: false });
  closeWeek(l, 'a', { tokens: 6_000_000, util: 0.6, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  const t = l.tankStats('a', 'wk');
  assert.equal(t.last, 10_000_000);
  assert.equal(t.prev, 10_000_000, 'prev is a TANK number (tokens÷util), not a delivered number');
  assert.equal(t.n, 2);
});

test('W6: prev is null with a single usable reading, even when more cycles exist', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'a', { tokens: 7_000_000, util: 0.7, startedAt: end - 2 * SEVEN_D, endedAt: end - SEVEN_D, complete: false });
  closeWeek(l, 'a', { tokens: 100, util: 0.02, startedAt: end - SEVEN_D, endedAt: end, complete: false }); // sub-floor: never usable
  const t = l.tankStats('a', 'wk');
  assert.equal(t.prev, null, 'only one usable reading → no prev');
  assert.equal(t.n, 1);
});

// ── RC-late: cycles that swallowed a rollover / carried the NEXT window's reading ──

test('W7: a cycle 2x its window length never counts — it swallowed a rollover', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'a', { tokens: 7_000_000, util: 0.7, startedAt: end - 14 * 86400_000, endedAt: end, complete: false });
  assert.equal(l.tankStats('a', 'wk'), null, 'two tanks over one percentage is not an observation');
});

test('W8: a closing reading BELOW the cycle peak is the next window\'s — peak wins', () => {
  // Live 2026-10-13 (kira): a 3.1M-token week closed at "3% full" only because the
  // reset had already fired — the true closing fullness was the week\'s own peak.
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('a', { input: 3_100_000, output: 0 }, end - SEVEN_D);
  const open = l.openCycle('a', 'wk');
  open.windowStartedAt = end - SEVEN_D;
  open.peakUtilization = 0.86;            // the highest reading THIS window showed
  open.complete = false;
  l.closeCycle('a', 'wk', end, { resetAt: end, finalUtilization: 0.03 });
  const t = l.tankStats('a', 'wk');
  assert.ok(t, 'still yields a tank');
  assert.equal(t.avg, Math.round(3_100_000 / 0.86), 'divided by the peak, not the stale 3%');
});

test('W9: the PEAK is recorded from real readings; small dips never lower it', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('a', { input: 1_000_000, output: 0 }, end - SEVEN_D);
  for (const u of [0.2, 0.6, 0.86, 0.80]) l.noteUtilizationObserved(end, [{ name: 'a', window: 'wk', utilization: u }]);
  assert.equal(l.openCycle('a', 'wk').peakUtilization, 0.86, 'a 6pp dip (rounding/jitter) never lowers the peak');
});

// ── red-team 2026-10-13 findings 2-6 ─────────────────────────────────────────

test('W10: a >=10pp DROP means the tank refilled under the open cycle — the cycle is excluded', () => {
  // Redeemed reset / late rollover stamp: the old window's peak must never divide
  // the new window's tokens (reproduced: 1.37M ÷ 0.97 shown vs 1.0M truth).
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('a', { input: 1_370_000, output: 0 }, end - SEVEN_D);
  for (const u of [0.5, 0.97, 0.05, 0.40]) l.noteUtilizationObserved(end, [{ name: 'a', window: 'wk', utilization: u }]);
  const open = l.openCycle('a', 'wk');
  open.windowStartedAt = end - SEVEN_D;
  l.closeCycle('a', 'wk', end, { resetAt: end, finalUtilization: 0.40 });
  assert.equal(l.tankStats('a', 'wk'), null, 'two tanks inside one cycle is not an observation');
});

test('W11: a 1.0 (wall) reading never becomes the peak', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('a', { input: 3_100_000, output: 0 }, end - SEVEN_D);
  l.noteUtilizationObserved(end, [{ name: 'a', window: 'wk', utilization: 0.5 }]);
  l.noteUtilizationObserved(end, [{ name: 'a', window: 'wk', utilization: 1.0 }]);
  assert.equal(l.openCycle('a', 'wk').peakUtilization, 0.5, 'the wall says nothing about tank size');
});

test('W12: the physical floor holds on ALL-PARTIAL weekly history', () => {
  // Reproduced by the reviewer: 3 downtime-partial weeks (1.53M@50%, 497k@95%
  // contaminated, 2M@50%) showed Prev=523k — below the 1.53M actually delivered.
  const l = new CapacityLedger();
  const end = Date.now();
  closeWeek(l, 'a', { tokens: 1_530_000, util: 0.5, startedAt: end - 3 * SEVEN_D, endedAt: end - 2 * SEVEN_D, complete: false });
  closeWeek(l, 'a', { tokens: 497_000, util: 0.95, startedAt: end - 2 * SEVEN_D, endedAt: end - SEVEN_D, complete: false });
  closeWeek(l, 'a', { tokens: 2_000_000, util: 0.5, startedAt: end - SEVEN_D, endedAt: end, complete: false });
  const t = l.tankStats('a', 'wk');
  assert.ok(t.prev >= 2_000_000, `prev never below a real delivery (got ${t.prev})`);
  for (const v of [t.avg, t.last, t.prev]) assert.ok(v >= 2_000_000, 'every shown tank >= max delivered');
});

test('W13: a no-weekly-plan retired cycle never counts, even with a recorded peak', () => {
  const l = new CapacityLedger();
  const end = Date.now();
  l.accrue('n1', { input: 7_000_000, output: 0 }, end - SEVEN_D);
  l.noteUtilizationObserved(end, [{ name: 'n1', window: 'wk', utilization: 0.7 }]);
  const open = l.openCycle('n1', 'wk');
  open.complete = false;
  open.partialReason = 'no-weekly-plan';
  l.closeCycle('n1', 'wk', end, {});
  assert.equal(l.tankStats('n1', 'wk'), null);
});


test('W14: the REAL restore path tags downtime-partial cycles "maxpool-downtime"', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const am = new AccountManager([{ name: 'k', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  am.capacity.accrue('k', { input: 1000, output: 0 }, Date.now() - 3600_000);
  const payload = am.capacity.serialize();
  am.restoreCapacityState(payload, Date.now(), 5 * 60_000);   // 5 min of maxpool downtime
  assert.equal(am.capacity.openCycle('k', 'wk').partialReason, 'maxpool-downtime');
  assert.equal(am.capacity.openCycle('k', 'wk').complete, false);
});
