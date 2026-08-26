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

// v3 (2026-08-23): every v2 row was written before the joined-mid-window fix, so each
// account's first cycle is a TAIL-only observation recorded as `complete` (measured on
// the live ledger: 14.6, 64.3, 64.4 and 74.4 minutes for 5h windows — all four rows it
// held). Rather than drop history a second time, v3 MIGRATES: closed v2 rows are kept
// and shown, marked partial with a reason, so they never reach an average and never
// re-alert. Forward rows are correct by construction.
//
// v2 (2026-08-23): v1 histories are POISONED and are deliberately dropped on load.
// The OAuth reset-stamp jitter (see AccountManager.noteCapacityWindowAdvance) shredded
// real windows into slivers and recorded future-dated weekly cycles, so a v1 payload's
// averages are wrong for weeks. Starting empty costs one window; keeping it costs trust.
const SCHEMA_VERSION = 3;

// Two closes this far apart are the SAME boundary observed twice (a clock-close and a
// stamp-advance racing across the boundary second), not two windows.
const SAME_BOUNDARY_MS = 5_000;

// The minimum span of a COMPLETE cycle per window (80% of nominal): a real one is
// flagged partial by the writer, so a complete cycle below this is corrupt history.
const READ_FLOOR_MS = { ses: 4 * 3600_000, wk: 5 * 86400_000 };

// TANK floor. tank = tokens ÷ utilization, and vendors report WHOLE percents — so at
// 1% full, one percentage point of rounding swings the answer by 100% (measured live
// 2026-08-25: a 1%-full window read "≥45M"). Below this the reading is rounding noise,
// not a measurement. Exported because BOTH the closed-cycle average and the live
// in-window estimate must apply the same floor; one guarding without the other is how
// the absurd number reached the screen in the first place.
export const TANK_MIN_UTIL = 0.05;
const MAX_CYCLES_PER_WINDOW = 50;
const MAX_DAY_BUCKETS = 10;

// Demote a pre-v3 closed cycle: unverifiable (every one predates the joined-mid-window
// fix) AND untrustworthy in its timestamps (the v1.8.4 advance-close could date a row
// hours into the future — live: a row ending 19:54 while the clock read 15:02). Also
// CLAMPS a future endedAt to startedAt so the stored row itself stops violating
// invariants after migration, not just the averages.
function demote(c) {
  // Timestamp repair is NOT done here — the load-time pass below handles a future
  // endedAt at every schema version, so doing it twice would be two places to fix.
  return { ...c, complete: false, partialReason: 'pre-v3-unverified' };
}

export class CapacityLedger {
  constructor({ now = () => Date.now() } = {}) {
    this._now = now;
    // accountName → { ses: {open?, closed: []}, wk: {open?, closed: []}, days: {utcDay: {tokens, partial}} }
    this._accounts = new Map();
    // True only for a ledger restored with no usable history — see fromSerialized.
    // Cleared per account+window once that window's first boundary is behind us.
    this._joinedMidWindow = false;
    this._utilObservedAt = 0;   // last utilization-reading arrival (see estimateFromUtilization)
    // Test seam ONLY: real-window fixtures are laborious for every close-cycle test,
    // so tests may zero the read floor. Production never touches this.
    this._readFloorOverride = null;
  }

  /** Restore from a serialized payload (state.json). Tolerant: unknown schemaVersion →
   *  start empty and KEEP the file (the caller preserves it); a corrupt shape → empty. */
  static fromSerialized(payload, { now = () => Date.now() } = {}) {
    const l = new CapacityLedger({ now });
    // v2 → v3: keep the rows, demote them. They were all written before the
    // joined-mid-window fix, so each is a partial observation mislabelled complete.
    if (payload?.schemaVersion === 2) {
      const migrated = { schemaVersion: SCHEMA_VERSION, accounts: {} };
      for (const [name, rec] of Object.entries(payload.accounts || {})) {
        migrated.accounts[name] = {
          ses: { open: rec.ses?.open || null,
                 closed: (rec.ses?.closed || []).map(c => demote(c)) },
          wk: { open: rec.wk?.open || null,
                closed: (rec.wk?.closed || []).map(c => demote(c)) },
          days: rec.days || {},
        };
      }
      return CapacityLedger.fromSerialized(migrated, { now });
    }
    if (!payload || payload.schemaVersion !== SCHEMA_VERSION) {
      // No history to continue: whatever window each account is in RIGHT NOW is
      // already in progress, so the next cycle we close saw only its tail. Flag it so
      // it is shown but never averaged (live 2026-08-23: the first GLM cycle after the
      // v1.8.1 migration read 21,192 tokens for a 5h window it had watched 14.6 min —
      // and with one cycle recorded, that sliver WAS every column).
      l._joinedMidWindow = true;
      return l;
    }
    try {
      for (const [name, rec] of Object.entries(payload.accounts || {})) {
        const a = { ses: { open: null, closed: [] }, wk: { open: null, closed: [] }, days: {} };
        for (const w of ['ses', 'wk']) {
          if (rec[w]?.open) a[w].open = { ...rec[w].open };
          if (Array.isArray(rec[w]?.closed)) {
            // LOAD-TIME REPAIR, applied at EVERY version — not inside the v2→v3 branch,
            // which is where it was first (wrongly) placed: a future-dated row can be
            // written by any build whose writer had the bug, and the payload it lands in
            // is then already current, so a version-gated repair never runs. Measured
            // 2026-08-23: a row ending 19:54 survived the v3 migration untouched because
            // the state was already v3. A cycle cannot end after now; such a row is
            // corrupt, so demote it and clamp it rather than let it re-alert until evicted.
            a[w].closed = rec[w].closed.slice(-MAX_CYCLES_PER_WINDOW).map(c =>
              (c.endedAt > Date.now() + 60_000)
                ? { ...c, endedAt: c.startedAt, complete: false, partialReason: 'repaired-future-endedAt' }
                : c);
          }
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
  accrue(name, { input, output }, at = this._now(), windows = ['ses', 'wk']) {
    if (!(input > 0) && !(output > 0)) return;
    const rec = this._rec(name);
    for (const w of windows) {
      // Open the window lazily if nothing is open (a mid-cycle boot or a window whose
      // reset stamp was never learned). startedAt is the accrual time then — the cycle
      // will be flagged partial by the caller if the boot gap warrants it (B1/B2).
      if (!rec[w].open) {
        const joined = this._joinedMidWindow && rec[w].closed.length === 0;
        rec[w].open = {
          startedAt: at, tokensSoFar: 0, lastAccrualAt: at,
          complete: !joined, disabledDuring: false,
          ...(joined ? { partialReason: 'joined-mid-window' } : {}),
        };
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
   *  cycle keeps its own book regardless of probe health). No-op if none open.
   *
   *  TANK (2026-08-25, owner-directed): the closed row records `finalUtilization` —
   *  the vendor's own fullness reading for the window at close. tank = tokens ÷ util
   *  is the CAPACITY of the plan, as distinct from the tokens we happened to deliver.
   *  Delivery measures demand; tank measures the plan. Both are recorded; the UI
   *  decides which to show. Recording happens on a best-effort basis here (the ledger
   *  keeps its own book — the caller passes the reading in, it does not poll). */
  closeCycle(name, window, endedAt = this._now(), { resetAt = null, finalUtilization = null } = {}) {
    const rec = this._accounts.get(name);
    if (!rec || !rec[window]?.open) return null;
    const open = rec[window].open;
    // ONE CYCLE PER BOUNDARY CLOSURE — the structural backstop for the two-closer race
    // (round-2 F1). If both closers observe the SAME reset stamp within the same
    // rollover moment, the second close's tokens are a straddling tail of that same
    // window, so they FOLD INTO that cycle instead of becoming a tiny fabricated second
    // one that drags every average down. A LATER window reporting the same numeric stamp
    // value (clock coincidence) is distinguished by endedAt. Pinned by I3.
    const prev = rec[window].closed[rec[window].closed.length - 1];
    // Same boundary within a few seconds, not just byte-identical stamps: the two
    // closers can observe one rollover through slightly different stamps (jitter), and
    // an exact-match-only fold then admitted a 0.2-minute sliver as its own cycle.
    const sameBoundary = resetAt != null && prev
      && Math.abs((prev.resetAt ?? prev.endedAt) - resetAt) <= SAME_BOUNDARY_MS
      && Math.abs(prev.endedAt - endedAt) <= SAME_BOUNDARY_MS;
    if (sameBoundary && open.complete && !open.disabledDuring) {
      // Fold ONLY a complete tail: folding a partial/disabled tail would flip the
      // flags on the prior legitimate observation and ERASE it from the averages
      // (round 3, RT3-2) — strictly worse than leaving a tiny excluded cycle.
      // The fold ALSO takes the tail's tank reading if the prior row lacks one —
      // same boundary, same window, so the later reading is simply fresher.
      prev.tokens += open.tokensSoFar;
      if (prev.finalUtilization == null && finalUtilization != null) prev.finalUtilization = finalUtilization;
      rec[window].open = null;
      return prev;
    }
    rec[window].closed.push({
      startedAt: open.startedAt,
      endedAt,
      tokens: open.tokensSoFar,
      complete: open.complete,
      disabledDuring: open.disabledDuring,
      ...(open.partialReason ? { partialReason: open.partialReason } : {}),
      ...(finalUtilization != null ? { finalUtilization } : {}),
      // Carried onto the closed row because tankStats needs it: a cycle observed from
      // its window START yields an EXACT tank; one we joined late yields a lower bound
      // (we only counted the tokens that flowed through maxpool, while the vendor's
      // percentage counts everything). Dropping it here made every tank read "bounded".
      ...(open.windowStartedAt != null ? { windowStartedAt: open.windowStartedAt } : {}),
      resetAt,
    });
    if (rec[window].closed.length > MAX_CYCLES_PER_WINDOW) rec[window].closed.shift();
    rec[window].open = null;
    return rec[window].closed[rec[window].closed.length - 1];
  }

  /**
   * ESTIMATED window capacity from live utilization: tokens observed in the OPEN
   * cycle ÷ the vendor's own fullness fraction (0..1). A window at 96% holding 812k
   * tokens implies a ~846k tank — no completed cycle needed. This is the same math the
   * user does in their head ("if 10% took A tokens, 100% is A×10") and it makes the
   * page useful from minute one, while completed cycles remain the precise column.
   *
   * Returns { tokens, utilization, fresh } or null when no estimate exists.
   *   null cases — utilization 0/unknown (0÷0), no accrual yet, or util ≥ 1 (the
   *   account is throttled; the fraction says nothing about the tank size).
   * `fresh` = the utilization reading and the accrual are from the same window
   * (utilization refreshes on probe/header; the open cycle closes at the boundary —
   * a stale util from the PREVIOUS window silently understates the estimate).
   */
  estimateFromUtilization(name, window, utilization) {
    if (!(utilization > 0) || !(utilization < 1)) return null;
    const open = this.openCycle(name, window);
    if (!open || !(open.tokensSoFar > 0)) return null;

    // DELTA METHOD (preferred). The absolute form (tokens ÷ utilization) silently
    // assumes we watched the WHOLE window — false whenever the ledger joined late (a
    // restart, a migration, a new account). Measured 2026-08-24: all four weekly
    // estimates joined 8.9-95h into their window, so every one understated the tank,
    // max@dubner.io by ~2x.
    //
    // Between two readings the tank is invariant, so pre-join usage cancels:
    //     tank = (tokens observed between them) / (u2 - u1)
    // No assumption about what happened before we started counting. Requires a rising
    // utilization AND tokens accrued across the same span; falls back to absolute when
    // we genuinely did watch from the start.
    const mark = this._utilMarks?.get(`${name}:${window}`);
    if (mark && utilization > mark.utilization) {
      const deltaTokens = open.tokensSoFar - mark.tokensSoFar;
      const deltaUtil = utilization - mark.utilization;
      // A meaningful denominator only: a 0.5pp move on a coarse-rounded percentage
      // (vendors report whole percents) turns rounding noise into a 200x multiplier.
      if (deltaTokens > 0 && deltaUtil >= 0.02) {
        return {
          tokens: Math.round(deltaTokens / deltaUtil),
          utilization, fresh: true, method: 'delta',
          basis: { deltaTokens, deltaUtil },
        };
      }
    }
    // Fresh = we can prove the reading and the accrual describe the SAME window: the
    // reading arrived after the open cycle began. A reading that predates the cycle (or
    // was never noted at all) describes the previous window — mark it and let the UI
    // caveat it, never silently trust it.
    const fresh = this._utilObservedAt > 0 && open.startedAt != null && this._utilObservedAt >= open.startedAt;
    // ABSOLUTE fallback. Only a LOWER BOUND unless we observed the window from its very
    // start — flagged so the UI can say "≥" rather than present a floor as the answer.
    const wholeWindow = open.startedAt != null && open.windowStartedAt != null
      && open.startedAt <= open.windowStartedAt + 60_000;
    return {
      tokens: Math.round(open.tokensSoFar / utilization),
      utilization, fresh, method: 'absolute', lowerBound: !wholeWindow,
    };
  }

  /** Record when a utilization reading arrived, so estimateFromUtilization can tell
   *  same-window freshness from a stale previous-window reading. */
  noteUtilizationObserved(at = this._now(), marks = null) {
    this._utilObservedAt = at;
    // Snapshot (utilization, tokensSoFar) per account+window so the NEXT reading can be
    // differenced against it. `marks` is [{name, window, utilization}] from the caller,
    // which owns the per-account-type quota fields.
    if (!marks) return;
    this._utilMarks = this._utilMarks || new Map();
    for (const m of marks) {
      if (!(m.utilization >= 0) || !(m.utilization < 1)) continue;
      const open = this.openCycle(m.name, m.window);
      if (!open) continue;
      const key = `${m.name}:${m.window}`;
      const prev = this._utilMarks.get(key);
      // Keep the OLDEST usable mark within this cycle: a wider span means a larger
      // denominator and less rounding sensitivity. Reset when the cycle rolls.
      if (!prev || prev.cycleStartedAt !== open.startedAt || m.utilization < prev.utilization) {
        this._utilMarks.set(key, {
          utilization: m.utilization, tokensSoFar: open.tokensSoFar,
          cycleStartedAt: open.startedAt, at,
        });
      }
    }
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** The columns the TUI renders: last, prev, prev1, avg3, avg10, allTime — over
   *  COMPLETE, not-disabled cycles only (D4/D5: partial and operator-disabled cycles
   *  are observations, not capacity). */
  windowStats(name, window) {
    const rec = this._accounts.get(name);
    // READ-TIME FLOOR. A cycle marked complete + never-disabled but spanning far less
    // than its window is junk from a writer bug — the live ledger held a 0.5-second /
    // 588-token "cycle" (clock-close and stamp-advance racing at one boundary, the fold
    // refused on an endedAt mismatch) and it dragged this account's Avg3 down ~188k.
    // Unlike the WRITE-time floor I tried first (reverted: it punished accounts that
    // were merely idle early in their window), at read time a genuinely short cycle is
    // already flagged complete:false by the writer — so a complete sub-floor cycle is
    // definitionally corrupt, never a real observation.
    const floor = (this._readFloorOverride ?? READ_FLOOR_MS)[window] ?? 0;
    // >= floor, with a 1s tolerance for the accrue-vs-close clock race (an accrue can
    // stamp Date.now() a tick AFTER the close computed its boundary, making a 0-span
    // cycle read as -1ms — found by debugging a D2 failure that only reproduced in-file).
    const closed = (rec?.[window]?.closed || []).filter(c =>
      c.complete && !c.disabledDuring && (c.endedAt - c.startedAt) >= floor - 1_000);
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
  /** TANK STATS — the CAPACITY of the plan, from the owner's own formula:
   *  tank = tokens delivered ÷ utilization at close, per cycle, averaged across
   *  cycles (2026-08-25, owner-directed). This measures the plan, not the demand:
   *  a cycle that delivered 812k at 96% and one that delivered 51k at 6% both say
   *  "~846k tank". Delivered-only averages (windowStats) measure demand and stay
   *  available separately.
   *
   *  Guards, because the raw formula lies in two ways:
   *  - We only count tokens that flowed THROUGH maxpool; a cycle whose vendor util
   *    includes spend we never saw (joined mid-window, or usage outside the proxy)
   *    yields a tank ≥ the truth but not equal to it. Only a cycle observed from its
   *    window start is exact; later ones are marked `lowerBound`.
   *  - Vendors report whole percents. At 3% full, 1pp of rounding = 33% error, so a
   *    reading below MIN_UTIL is excluded (rounding-dominated) rather than folded
   *    into the average as fake precision.
   *  Returns { avg, exact, n, bounded, last } or null when no usable readings. */
  tankStats(name, window) {
    const rec = this._accounts.get(name);
    const floor = (this._readFloorOverride ?? READ_FLOOR_MS)[window] ?? 0;
    const closed = (rec?.[window]?.closed || []).filter(c =>
      c.complete && !c.disabledDuring && (c.endedAt - c.startedAt) >= floor - 1_000);
    // PHYSICAL FLOOR: a tank can never be smaller than the most tokens ever
    // delivered in one complete window — every token we count is a vendor token
    // (C ≤ V ≤ tank), so maxDelivered ≤ tank is an invariant, not a heuristic.
    // A reading implying a smaller tank is contaminated: the vendor % counted
    // spend maxpool never saw (usage outside the proxy — an account also used
    // directly), or the reading was stale. Measured live 2026-08-26: a window
    // that delivered 497k at a reported "95% full" implied a 523k tank while an
    // earlier window of the SAME account had delivered 1.53M — impossible, and
    // the understated reading silently dragged the average down 3.6x.
    // CLAMP, never discard: the contaminated reading is still a real lower bound
    // (the tank is at least the tokens we saw), so it joins the average AT the
    // floor rather than being thrown away — discarding left an account whose
    // every reading was contaminated with NOTHING to show. After a plan
    // downgrade the floor over-states until old cycles age out — conservative.
    const maxDelivered = closed.reduce((m, c) => Math.max(m, c.tokens), 0);
    const usable = closed.filter(c =>
      Number.isFinite(c.finalUtilization) && c.finalUtilization >= TANK_MIN_UTIL);
    if (!usable.length) return null;
    let sum = 0, exact = 0, bounded = 0;
    for (const c of usable) {
      const observedFromStart = c.startedAt != null && c.windowStartedAt != null
        && c.startedAt <= c.windowStartedAt + 60_000;
      sum += Math.max(c.tokens / c.finalUtilization, maxDelivered);
      if (observedFromStart) exact++; else bounded++;
    }
    const last = usable[usable.length - 1];
    return {
      avg: Math.round(sum / usable.length),
      exact, bounded,
      n: usable.length,
      last: Math.round(last.tokens / last.finalUtilization),
      lowerBound: bounded > 0 && exact === 0,
    };
  }

  rollingThroughput(name, days = 7) {
    const rec = this._accounts.get(name);
    if (!rec) return { tokens: 0, partial: false };
    // The window is anchored on the ledger's OWN clock — the last `days` CALENDAR days
    // ending today. An earlier "latest recorded day" anchor reported a weeks-old window
    // as if it were current (idle GLM fallback showed a stale 25M "7d volume" with no
    // disclosure — red-team round 2, F2). Now: idle → 0, honestly.
    const today = new Date(this._now()).toISOString().slice(0, 10);
    const cutoff = this._utcDayMinus(today, Math.min(days - 1, MAX_DAY_BUCKETS - 1));
    let tokens = 0, partial = false;
    for (const [d, v] of Object.entries(rec.days)) {
      if (d >= cutoff && d <= today) { tokens += v.tokens; if (v.partial) partial = true; }
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
