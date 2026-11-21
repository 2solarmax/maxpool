import assert from 'node:assert/strict';
import test from 'node:test';
import { __serverTest } from '../src/server.js';
import { CAPACITY_BANDS, LinkedMessageEnvelope, capacityDenial, capacityState, finishInference, noteMessageEvent, RoutingServiceAnalytics } from '../src/routing-service-analytics.js';

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

test('demand coverage begins at the first full retained hour and advances when that hour expires', () => {
  const retention = 35 * 24 * HOUR;
  let now = 50 * 24 * HOUR + HOUR / 2;
  const first = Math.floor(now / HOUR) * HOUR - retention + HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  const bucket = (hour, arrivals) => ({ hour, total: { arrivals, peakOutstanding: arrivals }, accounts: [] });
  ledger.restoreState({ version: 1, coverage: [[now - retention, now]],
    hours: [bucket(first - HOUR, 90), bucket(first, 3), bucket(first + HOUR, 2)] });

  const before = ledger.demandReader();
  assert.equal(before(first - 1, first + HOUR).completeCoverage, false);
  assert.equal(before(first, first + HOUR).completeCoverage, true);
  assert.equal(before(first - HOUR, first).arrivals, 0);
  assert.equal(before(first, first + HOUR).peakOutstanding, 3);

  now += HOUR;
  const after = ledger.demandReader();
  const crossing = after(first, first + 2 * HOUR);
  assert.equal(crossing.completeCoverage, false);
  assert.equal(crossing.arrivals, 2);
  assert.equal(crossing.peakOutstanding, 2);
  assert.equal(after(first + HOUR, first + 2 * HOUR).completeCoverage, true);
});

test('live capacity headline: idle, healthy and saturated workers are judged from held requests only', () => {
  let now = 100 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  assert.equal(ledger.recent().state, 'quiet');
  const finish = (n, wait = 0, outcome = 'completed', denial) => {
    for (let i = 0; i < n; i++) {
      const t = ledger.begin({ session: 's' + i });
      t.route('a');
      if (wait) { t.wait(); now += wait; t.resume(); t.route('a'); }
      t.finish(outcome, {}, denial);
    }
  };
  // Healthy: 200 requests, one held 2s.
  finish(199);
  finish(1, 2000);
  let r = ledger.recent();
  assert.deepEqual([r.requests, r.queuedRequests, r.pending, r.state], [200, 1, 0, 'ok']);
  // A forwarded hop is not a second arrival and never counts as pending.
  const peer = ledger.begin({ peer: true });
  peer.wait(); now += 60_000;
  assert.equal(ledger.recent().pending, 0);
  peer.resume();
  assert.equal(ledger.recent().pending, 0, 'not even between its wait segments');
  peer.finish('completed');
  assert.equal(ledger.recent().requests, 200);
  // A request waiting right now shows pending and oldest wait, counted once across retries.
  const held = ledger.begin({ session: 'held' });
  held.wait(); now += 6000;
  r = ledger.recent();
  assert.deepEqual([r.pending, r.oldestWaitMs, r.state], [1, 6000, 'tight']);
  now += 30_000;
  assert.equal(ledger.recent().state, 'short');
  held.resume(); held.wait(); now += 1000;
  held.finish('capacityDenied', {}, 'weeklyDenied');
  r = ledger.recent();
  assert.deepEqual([r.pending, r.refusedAfterWait, r.capacityDenied], [0, 1, 1]);
  // Saturated: a backlog of long waits crosses the short band; old minutes age out of the window.
  finish(30, 20_000);
  assert.equal(ledger.recent().state, 'short');
  for (let i = 0; i < 20; i++) { now += 60_000; ledger.observe(); }   // a running worker heartbeats
  assert.deepEqual([ledger.recent().requests, ledger.recent().state], [0, 'quiet']);
  assert.equal(ledger.recent(60 * 60_000).requests > 0, true);
  assert.doesNotMatch(JSON.stringify(ledger.exportState()), /refusedAfterWait|oldestWaitMs/, 'headline is not persisted');
});

test('headline needs 20 requests before a share can raise it; only a hold or a refusal counts at low volume', () => {
  let now = 100 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  // One 1 ms wait among five requests is 20% of a handful, not a shortage.
  for (let i = 0; i < 4; i++) { const t = ledger.begin({}); t.route('a'); t.finish('completed'); }
  const waited = ledger.begin({});
  waited.wait(); now += 1; waited.resume(); waited.route('a'); waited.finish('completed');
  let r = ledger.recent();
  assert.deepEqual([r.requests, r.queuedRequests, r.state], [5, 1, 'quiet']);
  // Nothing finished and one request held for 1 s: still too little to say anything.
  const fresh = new RoutingServiceAnalytics(() => now);
  const held = fresh.begin({});
  held.wait(); now += 1000;
  r = fresh.recent();
  assert.deepEqual([r.requests, r.pending, r.oldestWaitMs, r.state], [0, 1, 1000, 'quiet']);
  // A hold is direct evidence at any volume.
  now += CAPACITY_BANDS.tightOldestMs;
  assert.equal(fresh.recent().state, 'tight');
  now += CAPACITY_BANDS.shortOldestMs;
  assert.equal(fresh.recent().state, 'short');
  held.finish('cancelled');
  // So is a refusal.
  const refused = fresh.begin({});
  refused.finish('capacityDenied', {}, 'weeklyDenied');
  assert.deepEqual([fresh.recent().requests, fresh.recent().state], [2, 'tight']);
});

test('capacityState boundaries match the documented bands', () => {
  const base = { requests: 200, queuedRequests: 0, notableWaits: 0, capacityDenied: 0, pending: 0, oldestWaitMs: 0, queuedWaitP95Ms: null };
  const state = over => capacityState({ ...base, ...over });
  assert.equal(state({}), 'ok');
  // Waited share counts lasting waits only: tight at 2% and above, short at 10% and above, three at least.
  assert.equal(state({ notableWaits: 3 }), 'ok');
  assert.equal(state({ notableWaits: 4 }), 'tight');
  assert.equal(state({ notableWaits: 19 }), 'tight');
  assert.equal(state({ notableWaits: 20 }), 'short');
  // Waits at or below the floor never count, however many there are.
  assert.equal(state({ queuedRequests: 150, notableWaits: 0 }), 'ok');
  // Refused share: any refusal is tight, 5% and above is short (and needs the minimum volume + three lasting waits to count as a share).
  assert.equal(state({ capacityDenied: 1 }), 'tight');
  assert.equal(state({ capacityDenied: 9 }), 'tight');
  assert.equal(state({ capacityDenied: 10 }), 'tight', 'a refusal share alone is not three lasting waits');
  assert.equal(state({ capacityDenied: 10, notableWaits: 3 }), 'short');
  // A request held now: tight at 5 s and above, short at 30 s and above.
  assert.equal(state({ pending: 1, oldestWaitMs: 4999 }), 'ok');
  assert.equal(state({ pending: 1, oldestWaitMs: 5000 }), 'tight');
  assert.equal(state({ pending: 1, oldestWaitMs: 29_999 }), 'tight');
  assert.equal(state({ pending: 1, oldestWaitMs: 30_000 }), 'short');
  // p95 of waited requests: over 5 s only, and only with three lasting waits behind it.
  assert.equal(state({ notableWaits: 3, queuedWaitP95Ms: 5000 }), 'ok');
  assert.equal(state({ notableWaits: 3, queuedWaitP95Ms: 5001 }), 'tight');
  assert.equal(state({ notableWaits: 2, queuedWaitP95Ms: 60_000 }), 'ok');
  // The 20-request minimum: shares and p95 are ignored below it, a hold or refusal is not.
  assert.equal(state({ requests: 19 }), 'quiet');
  assert.equal(state({ requests: 20 }), 'ok');
  assert.equal(state({ requests: 19, notableWaits: 19, queuedWaitP95Ms: 60_000 }), 'quiet');
  assert.equal(state({ requests: 20, notableWaits: 3 }), 'short');
  assert.equal(state({ requests: 20, notableWaits: 2 }), 'ok', 'two lasting waits in 20 requests cannot decide the headline');
  assert.equal(state({ requests: 1, capacityDenied: 1 }), 'tight');
  assert.equal(state({ requests: 0, pending: 1, oldestWaitMs: 1000 }), 'quiet');
  assert.equal(state({ requests: 0, pending: 1, oldestWaitMs: 5000 }), 'tight');
  assert.equal(state({ requests: 0, pending: 1, oldestWaitMs: 30_000 }), 'short');
  assert.equal(capacityState(null), 'unknown');
});

test('trivial waits cannot decide the headline at low volume', () => {
  let now = 100 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  const waitedFor = ms => { const t = ledger.begin({}); t.route('a'); t.wait(); now += ms; t.resume(); t.route('a'); t.finish('completed'); };
  for (let i = 0; i < 17; i++) { const t = ledger.begin({}); t.route('a'); t.finish('completed'); }
  // Exactly 20 requests, one 1 ms wait: that is 5% of the share, and it must not read as tight.
  waitedFor(1);
  waitedFor(250);
  waitedFor(250);
  let r = ledger.recent();
  assert.deepEqual([r.requests, r.queuedRequests, r.notableWaits, r.state], [20, 3, 0, 'ok']);
  // Waits over the floor count, but two of them in twenty requests still do not.
  const more = new RoutingServiceAnalytics(() => now);
  const after = ms => { const t = more.begin({}); t.route('a'); t.wait(); now += ms; t.resume(); t.route('a'); t.finish('completed'); };
  for (let i = 0; i < 18; i++) { const t = more.begin({}); t.route('a'); t.finish('completed'); }
  after(251);
  after(900);
  r = more.recent();
  assert.deepEqual([r.requests, r.notableWaits, r.state], [20, 2, 'ok']);
  // A third lasting wait is a pattern: 3 of 21 is 14%, short.
  after(300);
  r = more.recent();
  assert.deepEqual([r.requests, r.notableWaits, r.state], [21, 3, 'short']);
});

test('a hold keeps its first wait across the retry segments of the sticky-busy loop', () => {
  let now = 100 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  const held = ledger.begin({ session: 'held' });
  // wait → resume → bounce → wait, as the sticky-busy loop does: 1 s, 2 s, then 4 s segments.
  held.route('a');
  held.wait(); now += 1000; held.resume();
  assert.equal(ledger.recent().pending, 1, 'still held between a resume and the next lease');
  held.route('a'); now += 100;
  held.wait(); now += 2000; held.resume(); held.route('a'); now += 100;
  held.wait(); now += 1000;
  let r = ledger.recent();
  assert.deepEqual([r.pending, r.oldestWaitMs, r.state], [1, 4200, 'quiet']);
  now += 1000;
  r = ledger.recent();
  assert.deepEqual([r.pending, r.oldestWaitMs, r.state], [1, 5200, 'tight'], 'a hold of 5 s across segments shows as held');
  held.resume(); held.route('a');
  assert.equal(ledger.recent().pending, 0, 'served: not held any more');
  held.finish('completed');
  const done = ledger.recent();
  assert.deepEqual([done.pending, done.requests, done.queuedRequests, done.longestWaitMs], [0, 1, 1, 5000]);
  // A request served for a minute and then held again is a new hold, not one 60 s old.
  const again = ledger.begin({});
  again.route('a'); again.wait(); now += 1000; again.resume(); again.route('a');
  now += 60_000; ledger.observe();
  again.wait(); now += 2000;
  assert.deepEqual([ledger.recent().pending, ledger.recent().oldestWaitMs], [1, 2000]);
  again.finish('cancelled');
});

test('after a heartbeat gap the recent window starts empty and says so', () => {
  let now = 100 * HOUR;
  const ledger = new RoutingServiceAnalytics(() => now);
  for (let i = 0; i < 5; i++) { const t = ledger.begin({}); t.route('a'); t.finish('capacityDenied', {}, 'weeklyDenied'); }
  assert.equal(ledger.recent().capacityDenied, 5);
  // The laptop slept for ten minutes: the ledger saw none of it, so older counts must not read as "last 15 minutes".
  now += 10 * 60_000;
  const r = ledger.recent();
  assert.deepEqual([r.requests, r.capacityDenied, r.observedMs], [0, 0, 0]);
  const t = ledger.begin({}); t.route('a'); t.finish('completed');
  now += 60_000;
  assert.deepEqual([ledger.recent().requests, ledger.recent().observedMs], [1, 60_000]);
});

test('the recent window keeps the minute holding its cutoff and reports how much it has actually watched', () => {
  const start = 100 * HOUR;
  let now = start;
  const ledger = new RoutingServiceAnalytics(() => now);
  now = start + 45_000;                    // inside the first minute
  const early = ledger.begin({});
  early.route('a'); early.finish('capacityDenied', {}, 'weeklyDenied');
  // 14m30s later the refusal is 14m30s old and must still count in a 15-minute window. Heartbeat
  // every minute so the ledger keeps watching continuously, as a running worker does.
  for (let i = 0; i < 14; i++) { now += 60_000; ledger.observe(); }
  now += 30_000;
  assert.equal(ledger.recent().capacityDenied, 1);
  assert.equal(ledger.recent().observedMs, 15 * 60_000);
  // Past 15 minutes plus the rest of its minute, the refusal ages out.
  now += 45_000; ledger.observe();
  now += 45_001;
  assert.equal(ledger.recent().capacityDenied, 0);
  // Just after a restart the window says how little it has seen.
  const restarted = new RoutingServiceAnalytics(() => now);
  now += 2 * 60_000;
  const r = restarted.recent();
  assert.deepEqual([r.windowMs, r.observedMs], [15 * 60_000, 2 * 60_000]);
});
