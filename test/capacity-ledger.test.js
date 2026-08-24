import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger } from '../src/capacity-ledger.js';

// Lanes A-F of the TEST PLAN. Clock always injected.

const T0 = Date.UTC(2026, 7, 22, 10, 0);

test('A1 accrue → close → history carries exactly the tokens accrued', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 1000, output: 500 }, T0);
  l.accrue('a', { input: 2000, output: 100 }, T0 + 60_000);
  const c = l.closeCycle('a', 'ses', T0 + 3600_000);
  assert.equal(c.tokens, 3600, 'input+output summed across accruals');
  assert.equal(c.complete, true);
});

test('A2 columns resolve in order: last > prev > prev1', () => {
  const l = new CapacityLedger({ now: () => T0 });
  let i = 0;
  for (const t of [100, 200, 300]) {
    l.accrue('a', { input: t, output: 0 }, T0 - 5 * 3600_000 + i);   // real 5h duration
    l.closeCycle('a', 'ses', T0 + i++);
  }
  const s = l.windowStats('a', 'ses');
  assert.equal(s.last, 300); assert.equal(s.prev, 200); assert.equal(s.prev1, 100);
});

test('A3 averages over COMPLETE cycles only (partial + disabled excluded)', () => {
  const l = new CapacityLedger({ now: () => T0 });
  const W = 5 * 3600_000;   // real window spans (the read floor rejects sub-window junk)
  l.accrue('a', { input: 100, output: 0 }, T0 - 3 * W); l.closeCycle('a', 'ses', T0 - 2 * W);
  l.accrue('a', { input: 900, output: 0 }, T0 - 2 * W + 1); l.markPartial('a'); l.closeCycle('a', 'ses', T0 - W);
  l.accrue('a', { input: 200, output: 0 }, T0 - W + 1); l.closeCycle('a', 'ses', T0);
  const s = l.windowStats('a', 'ses');
  assert.equal(s.avg3, 150, 'avg over {100,200} — the 900 partial is excluded');
  assert.equal(s.cycles, 2);
});

test('A4 fewer cycles than the avg window → average over what exists, never NaN', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 0 }, T0 - 5 * 3600_000); l.closeCycle('a', 'ses', T0);
  const s = l.windowStats('a', 'ses');
  assert.equal(s.avg3, 100); assert.equal(s.avg10, 100); assert.equal(s.allTime, 100);
  assert.equal(s.prev, null, 'no fabrication of missing cycles');
});

test('A5 bounded: the 51st cycle evicts the oldest', () => {
  const l = new CapacityLedger({ now: () => T0 });
  const W = 5 * 3600_000;
  for (let i = 0; i < 52; i++) {
    l.accrue('a', { input: i + 1, output: 0 }, T0 - (52 - i) * W);
    l.closeCycle('a', 'ses', T0 - (51 - i) * W);
  }
  const s = l.windowStats('a', 'ses');
  assert.equal(s.cycles, 50, 'kept 50');
  assert.equal(s.last, 52); assert.equal(s.prev, 51);
  assert.equal(s.allTime > 3, true, 'oldest evicted from averages');
});

test('B1 open-cycle tokens SURVIVE a restart (red-first: closed-only persistence fails this)', () => {
  const l1 = new CapacityLedger({ now: () => T0 });
  l1.accrue('a', { input: 5000, output: 0 }, T0);   // mid-cycle, NOT closed
  const payload = l1.serialize();                    // must carry the OPEN cycle
  const l2 = CapacityLedger.fromSerialized(payload);
  const open = l2.openCycle('a', 'ses');
  assert.ok(open, 'the open cycle survived the round-trip');
  assert.equal(open.tokensSoFar, 5000);
  l2.accrue('a', { input: 100, output: 0 }, T0 + 60_000);
  const c = l2.closeCycle('a', 'ses', T0 + 3600_000);
  assert.equal(c.tokens, 5100, 'post-restart accrual continues the SAME cycle');
});

test('B2 boot-gap → complete:false', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 10, output: 0 }, T0);
  // the caller detects the gap between lastAccrualAt and boot and calls this:
  l.markPartial('a');
  const c = l.closeCycle('a', 'ses', T0 + 10 * 3600_000);
  assert.equal(c.complete, false);
});

test('B3 unknown schemaVersion → tolerant empty, and unknown days tolerated', () => {
  const l = CapacityLedger.fromSerialized({ schemaVersion: 99, accounts: { a: { garbage: true } } });
  assert.equal(l.accounts().length, 0, 'starts empty');
  const corrupt = CapacityLedger.fromSerialized(null);
  assert.equal(corrupt.accounts().length, 0);
});

test('C4 sequential requests accumulate correctly across the same cycle', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 50 }, T0);
  l.accrue('a', { input: 200, output: 80 }, T0 + 1);
  l.accrue('a', { input: 10, output: 5 }, T0 + 2);
  const c = l.closeCycle('a', 'ses', T0 + 3);
  assert.equal(c.tokens, 445);
});

test('E2/F1 rolling-7d sums the last 7 CALENDAR days ending today; E3 partial flagged', () => {
  // Days run BACKWARD from the ledger's clock: the window is anchored on today, not on
  // whatever the newest bucket happens to be (an anchor on the newest bucket reported a
  // weeks-old window as current — red-team round 2, F2).
  const l = new CapacityLedger({ now: () => T0 });
  for (let d = 0; d < 5; d++) l.accrue('a', { input: 1000, output: 0 }, T0 - d * 86400_000);
  const r = l.rollingThroughput('a');
  assert.equal(r.tokens, 5000); assert.equal(r.partial, false);
  l.markDayPartial('a', new Date(T0 - 4 * 86400_000).toISOString().slice(0, 10));
  assert.equal(l.rollingThroughput('a').partial, true, 'the ≤observed marker');
});

test('E2b an IDLE account reads 0, never a stale window presented as current', () => {
  // The favourite legacy-GLM row sits idle for weeks under normal fleet rotation.
  const l = new CapacityLedger({ now: () => T0 });
  for (let d = 0; d < 5; d++) l.accrue('a', { input: 5_000_000, output: 0 }, T0 - (20 + d) * 86400_000);
  assert.equal(l.rollingThroughput('a').tokens, 0, '20 days idle → the 7d volume is 0, not 25M');
});

test('F2 a missing day is distinguishable from a zero day', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 0 }, T0 - 2 * 86400_000);
  l.accrue('a', { input: 300, output: 0 }, T0);                 // the day between is absent
  const keys = l.dayKeys('a');
  assert.equal(keys.length, 2);
  assert.ok(!keys.includes(new Date(T0 - 86400_000).toISOString().slice(0, 10)), 'the idle day is simply absent');
});

test('F3 bounded at 10 day-buckets; the 11th evicts the oldest', () => {
  const l = new CapacityLedger({ now: () => T0 });
  for (let d = 11; d >= 0; d--) l.accrue('a', { input: 100, output: 0 }, T0 - d * 86400_000);
  assert.equal(l.dayKeys('a').length, 10);
  assert.equal(l.rollingThroughput('a').tokens, 700, 'sums exactly the last 7 calendar days');
});

test('E4 the two account kinds never cross-contaminate (throughput vs tank)', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('capped', { input: 100, output: 0 }, T0 - 7 * 86400_000); l.closeCycle('capped', 'wk', T0);
  assert.ok(l.windowStats('capped', 'wk'), 'capped has a weekly tank');
  assert.equal(l.windowStats('noWk', 'wk'), null, 'no-weekly has NO tank — ever');
  assert.ok(l.rollingThroughput('noWk'), 'but it does have throughput');
});

// ── M1: capacity estimate from utilization (user spec 2026-08-23: "if 10% took A,
// 100% is A×10" — works mid-window, before any cycle completes) ───────────────

test('M1: tokens ÷ utilization = the implied tank, at any fullness', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.noteUtilizationObserved(T0);
  l.accrue('a', { input: 100_000, output: 0 }, T0);
  const e = l.estimateFromUtilization('a', 'ses', 0.10);
  assert.equal(e.tokens, 1_000_000, '10% full at 100k → 1M tank');
  assert.equal(e.utilization, 0.10);
  assert.equal(e.fresh, true, 'reading and accrual are same-window');
  assert.equal(l.estimateFromUtilization('a', 'ses', 0.96).tokens, 104_167);
});

test('M1b: null cases — no utilization, zero fullness, no accrual, or already capped', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 500, output: 0 }, T0);
  assert.equal(l.estimateFromUtilization('a', 'ses', 0), null, '0% full: 0÷0 is not a number');
  assert.equal(l.estimateFromUtilization('a', 'ses', null), null, 'vendor reports nothing');
  assert.equal(l.estimateFromUtilization('a', 'ses', 1), null, '100% full: the fraction says nothing about the tank');
  assert.equal(l.estimateFromUtilization('nobody', 'ses', 0.5), null, 'no open cycle');
  const l2 = new CapacityLedger({ now: () => T0 });
  l2.noteUtilizationObserved(T0);
  assert.equal(l2.estimateFromUtilization('a', 'ses', 0.5), null, 'utilization but zero accrual');
});

test('M1c: a stale utilization from the PREVIOUS window is marked not-fresh', () => {
  // Utilization refreshes on probe/header; the open cycle rolls at the boundary. An
  // old reading silently understates the estimate — flag it rather than trust it.
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 50_000, output: 0 }, T0);
  const stale = l.estimateFromUtilization('a', 'ses', 0.10);
  assert.equal(stale.fresh, false, 'no reading was ever noted → cannot prove same-window');
});

// ── M5: the DELTA method — pre-join usage cancels, estimate is exact mid-window ──

test('M5: delta method recovers the tank exactly despite a mid-window join', () => {
  // The absolute method's blind spot, reproduced: a 3M tank with 1.8M spent BEFORE the
  // ledger ever started counting. Absolute says 545k (2.2x understatement); delta says 3M.
  const l = new CapacityLedger({ now: () => T0 });
  const TANK = 3_000_000, PRE = 1_800_000;
  l.accrue('a', { input: 100_000, output: 0 }, T0);      // first observed tokens
  // The reading PAIRS with what has accrued at this instant: PRE + the 100k we saw.
  const u1 = (PRE + 100_000) / TANK;
  l.noteUtilizationObserved(T0, [{ name: 'a', window: 'ses', utilization: u1 }]);
  l.accrue('a', { input: 300_000, output: 0 }, T0 + 3600_000);
  const e = l.estimateFromUtilization('a', 'ses', (PRE + 400_000) / TANK);
  assert.equal(e.method, 'delta', 'the delta branch fires');
  assert.ok(Math.abs(e.tokens - TANK) < 0.02 * TANK, `~exact tank (got ${e.tokens})`);
  assert.equal(e.fresh, true);
});

test('M5b: the mark resets when the window rolls — no cross-cycle differencing', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 10_000, output: 0 }, T0);
  l.noteUtilizationObserved(T0, [{ name: 'a', window: 'ses', utilization: 0.1 }]);
  // window rolls; a fresh cycle opens at a LOW utilization
  l.closeCycle('a', 'ses', T0 + 1);
  l.accrue('a', { input: 5_000, output: 0 }, T0 + 2);
  const e = l.estimateFromUtilization('a', 'ses', 0.05);
  assert.equal(e.method, 'absolute', 'a reading below the previous-cycle mark cannot delta — falls back');
});

test('M5c: rounded-percent noise is refused a denominator', () => {
  // Vendors report whole percents. A 0.5pp move is rounding, not usage: 466 tokens ÷
  // 0.005 would claim a 93k tank. The delta branch requires >=2pp.
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 466, output: 0 }, T0);
  l.noteUtilizationObserved(T0, [{ name: 'a', window: 'ses', utilization: 0.10 }]);
  l.accrue('a', { input: 466, output: 0 }, T0 + 1);
  const e = l.estimateFromUtilization('a', 'ses', 0.105);
  assert.equal(e.method, 'absolute', 'sub-2pp delta falls back to absolute');
});

test('M5d: the absolute fallback is flagged a lower bound when joined mid-window', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 400_000, output: 0 }, T0);
  const open = l.openCycle('a', 'ses');
  open.windowStartedAt = T0 - 3 * 3600_000;   // the window began 3h before we joined
  const e = l.estimateFromUtilization('a', 'ses', 0.4);
  assert.equal(e.method, 'absolute');
  assert.equal(e.lowerBound, true, 'flagged — the UI renders ≥');
});

// ── R-lane: read-time junk floor (live defect 2026-08-24) ─────────────────────
// The user's highest-capacity account showed avg 548k against a true ~685k: a
// 0.5-second/588-token "complete cycle" (fold refused on an endedAt mismatch) sat in
// the averages. A complete+enabled cycle under 80% of its window is writer junk — a
// genuine short cycle is flagged partial at write time, never complete.

test('R1: a complete sub-floor cycle never reaches the columns', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l._accounts.set('a', { ses: { open: null, closed: [
    { startedAt: T0 - 5 * 3600_000, endedAt: T0, tokens: 1_000_000, complete: true, disabledDuring: false, resetAt: T0 },
    { startedAt: T0 - 500, endedAt: T0, tokens: 588, complete: true, disabledDuring: false, resetAt: T0 },
  ] }, wk: { open: null, closed: [] }, days: {} });
  const s = l.windowStats('a', 'ses');
  assert.equal(s.cycles, 1, 'only the real window counts');
  assert.equal(s.last, 1_000_000);
  assert.equal(s.avg3, 1_000_000, 'avg3 not dragged by the sliver');
});

test('R2: a PARTIAL short cycle stays visible data — the floor only fires on complete', () => {
  // Partial cycles are excluded from averages by design; the floor must not hide them
  // from any future "all observations" view, and must not error on them.
  const l = new CapacityLedger({ now: () => T0 });
  l._accounts.set('a', { ses: { open: null, closed: [
    { startedAt: T0 - 500, endedAt: T0, tokens: 588, complete: false, disabledDuring: false, resetAt: T0 },
  ] }, wk: { open: null, closed: [] }, days: {} });
  const s = l.windowStats('a', 'ses');
  assert.equal(s, null, 'no counted cycles — but no crash either');
});

test('R3: the floor is per-window — a 4.5h ses cycle passes, a 5.5-day wk cycle passes', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l._accounts.set('a', {
    ses: { open: null, closed: [{ startedAt: T0 - 4.5 * 3600_000, endedAt: T0, tokens: 700_000, complete: true, disabledDuring: false, resetAt: T0 }] },
    wk: { open: null, closed: [{ startedAt: T0 - 5.5 * 86400_000, endedAt: T0, tokens: 3_000_000, complete: true, disabledDuring: false, resetAt: T0 }] },
    days: {} });
  assert.equal(l.windowStats('a', 'ses').last, 700_000, '90% of a 5h window is real');
  assert.equal(l.windowStats('a', 'wk').last, 3_000_000, '79% of a weekly window is real');
});
