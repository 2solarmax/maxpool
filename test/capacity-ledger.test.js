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
  for (const t of [100, 200, 300]) {
    l.accrue('a', { input: t, output: 0 }, T0);
    l.closeCycle('a', 'ses', T0 + t);
  }
  const s = l.windowStats('a', 'ses');
  assert.equal(s.last, 300); assert.equal(s.prev, 200); assert.equal(s.prev1, 100);
});

test('A3 averages over COMPLETE cycles only (partial + disabled excluded)', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 0 }, T0); l.closeCycle('a', 'ses', T0 + 1);
  l.accrue('a', { input: 900, output: 0 }, T0 + 2); l.markPartial('a'); l.closeCycle('a', 'ses', T0 + 3);
  l.accrue('a', { input: 200, output: 0 }, T0 + 4); l.closeCycle('a', 'ses', T0 + 5);
  const s = l.windowStats('a', 'ses');
  assert.equal(s.avg3, 150, 'avg over {100,200} — the 900 partial is excluded');
  assert.equal(s.cycles, 2);
});

test('A4 fewer cycles than the avg window → average over what exists, never NaN', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 0 }, T0); l.closeCycle('a', 'ses', T0 + 1);
  const s = l.windowStats('a', 'ses');
  assert.equal(s.avg3, 100); assert.equal(s.avg10, 100); assert.equal(s.allTime, 100);
  assert.equal(s.prev, null, 'no fabrication of missing cycles');
});

test('A5 bounded: the 51st cycle evicts the oldest', () => {
  const l = new CapacityLedger({ now: () => T0 });
  for (let i = 0; i < 52; i++) {
    l.accrue('a', { input: i + 1, output: 0 }, T0 + i);
    l.closeCycle('a', 'ses', T0 + i + 1000);
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

test('E2/F1 rolling-7d from day buckets; E3 partial flagged', () => {
  const l = new CapacityLedger({ now: () => T0 });
  for (let d = 0; d < 5; d++) l.accrue('a', { input: 1000, output: 0 }, T0 + d * 86400_000);
  const r = l.rollingThroughput('a');
  assert.equal(r.tokens, 5000); assert.equal(r.partial, false);
  l.markDayPartial('a', new Date(T0 + 4 * 86400_000).toISOString().slice(0, 10));
  assert.equal(l.rollingThroughput('a').partial, true, 'the ≤observed marker');
});

test('F2 a missing day is distinguishable from a zero day', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('a', { input: 100, output: 0 }, T0);          // day 1
  l.accrue('a', { input: 300, output: 0 }, T0 + 2 * 86400_000);  // day 3 — day 2 absent
  const keys = l.dayKeys('a');
  assert.equal(keys.length, 2);
  assert.ok(!keys.includes(new Date(T0 + 86400_000).toISOString().slice(0, 10)), 'day 2 simply absent');
});

test('F3 bounded at 10 day-buckets; the 11th evicts the oldest', () => {
  const l = new CapacityLedger({ now: () => T0 });
  for (let d = 0; d < 12; d++) l.accrue('a', { input: 100, output: 0 }, T0 + d * 86400_000);
  assert.equal(l.dayKeys('a').length, 10);
  assert.equal(l.rollingThroughput('a').tokens, 700, 'sums exactly the last 7 days');
});

test('E4 the two account kinds never cross-contaminate (throughput vs tank)', () => {
  const l = new CapacityLedger({ now: () => T0 });
  l.accrue('capped', { input: 100, output: 0 }, T0); l.closeCycle('capped', 'wk', T0 + 1);
  assert.ok(l.windowStats('capped', 'wk'), 'capped has a weekly tank');
  assert.equal(l.windowStats('noWk', 'wk'), null, 'no-weekly has NO tank — ever');
  assert.ok(l.rollingThroughput('noWk'), 'but it does have throughput');
});
