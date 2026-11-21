import { InvalidCapacityDrain } from './capacity-drain.js';

// Worker-originated inference demand. Peer hops only count as inbound demand for
// capacity attribution; adding them to client outcomes would count a forwarded turn twice.
const HOUR = 3_600_000;
const RETENTION = 35 * 24 * HOUR;
const HEARTBEAT_GAP = 3 * 60_000;
const WAIT_TARGET = 5000;
const WAIT_BOUNDS = [0, 10, 50, 100, 250, 500, 1000, 2000, WAIT_TARGET, 10_000, 30_000, 60_000,
  120_000, 300_000, 900_000, 1_800_000, 3_600_000, 86_400_000];
const COUNTERS = ['arrivals', 'peerArrivals', 'requests', 'completed', 'timelyCompleted', 'failed', 'cancelled',
  'incomplete', 'capacityDenied', 'weeklyDenied', 'sessionDenied', 'concurrencyDenied', 'unclassifiedDenied', 'queuedRequests', 'inputTokens', 'cachedInputTokens'];
const DEMAND_COUNTERS = ['arrivals', 'peerArrivals', 'capacityDenied', 'weeklyDenied', 'sessionDenied', 'concurrencyDenied',
  'unclassifiedDenied', 'requests', 'completed', 'failed', 'cancelled', 'incomplete'];
const PEAKS = ['peakOutstanding', 'peakServing', 'peakSessions', 'longestWaitMs'];
const MINUTE = 60_000;
const RECENT_KEEP = 60;
const RECENT_WINDOW = 15 * MINUTE;
// A bounce back into a wait within this long of a lease is the same hold; a request that was served
// for longer and waits again is a new hold.
const HOLD_CONTINUITY_MS = 10_000;
// Provisional bands. Measured healthy traffic (20 hours, 46,281 requests): 0.1% waited at all, never
// above 0.8% in an hour, 99.97% within the five-second target. No saturated sample exists yet, so
// the 2% and 10% bands are placeholders until a real backlog is observed. A wait of 250 ms or less
// is balancing, not pressure: only lasting waits feed the shares, and at least three of them.
export const CAPACITY_BANDS = { minRequests: 20, minWaited: 3, notableWaitMs: 250, tightWaitedShare: 0.02, shortWaitedShare: 0.10,
  tightOldestMs: WAIT_TARGET, tightQueuedP95Ms: WAIT_TARGET, shortOldestMs: 30_000, shortDeniedShare: 0.05 };
// Histogram bins holding waits at or below the notable floor.
const TRIVIAL_WAIT_BINS = WAIT_BOUNDS.findIndex(max => max >= CAPACITY_BANDS.notableWaitMs) + 1;
const hourOf = t => Math.floor(t / HOUR) * HOUR;
const minuteOf = t => Math.floor(t / MINUTE) * MINUTE;
const count = n => Number.isSafeInteger(n) && n >= 0 ? n : 0;

function empty() {
  return { ...Object.fromEntries([...COUNTERS, ...PEAKS].map(key => [key, 0])), waits: Array(WAIT_BOUNDS.length + 1).fill(0) };
}

const STORED_FIELDS = [...COUNTERS, ...PEAKS];

// Positional rows avoid repeating metric names for every account-hour. The
// sparse tail stores only nonzero histogram cells as (index, frequency) pairs.
function pack(stats) {
  const row = STORED_FIELDS.map(key => stats[key]);
  stats.waits.forEach((n, i) => { if (n) row.push(i, n); });
  return row;
}

function unpack(row) {
  if (!Array.isArray(row)) return row;
  const stats = empty();
  for (const [i, key] of STORED_FIELDS.entries()) stats[key] = count(row[i]);
  for (let i = STORED_FIELDS.length; i + 1 < row.length; i += 2) {
    const bin = row[i];
    if (Number.isInteger(bin) && bin >= 0 && bin < stats.waits.length) stats.waits[bin] = count(row[i + 1]);
  }
  return stats;
}

function combine(target, source, baseline) {
  if (!source) return;
  for (const key of COUNTERS) target[key] += Math.max(0, count(source[key]) - count(baseline?.[key]));
  for (const key of PEAKS) target[key] = Math.max(target[key], count(source[key]));
  for (let i = 0; i < target.waits.length; i++) {
    target.waits[i] += Math.max(0, count(source.waits?.[i]) - count(baseline?.waits?.[i]));
  }
}

function summarize(stats) {
  const { waits, longestWaitMs, ...result } = stats;
  function quantile(p, queuedOnly = false) {
    let rank = Math.ceil((queuedOnly ? stats.queuedRequests : stats.requests) * p);
    if (!rank) return null;
    // Every unqueued request has a zero wait. Removing precisely those zeroes
    // yields the conditional histogram without storing a second copy.
    if (queuedOnly) rank += stats.requests - stats.queuedRequests;
    const index = waits.findIndex(n => (rank -= n) <= 0);
    return Math.min(WAIT_BOUNDS[index] ?? longestWaitMs, longestWaitMs);
  }
  // Waits at or below the floor are balancing, not pressure: the share headline counts only the
  // lasting ones, so one 1 ms wait cannot call a low-volume window tight.
  let notable = 0;
  for (let i = TRIVIAL_WAIT_BINS; i < waits.length; i++) notable += waits[i];
  return { ...result, notableWaits: notable, waitP90Ms: quantile(0.90), waitP95Ms: quantile(0.95), queuedWaitP95Ms: quantile(0.95, true) };
}

function accountStats(bucket, name) {
  if (!name) return null;
  if (!bucket.accounts.has(name)) bucket.accounts.set(name, empty());
  return bucket.accounts.get(name);
}

function union(intervals, oldest, latest) {
  const result = [];
  for (const interval of intervals.filter(v => Array.isArray(v) && v.length === 2 && v.every(Number.isSafeInteger))
    .sort((a, b) => a[0] - b[0])) {
    const from = Math.max(oldest, interval[0]), to = Math.min(latest, interval[1]);
    if (to < from) continue;
    const last = result.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else result.push([from, to]);
  }
  return result.slice(-2048);
}

export class RoutingServiceAnalytics {
  constructor(now = Date.now) {
    this.now = now;
    this.hours = new Map();
    this.appliedDrains = new Set();
    this.coverage = [];
    this.observing = true;
    this.started = now();
    this.lastObserved = this.started;
    this.active = 0;
    this.activePeer = 0;
    this.serving = 0;
    this.sessions = new Map();
    this.servingAccounts = new Map();
    this.latestHour = -1;
    // Process-lifetime only: the headline answers "now", and a restart is a new answer.
    this.waiters = new Map();
    this.recentMinutes = new Map();
  }

  setServing(serving, now = this.now()) {
    if (serving === this.observing) return;
    if (serving) this.started = this.lastObserved = now;
    else {
      this.observe(now);
      this.coverage = this._intervals(now);
    }
    this.observing = serving;
  }

  observe(now = this.now()) {
    // Periodic state saves and dashboard observations act as heartbeats. A sleep,
    // outage or unobserved handoff leaves an explicit hole in demand coverage.
    if (this.observing && (now < this.lastObserved || now - this.lastObserved > HEARTBEAT_GAP)) {
      this.coverage = union([...this.coverage, [this.started, this.lastObserved]], now - RETENTION, now);
      this.started = now;
      // The live headline counts minutes the worker did NOT watch: after a heartbeat gap the
      // short window restarts empty, so its figures are honestly only what was seen since.
      // (Held requests stay pending — a wait that spans the gap is still a wait.)
      this.recentMinutes.clear();
    }
    if (this.observing) this.lastObserved = now;
    const hour = hourOf(now);
    if (hour !== this.latestHour) {
      for (const h of this.hours.keys()) if (h <= hour - RETENTION) this.hours.delete(h);
      this.latestHour = hour;
    }
    if (!this.hours.has(hour)) this.hours.set(hour, { total: empty(), accounts: new Map() });
    const bucket = this.hours.get(hour);
    bucket.saved = null;
    bucket.total.peakOutstanding = Math.max(bucket.total.peakOutstanding, this.active + this.activePeer);
    bucket.total.peakServing = Math.max(bucket.total.peakServing, this.serving);
    bucket.total.peakSessions = Math.max(bucket.total.peakSessions, this.sessions.size);
    return bucket;
  }

  auxiliary() {
    this.activePeer++;
    this.observe();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.observe();
      this.activePeer--;
    };
  }

  begin({ peer = false, session = null } = {}) {
    const arrived = this.observe();
    if (peer) { arrived.total.peerArrivals++; this.activePeer++; }
    else { arrived.total.arrivals++; this.active++; }
    arrived.total.peakOutstanding = Math.max(arrived.total.peakOutstanding, this.active + this.activePeer);
    let account = null, serving = false, waitingSince = null, waitMs = 0, waited = false, ended = false, firstWaitAt = null, routedAt = null;
    const waiterKey = {};
    const leave = () => {
      if (!serving) return;
      serving = false;
      if (!peer) this.serving--;
      const decrement = (map, key) => {
        const n = map.get(key) - 1;
        if (n) map.set(key, n);
        else map.delete(key);
      };
      decrement(this.servingAccounts, account);
      if (!peer && session) decrement(this.sessions, session);
    };
    const stopWait = now => {
      if (waitingSince !== null) waitMs += Math.max(0, now - waitingSince);
      waitingSince = null;
      // Pending keeps the FIRST wait of the still-open request: the sticky-busy loop is
      // wait → resume → bounce → wait, and the router has held this request since the
      // first wait even through the retry gaps between segments.
      if (firstWaitAt !== null && !peer) this.waiters.set(waiterKey, firstWaitAt);
      else this.waiters.delete(waiterKey);
    };
    const endWaiter = () => {
      firstWaitAt = null;
      this.waiters.delete(waiterKey);
    };
    return {
      refusedOn: name => {
        // A holder can decline a verified pin before a lease exists. Attribute the
        // terminal refusal without counting a request or session as in service.
        if (!ended && !serving) account = name;
      },
      route: name => {
        if (ended || !name) return;
        const now = this.now();
        stopWait(now);
        // A lease is acquired: the router is not holding this request now. firstWaitAt stays,
        // so if the attempt bounces straight back into a wait the original hold clock resumes.
        this.waiters.delete(waiterKey);
        routedAt = now;
        leave();
        account = name;
        serving = true;
        if (!peer) this.serving++;
        this.servingAccounts.set(name, (this.servingAccounts.get(name) || 0) + 1);
        if (!peer && session) this.sessions.set(session, (this.sessions.get(session) || 0) + 1);
        const bucket = this.observe(now);
        const stats = accountStats(bucket, name);
        stats.peakServing = Math.max(stats.peakServing, this.servingAccounts.get(name));
      },
      wait: () => {
        if (ended || waitingSince !== null) return;
        leave();
        waited = true;
        waitingSince = this.now();
        if (firstWaitAt !== null && routedAt !== null && waitingSince - routedAt > HOLD_CONTINUITY_MS) firstWaitAt = null;
        firstWaitAt ??= waitingSince;
        if (!peer) this.waiters.set(waiterKey, firstWaitAt);
      },
      resume: () => stopWait(this.now()),
      finish: (outcome, usage = {}, denial) => {
        if (ended) return;
        ended = true;
        const now = this.now();
        const bucket = this.observe(now);
        stopWait(now);
        endWaiter();
        leave();
        if (peer) this.activePeer--;
        else this.active--;
        const cached = count(usage?._capacityCacheRead);
        const input = cached + count(usage?._capacityInput) + count(usage?._capacityCacheCreation);
        const index = WAIT_BOUNDS.findIndex(max => waitMs <= max);
        const waitBin = index < 0 ? WAIT_BOUNDS.length : index;
        const recent = peer ? null : this._minute(now);
        if (recent && waited && outcome === 'capacityDenied') recent.refusedAfterWait++;
        for (const stats of [peer ? null : bucket.total, accountStats(bucket, account), recent]) {
          if (!stats) continue;
          stats.requests++;
          if (outcome === 'completed') {
            stats.completed++;
            if (waitMs <= WAIT_TARGET) stats.timelyCompleted++;
          } else if (outcome === 'cancelled' || outcome === 'incomplete') stats[outcome]++;
          else {
            stats.failed++;
            if (outcome === 'capacityDenied') {
              stats.capacityDenied++;
              const key = ['weeklyDenied', 'sessionDenied', 'concurrencyDenied'].includes(denial) ? denial : 'unclassifiedDenied';
              stats[key]++;
            }
          }
          stats.cachedInputTokens += cached;
          stats.inputTokens += input;
          if (waited) stats.queuedRequests++;
          stats.waits[waitBin]++;
          stats.longestWaitMs = Math.max(stats.longestWaitMs, waitMs);
        }
      },
    };
  }

  _minute(now) {
    const minute = minuteOf(now);
    for (const m of this.recentMinutes.keys()) if (m <= minute - RECENT_KEEP * MINUTE) this.recentMinutes.delete(m);
    if (!this.recentMinutes.has(minute)) this.recentMinutes.set(minute, { ...empty(), refusedAfterWait: 0 });
    return this.recentMinutes.get(minute);
  }

  // Short-window view for the live headline. It counts only requests that originated here, so a
  // forwarded hop is never a second arrival, and `pending` is requests held by the router right now.
  recent(windowMs = RECENT_WINDOW, now = this.now()) {
    this.observe(now);
    const total = empty();
    let refusedAfterWait = 0;
    // Whole minutes only: the minute holding the cutoff is kept, so nothing from the last windowMs is
    // dropped and the oldest figures can be up to a minute older than the label.
    const from = minuteOf(now - windowMs);
    for (const [minute, row] of this.recentMinutes) {
      if (minute < from || minute > now) continue;
      combine(total, row);
      refusedAfterWait += row.refusedAfterWait;
    }
    const waiting = [...this.waiters.values()];
    const oldestWaitMs = waiting.length ? Math.max(0, now - Math.min(...waiting)) : 0;
    const summary = summarize(total);
    const result = { ...summary, longestWaitMs: total.longestWaitMs, refusedAfterWait, pending: waiting.length, oldestWaitMs, windowMs,
      observedMs: Math.max(0, Math.min(windowMs, now - this.started)) };
    return { ...result, state: capacityState(result) };
  }

  snapshot(windowMs = 24 * HOUR, now = this.now(), summarizeHour = summarize) {
    this.observe(now);
    const total = empty(), accounts = new Map(), timeline = [];
    const from = hourOf(now - Math.min(RETENTION, Math.max(1, windowMs)) + 1);
    for (const [hour, bucket] of this.hours) {
      if (hour < from || hour > now) continue;
      combine(total, bucket.total);
      for (const [name, row] of bucket.accounts) {
        if (!accounts.has(name)) accounts.set(name, empty());
        combine(accounts.get(name), row);
      }
      if (summarizeHour) timeline.push({ hour, ...summarizeHour(bucket.total) });
    }
    const completeCoverage = this._intervals(now).some(([start, end]) => start <= from && end >= now);
    return { ...summarize(total), completeCoverage, active: this.active, serving: this.serving, activeSessions: this.sessions.size,
      waitTargetMs: WAIT_TARGET, coverageSince: this._intervals(now)[0]?.[0] ?? null, from, to: now,
      accounts: [...accounts].map(([name, row]) => ({ name, ...summarize(row), serving: this.servingAccounts.get(name) || 0 })),
      timeline: timeline.sort((a, b) => a.hour - b.hour) };
  }

  demandBetween(from, to) {
    return this.demandReader()(from, to);
  }

  // One report checks overlapping windows from many accounts. Build cumulative
  // totals once, then subtract at the two hour boundaries. Peaks are maxima,
  // and uptime coverage uses the exact requested timestamps.
  demandReader(now = this.now()) {
    this.observe(now);
    const coverage = this._intervals(now);
    const last = hourOf(now), retained = last - RETENTION + HOUR;
    const first = Math.max(retained, Math.min(...this.hours.keys()));
    const hours = (last - first) / HOUR + 1;
    const sums = DEMAND_COUNTERS.map(() => new Float64Array(hours + 1));
    const peaks = new Float64Array(hours);
    for (let i = 0; i < hours; i++) {
      const row = this.hours.get(first + i * HOUR)?.total;
      for (let k = 0; k < DEMAND_COUNTERS.length; k++) sums[k][i + 1] = sums[k][i] + (row?.[DEMAND_COUNTERS[k]] || 0);
      peaks[i] = row?.peakOutstanding || 0;
    }
    return (from, to) => {
      const valid = Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from;
      const begin = valid ? Math.max(0, Math.min(hours, (hourOf(from) - first) / HOUR)) : 0;
      const end = valid ? Math.max(begin, Math.min(hours, (hourOf(to - 1) - first) / HOUR + 1)) : 0;
      const result = {};
      for (let k = 0; k < DEMAND_COUNTERS.length; k++) result[DEMAND_COUNTERS[k]] = sums[k][end] - sums[k][begin];
      let peakOutstanding = 0;
      for (let i = begin; i < end; i++) peakOutstanding = Math.max(peakOutstanding, peaks[i]);
      const completeCoverage = valid && from >= retained && coverage.some(([start, stop]) => start <= from && stop >= to);
      return { ...result, peakOutstanding, completeCoverage };
    };
  }

  _intervals(now) {
    const intervals = this.observing ? [...this.coverage, [this.started, this.lastObserved]] : this.coverage;
    return union(intervals, now - RETENTION, now);
  }

  exportState() {
    const now = this.now();
    this.observe(now);
    const hours = [];
    for (const [hour, bucket] of this.hours) {
      bucket.saved ??= { hour, total: pack(bucket.total), accounts: [...bucket.accounts].map(([name, row]) => [name, pack(row)]) };
      hours.push(bucket.saved);
    }
    return { version: 1, coverage: this._intervals(now), hours,
      ...(this.appliedDrains.size ? { appliedDrains: [...this.appliedDrains] } : {}) };
  }

  static drainDelta(before, after) {
    if (after?.version !== 1) return null;
    const old = new Map((before?.hours || []).map(row => [row.hour, row]));
    const prior = [], changed = [];
    for (const row of after.hours) {
      const baseline = old.get(row.hour);
      if (row === baseline || (baseline && JSON.stringify(row) === JSON.stringify(baseline))) continue;
      changed.push(row);
      if (baseline) prior.push(baseline);
    }
    const coverage = (after.coverage || []).filter(([start, end]) =>
      !(before?.coverage || []).some(([from, to]) => start >= from && end <= to));
    if (!changed.length && !coverage.length) return null;
    return { before: { version: 1, hours: prior }, after: { version: 1, hours: changed, coverage } };
  }

  // Save each consumed ID with its counters, even if a later store needs a retry.
  // Only increments after its takeover baseline move between workers. Gauges
  // and session IDs are ephemeral; history retains observed concurrent peaks.
  mergeDrain(baseline, final, id) {
    if (id && this.appliedDrains.has(id)) return;
    if (final?.version !== 1 || !Array.isArray(final.hours)
      || (final.coverage != null && (!Array.isArray(final.coverage) || !final.coverage.every(interval =>
        Array.isArray(interval) && interval.length === 2 && interval.every(Number.isSafeInteger) && interval[1] >= interval[0])))
      || (baseline && !Array.isArray(baseline.hours))) {
      if (id) throw new InvalidCapacityDrain('Invalid routing service drain');
      return;
    }
    const now = this.now();
    const firstHour = hourOf(now) - RETENTION + HOUR;
    const before = new Map();
    for (const row of baseline?.hours || []) {
      if (!row || !Number.isSafeInteger(row.hour)
        || (row.accounts != null && (!Array.isArray(row.accounts) || !row.accounts.every(Array.isArray)))) {
        throw new InvalidCapacityDrain('Invalid routing service baseline');
      }
      before.set(row.hour, row);
    }
    const updates = new Map();
    for (const row of final.hours) {
      if (!row || !Number.isSafeInteger(row.hour) || row.hour % HOUR) throw new InvalidCapacityDrain('Invalid routing service hour');
      if (row.hour < firstHour || row.hour > now) continue;
      if (updates.has(row.hour)) throw new InvalidCapacityDrain('Duplicate routing service hour');
      if (!row.total || typeof row.total !== 'object' || !Array.isArray(row.accounts)) throw new InvalidCapacityDrain('Invalid routing service counters');
      const old = before.get(row.hour);
      const existing = this.hours.get(row.hour);
      // Only copy the affected hour's totals and account rows. Live request
      // traces retain their own gauges and obtain the current hour on finish.
      const bucket = { total: existing ? structuredClone(existing.total) : empty(), accounts: new Map(existing?.accounts) };
      combine(bucket.total, unpack(row.total), unpack(old?.total));
      const oldAccounts = new Map(old?.accounts || []);
      for (const item of row.accounts || []) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[1] || typeof item[1] !== 'object') {
          throw new InvalidCapacityDrain('Invalid routing service account counters');
        }
        if (!item[0] || item[0].length > 256) continue;
        const stats = existing?.accounts.get(item[0]);
        const merged = stats ? structuredClone(stats) : empty();
        combine(merged, unpack(item[1]), unpack(oldAccounts.get(item[0])));
        bucket.accounts.set(item[0], merged);
      }
      updates.set(row.hour, bucket);
    }
    const coverage = union([...this.coverage, ...(final.coverage || [])], now - RETENTION, now);
    for (const [hour, bucket] of updates) this.hours.set(hour, bucket);
    this.coverage = coverage;
    if (id) this.appliedDrains.add(id);
  }

  restoreState(state) {
    this.hours.clear();
    this.coverage = [];
    this.appliedDrains.clear();
    try {
      this.mergeDrain(null, state);
      if (state?.version === 1 && Array.isArray(state.appliedDrains)) {
        for (const id of state.appliedDrains) if (typeof id === 'string') this.appliedDrains.add(id);
      }
    } catch { /* Regenerable history with an unreadable shape starts empty. */ }
  }
}

// Are the accounts keeping up right now? Judged on the share of requests the router held for a
// lasting wait, how long the oldest held request has waited, and any capacity refusal. Shares and
// p95 need minRequests behind them AND at least minWaited lasting waits: one 1 ms wait among twenty
// requests is 5%, not a shortage. Under those minimums only direct evidence escalates (a request
// held now, any refusal); otherwise the answer is "quiet", never "ok", because a healthy-looking
// zero needs traffic behind it.
export function capacityState(m) {
  const b = CAPACITY_BANDS;
  if (!m || !Number.isFinite(m.requests)) return 'unknown';
  const enough = m.requests >= b.minRequests;
  const notable = count(m.notableWaits);
  const lasting = notable >= b.minWaited;
  const waitedShare = m.requests ? notable / m.requests : 0;
  const denied = m.requests ? m.capacityDenied / m.requests : 0;
  if (m.oldestWaitMs >= b.shortOldestMs || (enough && lasting && (waitedShare >= b.shortWaitedShare || denied >= b.shortDeniedShare))) return 'short';
  if (m.capacityDenied > 0 || (m.pending > 0 && m.oldestWaitMs >= b.tightOldestMs)
    || (enough && lasting && (waitedShare >= b.tightWaitedShare || (m.queuedWaitP95Ms ?? 0) > b.tightQueuedP95Ms))) return 'tight';
  return enough ? 'ok' : 'quiet';
}

const CAPACITY_CAUSES = new Set(['weekly_exhausted', 'weekly_reset_unknown', 'concurrency_cap', 'session_limit',
  'provider_limit', 'rate_limited', 'weekly_critical']);

// The retry plan reports the soonest recovery even when matching routes have
// different blockers. Only a unanimous known cause justifies naming a window.
export function capacityDenial(plan) {
  if (!CAPACITY_CAUSES.has(plan?.cause)) return null;
  const reasons = plan.reasons || {};
  const n = plan.matchingRoutes;
  if (n > 0 && plan.cause === 'weekly_exhausted' && reasons.weekly_exhausted === n) return 'weeklyDenied';
  if (n > 0 && plan.cause === 'session_limit' && reasons.session_limit === n) return 'sessionDenied';
  if (n > 0 && plan.cause === 'concurrency_cap' && reasons.concurrency_cap === n) return 'concurrencyDenied';
  return 'unclassifiedDenied';
}

// One reference survives retry copies of requestInfo. Wire evidence wins over
// HTTP 200, which is also used for error frames on an already-open stream.
export function noteMessageEvent(info, data) {
  const trace = info?._service;
  if (!trace || !data) return;
  if (data.type === 'message_delta' && data.delta?.stop_reason === 'max_tokens') trace.limited = true;
  if (data.type === 'error') trace.terminal = 'failed';
  if (data.type === 'message_stop' && !trace.terminal) trace.terminal = trace.limited ? 'incomplete' : 'completed';
}

export function noteMessageBody(info, message) {
  if (!info?._service) return;
  const trace = info._service;
  if (message?.type === 'error' || message?.error) trace.terminal = 'failed';
  else if (message?.type === 'message' && typeof message.stop_reason === 'string') {
    trace.terminal = message.stop_reason === 'max_tokens' ? 'incomplete' : 'completed';
  }
}

export function finishInference(trace, status, cancelled) {
  if (!trace) return;
  let outcome = trace.terminal;
  if (cancelled && !outcome) outcome = 'cancelled';
  if (!outcome) outcome = status >= 200 && status < 300 ? 'incomplete' : 'failed';
  if (outcome !== 'cancelled' && trace.denied) outcome = 'capacityDenied';
  if (status >= 400 && outcome === 'completed') outcome = 'failed';
  trace.finish(outcome, trace.usage, trace.denied);
}

// Keep counters by value: requestInfo is copied by retries and may also appear
// in debug/status records. Holding it inside its own trace would create a cycle.
export function noteRoutingUsage(trace, info) {
  if (trace) trace.usage = { _capacityInput: info._capacityInput, _capacityCacheRead: info._capacityCacheRead,
    _capacityCacheCreation: info._capacityCacheCreation };
}

// Retain only the two short top-level JSON strings that prove a linked Messages
// outcome. Large tool/text content can precede or follow both fields. It stays
// on the wire; neither it nor a chunk-spanning escaped quote can mimic a field.
export class LinkedMessageEnvelope {
  depth = 0;
  expect = 'root';
  quoted = false;
  escaped = false;
  capture = false;
  text = '';
  key = '';
  type = null;
  stop_reason = null;

  push(chunk) {
    const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    for (let i = 0; i < text.length; i++) {
      if (this.quoted && !this.capture && !this.escaped) {
        // Text and tool arguments can fill megabytes. Seek directly to the next
        // quote, inspecting only its adjacent backslashes to decide if it ends
        // the string. Carry odd trailing backslashes across network chunks.
        const quote = text.indexOf('"', i);
        const end = quote < 0 ? text.length : quote;
        let slash = end;
        while (slash > i && text.charCodeAt(slash - 1) === 92) slash--;
        const escaped = (end - slash) % 2 === 1;
        if (quote < 0) { this.escaped = escaped; return; }
        i = quote;
        if (escaped) continue;
      }
      const b = text.charCodeAt(i);
      if (this.quoted) {
        if (this.escaped) { this.escaped = false; this.capture = false; continue; }
        if (b === 92) { this.escaped = true; continue; }
        if (b !== 34) {
          if (this.capture && this.text.length < 80) this.text += String.fromCharCode(b);
          else this.capture = false;
          continue;
        }
        this.quoted = false;
        if (this.depth !== 1) continue;
        if (this.expect === 'key') {
          this.key = this.capture ? this.text : '';
          this.expect = 'colon';
        } else if (this.expect === 'value') {
          if (this.capture) this[this.key] = this.text;
          this.expect = 'comma';
        }
      } else if (b === 34) {
        this.quoted = true;
        this.capture = this.depth === 1 && (this.expect === 'key'
          || (this.expect === 'value' && (this.key === 'type' || this.key === 'stop_reason')));
        this.text = '';
      } else if (b === 123 || b === 91) {
        if (this.depth === 0 && (this.expect !== 'root' || b !== 123)) this.expect = 'invalid';
        if (this.expect === 'invalid') return;
        this.depth++;
        if (this.depth === 1) this.expect = 'key';
      } else if (b === 125 || b === 93) {
        if (--this.depth === 0) this.expect = b === 125 ? 'end' : 'invalid';
        if (this.depth < 0) { this.expect = 'invalid'; return; }
      } else if (this.depth === 1) {
        if (b === 44) this.expect = 'key';
        else if (b === 58 && this.expect === 'colon') this.expect = 'value';
      } else if (!this.depth && b !== 32 && b !== 9 && b !== 10 && b !== 13) {
        this.expect = 'invalid';
        return;
      }
    }
  }

  message() {
    return this.expect === 'end' && !this.quoted ? { type: this.type, stop_reason: this.stop_reason } : null;
  }
}
