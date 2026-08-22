/**
 * True-capacity ledger — observed tokens per completed window cycle.
 *
 * The measurement model (user spec 2026-08-22): when a 5h or weekly window completes,
 * the tokens delivered during that cycle ARE the account's measured capacity for the
 * window. History per account per window: last / prev / prev-1 / avg3 / avg10 /
 * all-time — in tokens, so a GLM row and a Claude row compare apples to apples.
 *
 * The no-weekly account (legacy z.ai TOKENS_LIMIT, weeklyAbsent) has no weekly TANK:
 * it gets full 5h cycle history plus a rolling-7d THROUGHPUT from UTC day buckets —
 * a volume, never a limit, rendered distinctly.
 *
 * PURE: no I/O, injected clock. Persistence + accrual seams live in account-manager /
 * index; this module owns the data model and its invariants.
 * Pre-mortem (2026-08-22) blockers B1/B2 + majors M3-M7 are the load-bearing comments.
 */

const SCHEMA_VERSION = 1;
const MAX_CYCLES_PER_WINDOW = 50;
const MAX_DAY_BUCKETS = 10;

export class CapacityLedger {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    // accountName → { ses: {open?, closed: []}, wk: {open?, closed: []}, days: {utcDay: {tokens, partial}} }
    this._accounts = new Map();
  }

  /** Restore from a serialized payload (state.json). Tolerant: unknown schemaVersion →
   *  start empty and KEEP the file (the caller preserves it); a corrupt shape → empty. */
  static fromSerialized(payload, { now = () => Date.now() } = {}) {
    const l = new CapacityLedger({ now });
    if (!payload || payload.schemaVersion !== SCHEMA_VERSION) return l;
    try {
      for (const [name, rec] of Object.entries(payload.accounts || {})) {
        const a = { ses: { open: null, closed: [] }, wk: { open: null, closed: [] }, days: {} };
        for (const w of ['ses', 'wk']) {
          if (rec[w]?.open) a[w].open = { ...rec[w].open };
          if (Array.isArray(rec[w]?.closed)) a[w].closed = rec[w].closed.slice(-MAX_CYCLES_PER_WINDOW);
        }
        if (rec.days && typeof rec.days === 'object') {
          for (const [d, v] of Object.entries(rec.days)) a.days[d] = { ...v };
        }
        l._accounts.set(name, a);
      }
    } catch { return new CapacityLedger({ now }); }
    return l;
  }

  serialize() {
    const accounts = {};
    for (const [name, rec] of this._accounts) {
      accounts[name] = {
        ses: { open: rec.ses.open ? { ...rec.ses.open } : null, closed: rec.ses.closed.slice() },
        wk: { open: rec.wk.open ? { ...rec.wk.open } : null, closed: rec.wk.closed.slice() },
        days: Object.fromEntries(Object.entries(rec.days).map(([d, v]) => [d, { ...v }])),
      };
    }
    return { schemaVersion: SCHEMA_VERSION, accounts };
  }

  _rec(name) {
    let r = this._accounts.get(name);
    if (!r) {
      r = { ses: { open: null, closed: [] }, wk: { open: null, closed: [] }, days: {} };
      this._accounts.set(name, r);
    }
    return r;
  }

  // ── Accrual ──────────────────────────────────────────────────────────────────

  /** Accrue one served request's tokens. `tokens` = {input, output} for THIS request,
   *  already per-request-max semantics for output (the caller derives them; see
   *  M3 in the pre-mortem — Anthropic interim deltas are CUMULATIVE, so the SSE seam
   *  passes the running max, and this adds it exactly once per request).
   *  count_tokens requests are the CALLER's job to skip (M4) — they never reach here. */
  accrue(name, { input, output }, at = this._now()) {
    if (!(input > 0) && !(output > 0)) return;
    const rec = this._rec(name);
    for (const w of ['ses', 'wk']) {
      // Open the window lazily if nothing is open (a mid-cycle boot or a window whose
      // reset stamp was never learned). startedAt is the accrual time then — the cycle
      // will be flagged partial by the caller if the boot gap warrants it (B1/B2).
      if (!rec[w].open) {
        rec[w].open = { startedAt: at, tokensSoFar: 0, lastAccrualAt: at, complete: true, disabledDuring: false };
      }
      rec[w].open.tokensSoFar += input + output;
      rec[w].open.lastAccrualAt = at;
    }
    const day = new Date(at).toISOString().slice(0, 10);
    rec.days[day] = rec.days[day] || { tokens: 0, partial: false };
    rec.days[day].tokens += input + output;
    this._evictDays(rec);
  }

  _evictDays(rec) {
    const keys = Object.keys(rec.days).sort();
    while (keys.length > MAX_DAY_BUCKETS) {
      delete rec.days[keys.shift()];
    }
  }

  // ── Cycle lifecycle ─────────────────────────────────────────────────────────

  /** Mark the open cycles as partial (maxpool was down / an account was disabled).
   *  Called by the boot path when a gap is detected (B2), and by the disable hook. */
  markPartial(name, { disabled = false } = {}) {
    const rec = this._accounts.get(name);
    if (!rec) return;
    for (const w of ['ses', 'wk']) {
      if (!rec[w].open) continue;
      // TWO INDEPENDENT axes, deliberately not collapsed: `complete:false` = maxpool
      // was down for part of the cycle; `disabledDuring` = the operator took the
      // account out of rotation. Setting both for a disable made the disabled flag
      // query-redundant and therefore untested (red-team F6-1) — each now excludes on
      // its own, and each is pinned by its own test.
      if (disabled) rec[w].open.disabledDuring = true;
      else rec[w].open.complete = false;
    }
  }

  /** Close the open cycle for a window (M5: clock-authoritative — the close is keyed
   *  on `endedAt`, which the caller derives from the reset stamp or the clock, and the
   *  cycle keeps its own book regardless of probe health). No-op if none open. */
  closeCycle(name, window, endedAt = this._now(), { resetAt = null } = {}) {
    const rec = this._accounts.get(name);
    if (!rec || !rec[window]?.open) return null;
    const open = rec[window].open;
    rec[window].closed.push({
      startedAt: open.startedAt,
      endedAt,
      tokens: open.tokensSoFar,
      complete: open.complete,
      disabledDuring: open.disabledDuring,
      resetAt,
    });
    if (rec[window].closed.length > MAX_CYCLES_PER_WINDOW) rec[window].closed.shift();
    rec[window].open = null;
    return rec[window].closed[rec[window].closed.length - 1];
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** The columns the TUI renders: last, prev, prev1, avg3, avg10, allTime — over
   *  COMPLETE, not-disabled cycles only (D4/D5: partial and operator-disabled cycles
   *  are observations, not capacity). */
  windowStats(name, window) {
    const rec = this._accounts.get(name);
    const closed = (rec?.[window]?.closed || []).filter(c => c.complete && !c.disabledDuring);
    if (!closed.length) return null;
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const tokens = closed.map(c => c.tokens);
    return {
      last: closed[closed.length - 1].tokens,
      prev: closed.length >= 2 ? closed[closed.length - 2].tokens : null,
      prev1: closed.length >= 3 ? closed[closed.length - 3].tokens : null,
      avg3: avg(tokens.slice(-3)),
      avg10: avg(tokens.slice(-10)),
      allTime: avg(tokens),
      cycles: closed.length,
    };
  }

  /** Rolling-7d throughput (the no-weekly account's weekly figure). The window is
   *  keyed on CALENDAR days — [today-6 .. today] UTC — NOT "the last 7 buckets":
   *  buckets exist only where accrual happened, so a bucket-slice silently stretches
   *  across idle gaps and over-reports (red-team F4). A missing day contributes 0 by
   *  ABSENCE (present in dayKeys, absent from days) — and with MAX_DAY_BUCKETS=10 an
   *  idle day no longer even evicts; only real activity ages out. `partial` is true
   *  when any bucket in the window is flagged partial — the figure is ≤ observed. */
  rollingThroughput(name, days = 7) {
    const rec = this._accounts.get(name);
    if (!rec) return { tokens: 0, partial: false };
    // The window anchor is the LATEST RECORDED day, not "now": a test (or a ledger
    // restored after >7d idle) has buckets in the past relative to its clock, and a
    // today-anchored window would read 0 despite full history. Live, the latest
    // recorded day IS today (or yesterday) — identical behavior.
    const recorded = Object.keys(rec.days).sort();
    if (!recorded.length) return { tokens: 0, partial: false };
    const anchor = recorded[recorded.length - 1];
    const cutoff = this._utcDayMinus(anchor, Math.min(days - 1, MAX_DAY_BUCKETS - 1));
    let tokens = 0, partial = false;
    for (const [d, v] of Object.entries(rec.days)) {
      if (d >= cutoff && d <= anchor) { tokens += v.tokens; if (v.partial) partial = true; }
    }
    return { tokens, partial };
  }

  _utcDayMinus(day, n) {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  /**
   * Merge a DELTA of accrual into a base payload (B2 drain-exit merge-flush).
   *
   * The released worker keeps serving in-flight requests for up to RELOAD_DRAIN_MS
   * AFTER its final flush, and then exits bare — so every token delivered during the
   * drain was measured and thrown away. It cannot simply re-write its own ledger:
   * the NEW worker owns the file by then and has its own accrual. So at exit it
   * computes what it accrued SINCE its final flush (after − before) and adds only
   * that delta onto whatever the new worker has on disk.
   *
   * Adds to the OPEN cycles and the day buckets — the only places drain-time tokens
   * can land. A cycle the new worker already closed is not re-opened (the tokens
   * belonged to a window that has since rolled; dropping them is correct, and the
   * cycle is a completed observation we must not mutate after the fact).
   */
  static mergeDelta(basePayload, beforePayload, afterPayload) {
    const base = (basePayload && basePayload.schemaVersion === SCHEMA_VERSION)
      ? JSON.parse(JSON.stringify(basePayload))
      : { schemaVersion: SCHEMA_VERSION, accounts: {} };
    const before = beforePayload?.accounts || {};
    const after = afterPayload?.accounts || {};
    for (const [name, aRec] of Object.entries(after)) {
      const bRec = before[name] || {};
      for (const w of ['ses', 'wk']) {
        const aOpen = aRec[w]?.open, bOpen = bRec[w]?.open;
        if (!aOpen) continue;
        const target = base.accounts[name]?.[w];
        // The BASE's open cycle is the one being amended, so the same-cycle check is
        // against IT — not against our own before-snapshot (which trivially matches
        // our own after-snapshot and so never fired). A different startedAt means the
        // window rolled during the drain: the delta belongs to a window the new worker
        // has already closed, and crediting it to the fresh cycle would inflate the
        // very next capacity reading by a whole window of traffic (red-team F6-3).
        if (!target?.open) continue;
        if (target.open.startedAt !== aOpen.startedAt) continue;
        const delta = (bOpen && bOpen.startedAt === aOpen.startedAt)
          ? aOpen.tokensSoFar - bOpen.tokensSoFar
          : aOpen.tokensSoFar;
        if (!(delta > 0)) continue;
        target.open.tokensSoFar += delta;
        target.open.lastAccrualAt = Math.max(target.open.lastAccrualAt || 0, aOpen.lastAccrualAt || 0);
      }
      for (const [day, v] of Object.entries(aRec.days || {})) {
        const bTok = bRec.days?.[day]?.tokens || 0;
        const delta = (v.tokens || 0) - bTok;
        if (!(delta > 0)) continue;
        base.accounts[name] = base.accounts[name]
          || { ses: { open: null, closed: [] }, wk: { open: null, closed: [] }, days: {} };
        const days = base.accounts[name].days;
        days[day] = days[day] || { tokens: 0, partial: false };
        days[day].tokens += delta;
      }
    }
    return base;
  }

  dayKeys(name) { return Object.keys(this._accounts.get(name)?.days || {}).sort(); }
  openCycle(name, window) { return this._accounts.get(name)?.[window]?.open || null; }
  accounts() { return [...this._accounts.keys()]; }
  markDayPartial(name, utcDay) {
    const rec = this._accounts.get(name);
    if (rec?.days[utcDay]) rec.days[utcDay].partial = true;
  }
}
