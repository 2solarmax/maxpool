// Vendor quota readings describe a subscription even if MaxPool served zero requests.
// A closing reading is an estimate of headroom at the reset. Usage can still arrive
// between the last probe and the boundary, including traffic outside MaxPool.
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const SPAN = { wk: 7 * DAY, ses: 5 * 60 * MINUTE };
const STAMP_JITTER = MINUTE;
const KEEP_MS = 13 * 7 * DAY;
const MAX_CYCLES = Math.ceil(KEEP_MS / SPAN.ses) + 1;

export function capacityKpiWindow(account) {
  return account?.type === 'provider' && account.provider === 'zai' && account.quota?.weeklyAbsent === true
    ? 'ses' : 'wk';
}

export function classifyCapacityOpportunity(cycle, demand) {
  if (cycle.unusedFraction == null) return 'unknown';
  if (cycle.unusedFraction === 0) return 'fully-used';
  if (cycle.alternativeTurns > 0) return 'eligible-demand-served-elsewhere';
  if (demand?.completeCoverage && demand.arrivals === 0 && demand.peerArrivals === 0 && demand.peakOutstanding === 0) {
    return 'no-observed-demand';
  }
  return 'unattributed';
}

// Size for weekly volume on this worker. The three disjoint trailing weeks end at
// a complete UTC hour so service buckets neither overlap nor include future time.
// Untagged client retries and unknown denied output prevent a positive plan count.
export function provisioningEvidence(demandBetween, now, measuredWeeklyCycles = 0) {
  const hour = 60 * MINUTE;
  const through = Math.floor(now / hour) * hour;
  const sampledWeeks = 3;
  let coveredWeeks = 0, idleWeeks = 0, arrivals = 0, peerArrivals = 0, capacityDenied = 0;
  for (let i = 0; i < sampledWeeks; i++) {
    const end = through - i * SPAN.wk;
    const demand = demandBetween(end - SPAN.wk, end);
    if (!demand) continue;
    arrivals += demand.arrivals || 0;
    peerArrivals += demand.peerArrivals || 0;
    capacityDenied += demand.capacityDenied || 0;
    if (!demand.completeCoverage) continue;
    coveredWeeks++;
    if (demand.arrivals === 0 && demand.peerArrivals === 0 && demand.peakOutstanding === 0) idleWeeks++;
  }
  const idle = idleWeeks === sampledWeeks;
  const reason = idle ? 'no-observed-demand' : coveredWeeks < sampledWeeks ? 'incomplete-history' : 'unmeasured-weekly-shortfall-and-plan-yield';
  return {
    status: idle ? 'no-observed-demand' : 'insufficient-evidence', reason,
    low: idle ? 0 : null, high: idle ? 0 : null, from: through - sampledWeeks * SPAN.wk, through,
    sampledWeeks, coveredWeeks, arrivals, peerArrivals, capacityDenied, measuredWeeklyCycles,
  };
}

function validObservation(row) {
  return row && Object.hasOwn(SPAN, row.window) && Number.isFinite(row.observedAt)
    && Number.isFinite(row.resetAt) && row.resetAt > row.observedAt
    && row.resetAt - row.observedAt <= SPAN[row.window] + STAMP_JITTER
    && Number.isFinite(row.utilization) && row.utilization >= 0 && row.utilization <= 1;
}

function sameWindow(row, window, resetAt) {
  return row?.window === window && Math.abs(row.resetAt - resetAt) <= STAMP_JITTER;
}

function claimedDuring(cycle, at) {
  return Number.isFinite(at) && at >= cycle.startAt && at < cycle.resetAt;
}

function usedFraction(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export class RoutingCapacityAnalytics {
  constructor({ demandBetween } = {}) {
    this.owners = new Map();
    this.appliedDrains = new Map();
    this.demandBetween = demandBetween;
  }

  observe({ owner, window, resetAt, utilization, observedAt = Date.now(), enabled = true, lastClaimAt, freshForMs } = {}) {
    if (typeof owner !== 'string' || !owner || !validObservation({ window, resetAt, utilization, observedAt })) return;
    let rec = this.owners.get(owner);
    if (!rec) {
      rec = { open: null, cycles: [] };
      this.owners.set(owner, rec);
    }
    let open = rec.open;
    const latest = open || rec.cycles.at(-1);
    if (latest && observedAt < latest.observedAt) return;
    const sameOpen = sameWindow(open, window, resetAt);
    if (sameOpen && observedAt >= open.resetAt) return;
    if (!sameOpen && rec.cycles.some(c => sameWindow(c, window, resetAt))) return;
    if (open && claimedDuring(open, lastClaimAt)) open.refilled = true;
    if (open && !sameOpen) {
      // A changed plan or an early advance replaces the previously advertised reset.
      // The new window's utilization cannot stand in for the old window's reading.
      const replaced = open.window !== window || observedAt < open.resetAt - STAMP_JITTER;
      this._close(rec, observedAt, replaced ? 'replaced-before-reset' : null);
      open = null;
    }
    if (!open) {
      open = { window, resetAt, startAt: resetAt - SPAN[window], alternativeTurns: 0 };
      rec.open = open;
    } else if (open.peakUtilization - utilization >= 0.10 - 1e-9) {
      // The capacity ledger uses the same 10 percentage-point drop to identify
      // a refill with an unchanged stamp. A late or contradictory read is ambiguous.
      open.refilled = true;
    }
    if (claimedDuring(open, lastClaimAt)) open.refilled = true;
    if (!enabled) open.disabled = true;
    open.observedAt = observedAt;
    open.utilization = utilization;
    open.peakUtilization = Math.max(open.peakUtilization ?? utilization, utilization);
    // Default to the existing probe staleness floor. Operators with slower polls may
    // pass that cadence; never admit a 'closing' value more than 15 minutes old.
    open.freshForMs = Number.isFinite(freshForMs) ? Math.min(15 * MINUTE, Math.max(0, freshForMs)) : 3 * MINUTE;
  }

  markUnavailable(owner) {
    const open = this.owners.get(owner)?.open;
    if (open) open.disabled = true;
  }

  markRefill(owner, at = Date.now()) {
    const open = this.owners.get(owner)?.open;
    if (open && claimedDuring(open, at)) open.refilled = true;
  }

  noteAlternative({ owner, window, resetAt, at = Date.now() } = {}) {
    const rec = this.owners.get(owner);
    const cycle = sameWindow(rec?.open, window, resetAt) ? rec.open
      : rec?.cycles.find(c => sameWindow(c, window, resetAt));
    if (!cycle || !claimedDuring(cycle, at)) return;
    cycle.alternativeTurns++;
    // A turn that spanned the reset completes after the timer has closed its window.
    if (cycle.unusedFraction > 0) cycle.attribution = 'eligible-demand-served-elsewhere';
  }

  _closedRecord(o, now, interruption, demandBetween = this.demandBetween) {
    const reason = interruption || (o.refilled ? 'refill' : o.disabled ? 'disabled'
      : o.resetAt - o.observedAt > o.freshForMs ? 'stale-reading' : 'natural-reset');
    const cycle = { ...o, endedAt: interruption ? now : o.resetAt, reason,
      unusedFraction: reason === 'natural-reset' ? 1 - (o.peakUtilization ?? o.utilization) : null };
    cycle.attribution = classifyCapacityOpportunity(cycle, demandBetween?.(cycle.startAt, cycle.endedAt));
    return cycle;
  }

  _close(rec, now, interruption, demandBetween) {
    rec.cycles.push(this._closedRecord(rec.open, now, interruption, demandBetween));
    if (rec.cycles.length > MAX_CYCLES) rec.cycles.shift();
    rec.open = null;
  }

  advance(now = Date.now(), demandBetween = this.demandBetween) {
    for (const [id, at] of this.appliedDrains) if (at < now - KEEP_MS) this.appliedDrains.delete(id);
    for (const [owner, rec] of this.owners) {
      if (rec.open && now >= rec.open.resetAt) this._close(rec, now, null, demandBetween);
      while (rec.cycles.length && rec.cycles[0].endedAt < now - KEEP_MS) rec.cycles.shift();
      if (!rec.open && !rec.cycles.length) this.owners.delete(owner);
    }
  }

  snapshot(owner, now = Date.now(), demandBetween) {
    const rec = this.owners.get(owner);
    const cycles = (rec?.cycles || []).filter(c => c.endedAt >= now - KEEP_MS).reverse().map(c => {
      // Worker coverage can catch up after a boundary or a link can be attached.
      if (c.attribution !== 'unattributed' || !demandBetween) return { ...c };
      return { ...c, attribution: classifyCapacityOpportunity(c, demandBetween(c.startAt, c.endedAt)) };
    });
    const window = rec?.open?.window || cycles[0]?.window || null;
    const comparable = cycles.filter(c => c.window === window);
    const measured = comparable.filter(c => c.unusedFraction != null);
    return {
      window, cycles, measuredCycles: measured.length, unknownCycles: comparable.length - measured.length,
      meanUnusedFraction: measured.length ? measured.reduce((sum, c) => sum + c.unusedFraction, 0) / measured.length : null,
    };
  }

  // A retiring worker and the new primary share one snapshot, then see different
  // completions and meter readings. Transfer just the windows that changed after
  // the baton. Reset stamps are stable inside each worker's persisted record.
  static drainDelta(before, after) {
    if (after?.version !== 1) return null;
    const baseline = new Map(before?.owners || []);
    const owners = [];
    const records = rec => [...(rec?.cycles || []), ...(rec?.open ? [rec.open] : [])];
    const key = r => r.window + ':' + r.resetAt;
    for (const [owner, rec] of after.owners) {
      const original = new Map(records(baseline.get(owner)).map(r => [key(r), r]));
      const changed = [];
      for (const row of records(rec)) {
        const prev = original.get(key(row));
        if (prev && JSON.stringify(prev) === JSON.stringify(row)) continue;
        changed.push({ row: { ...row }, addedTurns: Math.max(0, row.alternativeTurns - (prev?.alternativeTurns || 0)) });
      }
      if (changed.length) owners.push([owner, changed]);
    }
    return owners.length ? { version: 1, owners } : null;
  }

  mergeDrain(delta, id, now = Date.now()) {
    if (!id || this.appliedDrains.has(id) || delta?.version !== 1 || !Array.isArray(delta.owners)) return;
    for (const entry of delta.owners) {
      if (!Array.isArray(entry)) continue;
      const [owner, changes] = entry;
      if (typeof owner !== 'string' || !owner || !Array.isArray(changes)) continue;
      const rec = this.owners.get(owner) || { open: null, cycles: [] };
      for (const change of changes) {
        const row = change?.row;
        if (!validObservation(row) || !usedFraction(row.peakUtilization) || !Number.isFinite(row.freshForMs)
          || !Number.isSafeInteger(change.addedTurns) || change.addedTurns < 0 || row.resetAt < now - KEEP_MS) continue;
        const open = sameWindow(rec.open, row.window, row.resetAt);
        const existing = open ? rec.open : rec.cycles.find(c => sameWindow(c, row.window, row.resetAt));
        // Retain both branches' evidence, ordered by the time the reading was made.
        // Never sum utilization: it is one vendor meter seen from two workers.
        const newer = !existing || row.observedAt > existing.observedAt ? row : existing;
        const { window, startAt, resetAt } = existing || row;
        const peak = Math.max(row.peakUtilization, existing?.peakUtilization || 0);
        const reading = { window, startAt, resetAt, utilization: newer.utilization, observedAt: newer.observedAt,
          freshForMs: newer.freshForMs, peakUtilization: peak,
          alternativeTurns: existing ? existing.alternativeTurns + change.addedTurns : row.alternativeTurns };
        if (row.refilled || existing?.refilled || peak - newer.utilization >= 0.10 - 1e-9) reading.refilled = true;
        if (row.disabled || existing?.disabled) reading.disabled = true;
        const interruption = [existing, row].find(c => c?.reason === 'replaced-before-reset' || c?.reason === 'conflicting-reset');
        const newerWindow = !existing && (rec.open || rec.cycles.at(-1)?.observedAt > row.observedAt);
        if (row.endedAt || existing?.endedAt || now >= resetAt || newerWindow) {
          // A conflicting old observation may be shown as unknown, never installed
          // over the new worker's live window.
          const reason = interruption?.reason || (newerWindow && !row.endedAt && now < resetAt ? 'conflicting-reset' : null);
          const closed = this._closedRecord(reading, interruption?.endedAt || now, reason);
          if (existing && !open) Object.assign(existing, closed);
          else rec.cycles.push(closed);
          if (open) rec.open = null;
        } else rec.open = reading;
      }
      rec.cycles.sort((a, b) => a.endedAt - b.endedAt);
      if (rec.cycles.length > MAX_CYCLES) rec.cycles.splice(0, rec.cycles.length - MAX_CYCLES);
      if (rec.open || rec.cycles.length) this.owners.set(owner, rec);
    }
    this.appliedDrains.set(id, now);
  }

  serialize() {
    return { version: 1, owners: structuredClone([...this.owners]), appliedDrains: [...this.appliedDrains] };
  }

  restore(saved) {
    if (saved?.version !== 1 || !Array.isArray(saved.owners)) return;
    const restored = new Map();
    for (const entry of saved.owners) {
      if (!Array.isArray(entry)) continue;
      const [owner, rec] = entry;
      if (typeof owner !== 'string' || !owner || !rec || !Array.isArray(rec.cycles)) continue;
      const open = validObservation(rec.open) && Number.isFinite(rec.open.freshForMs)
        && Number.isFinite(rec.open.startAt) && Number.isInteger(rec.open.alternativeTurns) ? rec.open : null;
      const cycles = rec.cycles.slice(-MAX_CYCLES).filter(c => c && Object.hasOwn(SPAN, c.window)
        && [c.startAt, c.endedAt, c.resetAt, c.observedAt].every(Number.isFinite)
        && (c.unusedFraction === null || usedFraction(c.unusedFraction)));
      if (open || cycles.length) restored.set(owner, structuredClone({ open, cycles }));
    }
    this.owners = restored;
    this.appliedDrains = new Map((Array.isArray(saved.appliedDrains) ? saved.appliedDrains : [])
      .filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && Number.isFinite(pair[1])));
  }
}
