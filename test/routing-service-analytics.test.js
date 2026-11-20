import assert from 'node:assert/strict';
import test from 'node:test';
import { __serverTest } from '../src/server.js';
import { LinkedMessageEnvelope, capacityDenial, finishInference, noteMessageEvent, RoutingServiceAnalytics } from '../src/routing-service-analytics.js';

const HOUR = 3_600_000;

test('origin demand, queued time and parallel sessions are counted once across retries and peer hops', () => {
  let now = 10 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  const first = ledger.begin({ session: 'private-thread' });
  const sibling = ledger.begin({ session: 'private-thread' });
  const peer = ledger.begin({ peer: true, session: 'private-peer' });
  first.route('owner-a');
  sibling.route('owner-b');
  peer.route('owner-a');
  assert.equal(ledger.snapshot().serving, 2);
  assert.equal(ledger.snapshot().activeSessions, 1);
  first.wait();
  now += 6000;
  first.resume();
  now += 3000;
  first.route('owner-b');
  first.finish('completed', { _capacityInput: 15, _capacityCacheRead: 5, _capacityCacheCreation: 2 });
  first.finish('completed');
  peer.finish('completed');
  sibling.finish('cancelled');
  const summary = ledger.snapshot();
  assert.deepEqual([summary.arrivals, summary.peerArrivals, summary.requests, summary.completed, summary.timelyCompleted,
    summary.cancelled, summary.active, summary.activeSessions, summary.serving, summary.peakSessions, summary.peakServing,
    summary.queuedRequests, summary.waitP90Ms, summary.waitP95Ms, summary.inputTokens, summary.cachedInputTokens],
  [2, 1, 2, 1, 0, 1, 0, 0, 0, 1, 2, 1, 6000, 6000, 22, 5]);
  const holder = summary.accounts.find(row => row.name === 'owner-a');
  assert.deepEqual([holder.completed, holder.peakServing], [1, 2]);
  assert.doesNotMatch(JSON.stringify(ledger.exportState()), /private-thread|private-peer/);
});

test('unobserved hours, sleeping workers, open requests, and resumed handoffs retain honest coverage', () => {
  let now = 50 * HOUR;
  const origin = new RoutingServiceAnalytics(() => now);
  const start = now;
  now += 60_000;
  assert.deepEqual([origin.demandBetween(start, now).completeCoverage, origin.demandBetween(start, now).peakOutstanding], [true, 0]);
  now += HOUR;
  assert.equal(origin.demandBetween(start, now).completeCoverage, false);
  const trace = origin.begin();
  trace.route('a');
  const baseline = origin.exportState();
  now += 1000;
  const next = new RoutingServiceAnalytics(() => now);
  next.restoreState(baseline);
  next.restoreState(baseline);
  assert.equal(next.snapshot().arrivals, 1);
  assert.equal(next.snapshot().active, 0);
  const live = next.begin();
  live.route('a');
  live.finish('incomplete');
  now += 1000;
  trace.finish('completed');
  next.mergeDrain(baseline, origin.exportState());
  const summary = next.snapshot();
  assert.deepEqual([summary.arrivals, summary.requests, summary.completed, summary.incomplete, summary.active], [2, 2, 1, 1, 0]);
  assert.equal(next.demandBetween(start, now).completeCoverage, false);
  assert.equal(next.demandBetween(now - 1000, now).peakOutstanding, 1);
  assert.equal(next.demandBetween(now, now + 1).completeCoverage, false);
  now += 40 * 24 * HOUR;
  assert.equal(next.snapshot().requests, 0);
});

test('an HTTP 200 heartbeat, a missing terminal, token exhaustion, error frames and cancellation have distinct outcomes', () => {
  const ledger = new RoutingServiceAnalytics(() => HOUR);
  function run(events, status, cancelled = false, denied = false) {
    const trace = ledger.begin();
    trace.denied = denied;
    trace.usage = null;
    for (const event of events) noteMessageEvent({ _service: trace }, event);
    finishInference(trace, status, cancelled);
  }
  run([{ type: 'message_stop' }], 200);
  run([{ type: 'message_delta', delta: { stop_reason: 'max_tokens' } }, { type: 'message_stop' }], 200);
  run([], 200);
  run([{ type: 'error' }], 200);
  run([], 429, false, true);
  run([], 429, true, true);
  const summary = ledger.snapshot();
  assert.deepEqual([summary.requests, summary.completed, summary.timelyCompleted, summary.incomplete, summary.failed,
    summary.capacityDenied, summary.cancelled, summary.waitP95Ms], [6, 1, 1, 2, 2, 1, 1, 0]);
});

test('a nonserving worker and a gap between writer leases cannot attest idle capacity', () => {
  let now = 10 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  ledger.setServing(false);
  const boot = now;
  now += 20_000;
  ledger.snapshot();
  ledger.setServing(true);
  const accepting = now;
  now += 1000;
  assert.equal(ledger.demandBetween(boot, now).completeCoverage, false);
  assert.equal(ledger.demandBetween(accepting, now).completeCoverage, true);
  ledger.setServing(false);
  now += 1500;
  assert.equal(ledger.demandBetween(accepting, now).completeCoverage, false);
});

test('large linked JSON responses retain outcome evidence across chunks and ignore fake fields inside content', () => {
  const content = [{ type: 'text', text: 'nested ' + JSON.stringify({ type: 'message', stop_reason: 'max_tokens' })
    + 'x'.repeat(128 * 1024) + '\"' }];
  const payload = Buffer.from(JSON.stringify({ type: 'message', content, stop_reason: 'end_turn' }));
  const seen = new LinkedMessageEnvelope();
  const info = { stream: false, _service: {} };
  for (let pos = 0; pos < payload.length; pos += 19) {
    const part = payload.subarray(pos, pos + 19);
    seen.push(part);
    __serverTest.tapLinkUsage(part, info);
  }
  __serverTest.tapLinkUsage(null, info);
  assert.equal(info._service.terminal, 'completed');
  assert.deepEqual(seen.message(), { type: 'message', stop_reason: 'end_turn' });
  assert.doesNotMatch(JSON.stringify(seen), /xxxxx/);
  const missing = new LinkedMessageEnvelope();
  missing.push(payload.subarray(0, -1));
  assert.equal(missing.message(), null);
});

test('linked JSON ignores escaped delimiters across every possible fetch chunk boundary', () => {
  const content = [{ type: 'text', text: ['\\', '\\\\', '"', '\\"', '\\\\"', '🌊', '"},"stop_reason":"end_turn"'].join('') }];
  const body = new TextEncoder().encode(JSON.stringify({ content, type: 'message', stop_reason: 'max_tokens' }));
  const expected = { type: 'message', stop_reason: 'max_tokens' };
  for (let split = 0; split <= body.length; split++) {
    const seen = new LinkedMessageEnvelope();
    seen.push(body.subarray(0, split));
    seen.push(body.subarray(split));
    assert.deepEqual(seen.message(), expected, `split at byte ${split}`);
  }
  const seen = new LinkedMessageEnvelope();
  for (let i = 0; i < body.length; i++) seen.push(body.subarray(i, i + 1));
  assert.deepEqual(seen.message(), expected);
});

test('handoff delta only contains changed hours and repeated baseline export remains stable', () => {
  let now = 12 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  ledger.begin().finish('completed');
  now += HOUR;
  ledger.observe();
  const before = ledger.exportState();
  assert.equal(RoutingServiceAnalytics.drainDelta(before, ledger.exportState()), null);
  ledger.begin().finish('failed');
  const after = ledger.exportState();
  assert.equal(before.hours[0], after.hours[0]);
  const delta = RoutingServiceAnalytics.drainDelta(before, after);
  assert.deepEqual(delta.after.hours.map(row => row.hour), [now]);
  const next = new RoutingServiceAnalytics(() => now);
  next.restoreState(JSON.parse(JSON.stringify(before)));
  next.mergeDrain(delta.before, delta.after);
  assert.equal(next.snapshot().requests, 2);
});

test('mixed route blockers cannot be attributed to the first quota that will recover', () => {
  assert.equal(capacityDenial({ cause: 'weekly_exhausted', matchingRoutes: 2, reasons: { weekly_exhausted: 2 } }), 'weeklyDenied');
  assert.equal(capacityDenial({ cause: 'weekly_exhausted', matchingRoutes: 2, reasons: { weekly_exhausted: 1, error: 1 } }), 'unclassifiedDenied');
  assert.equal(capacityDenial({ cause: 'weekly_reset_unknown' }), 'unclassifiedDenied');
  assert.equal(capacityDenial({ cause: 'concurrency_cap', matchingRoutes: 1, reasons: { concurrency_cap: 1 } }), 'concurrencyDenied');
  assert.equal(capacityDenial({ cause: 'session_limit', matchingRoutes: 1, reasons: { session_limit: 1 } }), 'sessionDenied');
  assert.equal(capacityDenial({ cause: 'no_eligible_route' }), null);
});

test('reused demand summaries keep exact uptime bounds and separate partial, disjoint and empty windows', () => {
  const now = 72 * HOUR + 10, from = now - 2 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  ledger.restoreState({ version: 1, coverage: [[from + 5, now]], hours: [1, 2, 3].map((n, i) => ({
    hour: (70 + i) * HOUR, total: { arrivals: n, peakOutstanding: 4 - n }, accounts: [],
  })) });
  const demand = ledger.demandReader();
  assert.equal(demand(from, now).completeCoverage, false);
  assert.equal(demand(from + 5, now).completeCoverage, true);
  assert.deepEqual([demand(from, now).arrivals, demand(from, now).peakOutstanding], [6, 3]);
  assert.deepEqual([demand(71 * HOUR, 72 * HOUR).arrivals, demand(72 * HOUR, now).arrivals], [2, 3]);
  assert.equal(demand(from - 8 * HOUR, from - 4 * HOUR).arrivals, 0);
  assert.equal(demand(now, now).arrivals, 0);
});
