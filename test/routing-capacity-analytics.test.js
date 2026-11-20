import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { capacityKpiWindow, provisioningEvidence, RoutingCapacityAnalytics } from '../src/routing-capacity-analytics.js';

const MIN = 60_000, WEEK = 7 * 24 * 60 * MIN, RESET = Date.UTC(2026, 10, 20);
const owner = 'vendor-id-a';
const emptyDemand = () => ({ arrivals: 0, peerArrivals: 0, peakOutstanding: 0, completeCoverage: true });
function observe(meter, observedAt, utilization, other = {}) {
  meter.observe({ owner, window: 'wk', resetAt: RESET, observedAt, utilization, ...other });
}
function firstCycle(meter, now = RESET) {
  return meter.snapshot(owner, now).cycles[0];
}

test('idle and fully used subscriptions both generate cycles without any MaxPool token accrual', () => {
  const meter = new RoutingCapacityAnalytics({ demandBetween: (startAt, endAt) => {
    assert.equal(startAt, RESET - WEEK);
    assert.equal(endAt, RESET);
    return emptyDemand();
  } });
  for (const [id, used] of [[owner, 0], ['exhausted', 1]]) {
    observe(meter, RESET - WEEK, used, { owner: id });
    observe(meter, RESET - MIN, used, { owner: id });  // identical reading refreshes the evidence
  }
  meter.advance(RESET);
  const idle = firstCycle(meter);
  assert.equal(idle.unusedFraction, 1);
  assert.equal(idle.attribution, 'no-observed-demand');
  assert.equal(idle.observedAt, RESET - MIN);
  assert.equal(idle.reason, 'natural-reset');
  assert.equal(meter.snapshot('exhausted', RESET).cycles[0].attribution, 'fully-used');
  assert.equal(meter.snapshot('exhausted', RESET).meanUnusedFraction, 0);
});

test('a missed natural close is unknown and never turns a stale reading into available headroom', () => {
  const meter = new RoutingCapacityAnalytics({ demandBetween: emptyDemand });
  observe(meter, RESET - 10 * MIN, 0.125);
  // Neither a stale index nor a partially populated mark can make the old reading fresh.
  for (const utilization of [null, undefined, NaN, -1, 1.01]) observe(meter, RESET - MIN, utilization);
  observe(meter, RESET - MIN, 0, { resetAt: null });
  meter.advance(RESET + 4 * WEEK);
  const snapshot = meter.snapshot(owner, RESET + 4 * WEEK);
  assert.equal(snapshot.cycles.length, 1);  // no invented windows during downtime
  assert.equal(snapshot.unknownCycles, 1);
  assert.equal(snapshot.measuredCycles, 0);
  assert.equal(snapshot.meanUnusedFraction, null);
  assert.equal(snapshot.cycles[0].unusedFraction, null);
  assert.equal(snapshot.cycles[0].reason, 'stale-reading');
});

test('a grant, inferred refill, plan change or operator disable cannot manufacture natural headroom', () => {
  for (const [event, reason] of [
    [meter => meter.markRefill(owner, RESET - MIN), 'refill'],
    [meter => observe(meter, RESET - MIN, 0.7, { lastClaimAt: RESET - 3 * MIN }), 'refill'],
    [meter => observe(meter, RESET - MIN, 0.6), 'refill'],
    [meter => meter.markUnavailable(owner), 'disabled'],
    [meter => observe(meter, RESET - 2 * MIN, 0.05, { window: 'ses', resetAt: RESET + 50 * MIN }), 'replaced-before-reset'],
  ]) {
    const meter = new RoutingCapacityAnalytics();
    observe(meter, RESET - 3 * MIN, 0.7);
    event(meter);
    meter.advance(RESET);
    const row = firstCycle(meter);
    assert.equal(row.reason, reason);
    assert.equal(row.attribution, 'unknown');
    assert.equal(row.unusedFraction, null);
  }
});

test('weekly takes precedence unless a GLM subscription positively reports it has only the short window', () => {
  const glm = { type: 'provider', provider: 'zai', quota: {} };
  assert.equal(capacityKpiWindow(glm), 'wk');
  assert.equal(capacityKpiWindow({ ...glm, quota: { weeklyAbsent: true } }), 'ses');
  assert.equal(capacityKpiWindow({ ...glm, provider: 'kimi', quota: { weeklyAbsent: true } }), 'wk');
  assert.equal(capacityKpiWindow({ type: 'oauth', provider: 'codex', quota: { weeklyAbsent: true } }), 'wk');
});

test('real provider probe and status paths record idle legacy GLM session expirations and a weekly GLM only once', () => {
  const accounts = ['legacy', 'weekly'].map(name => ({
    type: 'provider', provider: 'zai', name, authToken: 'test-' + name, upstream: 'http://localhost', profiles: ['all'],
  }));
  const am = new AccountManager(accounts);
  const resetAt = Date.now() + MIN;
  const ses = { utilization: 0.25, resetAt };
  am.applyProviderUsage(0, { source: 'zai', ses });
  am.applyProviderUsage(1, { source: 'zai', ses, wk: { utilization: 0.75, resetAt } });
  am.closeExpiredCapacityCycles(resetAt);
  const rows = am.routingReport(resetAt).quotas;
  assert.deepEqual(rows.map(row => [row.name, row.window, row.cycles.length, row.cycles[0]?.unusedFraction]), [
    ['legacy', 'ses', 1, 0.75], ['weekly', 'wk', 1, 0.25],
  ]);
});

test('an early reset-stamp advance is excluded, an ordinary advance closes with the prior reading', () => {
  const meter = new RoutingCapacityAnalytics();
  observe(meter, RESET - 7 * MIN, 0.75);
  const replaced = RESET - 5 * MIN;
  observe(meter, replaced, 0, { resetAt: replaced + WEEK });
  const early = firstCycle(meter, replaced);
  assert.equal(early.reason, 'replaced-before-reset');
  assert.equal(early.unusedFraction, null);
  observe(meter, replaced + WEEK - MIN, 0.75, { resetAt: replaced + WEEK });
  observe(meter, replaced + WEEK + MIN, 0.01, { resetAt: replaced + 2 * WEEK });
  assert.equal(firstCycle(meter, replaced + WEEK + MIN).unusedFraction, 0.25);
});

test('late probes, timer/probe races, reset-stamp jitter and restarting never double-count a cycle', () => {
  const initial = new RoutingCapacityAnalytics();
  observe(initial, RESET - 4 * MIN, 0.5);
  observe(initial, RESET - MIN, 0.75, { resetAt: RESET + 2000 });
  observe(initial, RESET - 3 * MIN, 0.25);
  const meter = new RoutingCapacityAnalytics();
  meter.restore(JSON.parse(JSON.stringify(initial.serialize())));
  meter.advance(RESET);
  observe(meter, RESET - MIN, 0.75, { resetAt: RESET + 2000 });  // late old stamp
  observe(meter, RESET + MIN, 0.01, { resetAt: RESET + WEEK });
  // Repeating the previous old reading must not replace the new open cycle.
  observe(meter, RESET - MIN, 0.75);
  meter.advance(RESET + 5 * MIN);
  const report = meter.snapshot(owner, RESET + 5 * MIN);
  assert.equal(report.cycles.length, 1);
  assert.equal(report.meanUnusedFraction, 0.25);
  assert.equal(report.cycles[0].observedAt, RESET - MIN);
  assert.equal(meter.serialize().owners[0][1].open.resetAt, RESET + WEEK);
});

test('positive traffic, another model\'s denial and incomplete worker coverage cannot prove avoidable waste', () => {
  for (const demand of [
    { arrivals: 2, peerArrivals: 0, capacityDenied: 1, completeCoverage: true },
    { arrivals: 0, peerArrivals: 1, completeCoverage: true },
    { arrivals: 0, peerArrivals: 0, peakOutstanding: 1, completeCoverage: true },  // held since last week
    { arrivals: 0, peerArrivals: 0, completeCoverage: false },
    {},
  ]) {
    const meter = new RoutingCapacityAnalytics({ demandBetween: () => demand });
    observe(meter, RESET - MIN, 0.25);
    meter.advance(RESET);
    assert.equal(firstCycle(meter).attribution, 'unattributed');
  }
});

test('feasible alternate placement is attributed once to its account/window and never called a weekly shortfall', () => {
  const meter = new RoutingCapacityAnalytics();
  observe(meter, RESET - 5 * MIN, 0.5);
  const proposal = { owner, window: 'wk', resetAt: RESET, at: RESET - 2 * MIN };
  for (const fields of [{ owner: 'wrong' }, { window: 'ses' }, { resetAt: RESET + WEEK }, { at: RESET }]) {
    meter.noteAlternative({ ...proposal, ...fields });
  }
  meter.noteAlternative(proposal);
  observe(meter, RESET - 2 * MIN, 0.5);
  meter.advance(RESET);
  meter.noteAlternative({ ...proposal, at: RESET - MIN });  // second lease finished after the reset
  assert.equal(firstCycle(meter).alternativeTurns, 2);
  assert.equal(firstCycle(meter).attribution, 'eligible-demand-served-elsewhere');
});

test('confirmed demand-free observations survive shorter-lived service history, corrupt or absent state starts safely', () => {
  const meter = new RoutingCapacityAnalytics({ demandBetween: emptyDemand });
  observe(meter, RESET - MIN, 0);
  meter.advance(RESET);
  const restored = new RoutingCapacityAnalytics();
  restored.restore(JSON.parse(JSON.stringify(meter.serialize())));
  assert.equal(firstCycle(restored, RESET + 6 * WEEK).attribution, 'no-observed-demand');
  for (const saved of [null, { version: 99 }, { version: 1, owners: [null, [owner, { cycles: [null, {}] }]] }]) {
    const blank = new RoutingCapacityAnalytics();
    blank.restore(saved);
    assert.deepEqual(blank.snapshot(owner, RESET).cycles, []);
  }
  restored.advance(RESET + 14 * WEEK);
  assert.equal(restored.serialize().owners.length, 0);
});

test('weekly-volume provisioning reports the actual observations and only returns 0 for completely covered idle history', () => {
  const intervals = [];
  const out = provisioningEvidence((from, to) => {
    intervals.push([from, to]);
    return emptyDemand();
  }, RESET + MIN, 2);
  assert.equal(out.measuredWeeklyCycles, 2);
  assert.deepEqual(intervals, [[RESET - WEEK, RESET], [RESET - 2 * WEEK, RESET - WEEK], [RESET - 3 * WEEK, RESET - 2 * WEEK]]);
  assert.deepEqual([out.status, out.low, out.high, out.coveredWeeks], ['no-observed-demand', 0, 0, 3]);
  for (const adjustment of [{ completeCoverage: false }, { arrivals: 1 }, { peerArrivals: 1 }, { peakOutstanding: 1 }]) {
    const partial = provisioningEvidence(() => ({ ...emptyDemand(), ...adjustment }), RESET);
    assert.equal(partial.status, 'insufficient-evidence');
    assert.equal(partial.low, null);
  }
  const busy = provisioningEvidence(() => ({ ...emptyDemand(), arrivals: 4, capacityDenied: 1 }), RESET, 7);
  assert.equal(busy.arrivals, 12);
  assert.equal(busy.capacityDenied, 3);
  assert.equal(busy.reason, 'unmeasured-weekly-shortfall-and-plan-yield');
});

test('a retiring worker contributes only its new turns, late meter readings and grant facts exactly once across restart', () => {
  const retiring = new RoutingCapacityAnalytics();
  const target = { owner, window: 'wk', resetAt: RESET, at: RESET - 2 * MIN };
  observe(retiring, RESET - 8 * MIN, 0.5);
  retiring.noteAlternative(target);  // belongs to both worker snapshots
  const baton = retiring.serialize();
  assert.equal(RoutingCapacityAnalytics.drainDelta(baton, baton), null);
  const current = new RoutingCapacityAnalytics();
  current.restore(baton);
  current.noteAlternative(target);
  current.advance(RESET);
  assert.equal(firstCycle(current).reason, 'stale-reading');

  observe(retiring, RESET - MIN, 0.75); // fresher observation despite later delivery
  retiring.noteAlternative(target);
  const delta = RoutingCapacityAnalytics.drainDelta(baton, retiring.serialize());
  assert.equal(delta.owners[0][1].length, 1);
  current.mergeDrain(delta, 'drain-one', RESET + MIN);
  assert.equal(firstCycle(current).unusedFraction, 0.25);
  assert.equal(firstCycle(current).alternativeTurns, 3);

  const restarted = new RoutingCapacityAnalytics();
  restarted.restore(current.serialize());
  restarted.mergeDrain(delta, 'drain-one', RESET + MIN);
  assert.equal(firstCycle(restarted).alternativeTurns, 3);

  const laterBaseline = retiring.serialize();
  retiring.markRefill(owner, RESET - 2 * MIN);
  const grantDelta = RoutingCapacityAnalytics.drainDelta(laterBaseline, retiring.serialize());
  restarted.mergeDrain(grantDelta, 'drain-two', RESET + MIN);
  assert.equal(firstCycle(restarted).reason, 'refill');
  assert.equal(firstCycle(restarted).unusedFraction, null);
  assert.equal(firstCycle(restarted).alternativeTurns, 3);
});

test('recovery of an old window cannot overwrite a newer live plan or manufacture duplicated closed rows', () => {
  const retiring = new RoutingCapacityAnalytics();
  observe(retiring, RESET - 10 * MIN, 0.5);
  const baton = retiring.serialize();
  const current = new RoutingCapacityAnalytics();
  current.restore(baton);
  observe(current, RESET - 2 * MIN, 0.75);
  observe(current, RESET + MIN, 0.05, { resetAt: RESET + WEEK });
  observe(retiring, RESET - 3 * MIN, 0.625);
  retiring.advance(RESET + 3 * MIN);
  current.mergeDrain(RoutingCapacityAnalytics.drainDelta(baton, retiring.serialize()), 'overlap', RESET + 5 * MIN);
  assert.equal(firstCycle(current, RESET + 5 * MIN).unusedFraction, 0.25);
  assert.equal(current.snapshot(owner, RESET + 5 * MIN).cycles.length, 1);
  assert.equal(current.serialize().owners[0][1].open.resetAt, RESET + WEEK);

  const other = new RoutingCapacityAnalytics();
  observe(other, RESET + 2 * MIN, 0.125, { window: 'ses', resetAt: RESET + 60 * MIN });
  current.mergeDrain(RoutingCapacityAnalytics.drainDelta(null, other.serialize()), 'conflicting', RESET + 5 * MIN);
  assert.equal(current.serialize().owners[0][1].open.resetAt, RESET + WEEK);
  const conflict = firstCycle(current, RESET + 5 * MIN);
  assert.equal(conflict.reason, 'conflicting-reset');
  assert.equal(conflict.unusedFraction, null);
});

test('refill and disable evidence survive a merge even when the active worker has a newer reading', () => {
  const retiring = new RoutingCapacityAnalytics();
  observe(retiring, RESET - 8 * MIN, 0.5);
  const baton = retiring.serialize();
  const current = new RoutingCapacityAnalytics();
  current.restore(baton);
  observe(current, RESET - MIN, 0.75);
  retiring.markUnavailable(owner);
  const delta = RoutingCapacityAnalytics.drainDelta(baton, retiring.serialize());
  current.mergeDrain(delta, 'disabled', RESET - MIN);
  const open = current.serialize().owners[0][1].open;
  assert.equal(open.disabled, true);
  assert.equal(open.observedAt, RESET - MIN);
  current.advance(RESET);
  assert.equal(firstCycle(current).reason, 'disabled');
});
