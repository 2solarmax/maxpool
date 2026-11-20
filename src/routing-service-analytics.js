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
const PEAKS = ['peakOutstanding', 'peakServing', 'peakSessions', 'longestWaitMs'];
const hourOf = t => Math.floor(t / HOUR) * HOUR;
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
  return { ...result, waitP90Ms: quantile(0.90), waitP95Ms: quantile(0.95), queuedWaitP95Ms: quantile(0.95, true) };
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
    let account = null, serving = false, waitingSince = null, waitMs = 0, waited = false, ended = false;
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
      },
      resume: () => stopWait(this.now()),
      finish: (outcome, usage = {}, denial) => {
        if (ended) return;
        ended = true;
        const now = this.now();
        const bucket = this.observe(now);
        stopWait(now);
        leave();
        if (peer) this.activePeer--;
        else this.active--;
        for (const stats of [peer ? null : bucket.total, accountStats(bucket, account)]) {
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
          const cached = count(usage?._capacityCacheRead);
          stats.cachedInputTokens += cached;
          stats.inputTokens += cached + count(usage?._capacityInput) + count(usage?._capacityCacheCreation);
          if (waited) stats.queuedRequests++;
          const index = WAIT_BOUNDS.findIndex(max => waitMs <= max);
          stats.waits[index < 0 ? WAIT_BOUNDS.length : index]++;
          stats.longestWaitMs = Math.max(stats.longestWaitMs, waitMs);
        }
      },
    };
  }

  snapshot(windowMs = 24 * HOUR, now = this.now()) {
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
      timeline.push({ hour, ...summarize(bucket.total) });
    }
    const completeCoverage = this._intervals(now).some(([start, end]) => start <= from && end >= now);
    return { ...summarize(total), completeCoverage, active: this.active, serving: this.serving, activeSessions: this.sessions.size,
      waitTargetMs: WAIT_TARGET, coverageSince: this._intervals(now)[0]?.[0] ?? null, from, to: now,
      accounts: [...accounts].map(([name, row]) => ({ name, ...summarize(row), serving: this.servingAccounts.get(name) || 0 })),
      timeline: timeline.sort((a, b) => a.hour - b.hour) };
  }

  demandBetween(from, to) {
    const now = this.now();
    this.observe(now);
    const counters = { arrivals: 0, peerArrivals: 0, capacityDenied: 0, weeklyDenied: 0, sessionDenied: 0, concurrencyDenied: 0, unclassifiedDenied: 0, requests: 0, completed: 0, failed: 0,
      cancelled: 0, incomplete: 0 };
    let peakOutstanding = 0;
    for (const [hour, bucket] of this.hours) {
      if (hour >= to || hour + HOUR <= from) continue;
      for (const key of Object.keys(counters)) counters[key] += bucket.total[key];
      peakOutstanding = Math.max(peakOutstanding, bucket.total.peakOutstanding);
    }
    const completeCoverage = Number.isSafeInteger(from) && Number.isSafeInteger(to) && to > from
      && from >= hourOf(now) - RETENTION + HOUR
      && this._intervals(now).some(([start, end]) => start <= from && end >= to);
    return { ...counters, peakOutstanding, completeCoverage };
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
    return { version: 1, coverage: this._intervals(now), hours };
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

  // Caller deduplicates a worker's drain ID atomically with its saved state.
  // Only increments after its takeover baseline move between workers. Gauges
  // and session IDs are ephemeral; history retains observed concurrent peaks.
  mergeDrain(baseline, final) {
    if (final?.version !== 1 || !Array.isArray(final.hours)) return;
    const now = this.now();
    const firstHour = hourOf(now) - RETENTION + HOUR;
    const before = new Map((baseline?.hours || []).map(row => [row.hour, row]));
    for (const row of final.hours) {
      if (!row || !Number.isSafeInteger(row.hour) || row.hour % HOUR || row.hour < firstHour || row.hour > now) continue;
      const old = before.get(row.hour);
      if (!this.hours.has(row.hour)) this.hours.set(row.hour, { total: empty(), accounts: new Map() });
      const bucket = this.hours.get(row.hour);
      bucket.saved = null;
      combine(bucket.total, unpack(row.total), unpack(old?.total));
      const oldAccounts = new Map(old?.accounts || []);
      for (const item of row.accounts || []) {
        if (!Array.isArray(item) || typeof item[0] !== 'string' || !item[0] || item[0].length > 256) continue;
        combine(accountStats(bucket, item[0]), unpack(item[1]), unpack(oldAccounts.get(item[0])));
      }
    }
    this.coverage = union([...this.coverage, ...(final.coverage || [])], now - RETENTION, now);
  }

  restoreState(state) {
    this.hours.clear();
    this.coverage = [];
    this.mergeDrain(null, state);
  }
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
    for (const b of chunk) {
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
