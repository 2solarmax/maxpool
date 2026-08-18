/**
 * Peak-hour window evaluation — PURE, zero imports, zero deps.
 *
 * z.ai charges 50% of the standard credit rate OFF-peak; peak is full rate, so peak
 * spend costs 2x. Peak = Mon-Fri 14:00-18:00 SGT (UTC+8, no DST) = 06:00-10:00 UTC,
 * 20h of 168h. Kimi (Moonshot) publishes no peak multiplier — it ships with NO
 * window = never peak = unaffected.
 *
 * Design invariants (task-2026-08-18-maxpool-peak-hours-glm-governance):
 *   - UTC ONLY. days use Date#getUTCDay() numbering (0=Sun .. 6=Sat). No timezone
 *     math, no tz library — SGT has no DST so the fixed UTC window is exact year-round.
 *   - Start INCLUSIVE, end EXCLUSIVE: m >= start && m < end.
 *   - A day names the day the window STARTS. A wrapping window (end <= start) spans
 *     the UTC day boundary: segment A on each listed day, segment B on the NEXT day.
 *   - A MALFORMED window NEVER matches. The feature is on by default; a config typo
 *     must degrade to today's behaviour (never bench GLM), never to 24/7 de-preference.
 *   - Overlapping windows merge: endsAt is the LATEST matching end, so a hold never
 *     wakes into a second contiguous window.
 */

export const MINUTES_PER_DAY = 1440;
export const DEFAULT_PEAK_CAP = 0.5;

/** The shipped defaults. ONE literal, imported by config.js (fresh installs get it on
 *  disk) AND the loadConfig migration (existing installs inherit it at load). Never
 *  DEFAULT_SCHEDULER — see the task research for the probe that proved that placement
 *  makes the test suite time-dependent and is wiped by the shallow provider spread. */
export const DEFAULT_PEAK_PROVIDERS = {
  zai: {
    // The VENDOR's window, expressed in the vendor's own zone. z.ai states
    // Mon-Fri 14:00-18:00 SGT; pinning peakTimezone to Asia/Singapore means the
    // window tracks what z.ai actually bills no matter where the laptop thinks it
    // is, AND survives a DST change if the vendor ever restates it in a DST zone.
    //
    // USER-ADJUSTABLE (2026-08-18): both the hours and the zone are config. Set
    // `peakTimezone` to any IANA zone, or to null to follow the MACHINE's local
    // zone — the right choice if you'd rather reason in your own wall clock.
    // startMin/endMin are minutes-from-midnight IN THAT ZONE.
    peakTimezone: 'Asia/Singapore',
    peakWindows: [{ days: [1, 2, 3, 4, 5], startMin: 14 * 60, endMin: 18 * 60 }],
    peakCap: DEFAULT_PEAK_CAP,
    peakDepreference: true,
  },
  kimi: { peakWindows: [], peakCap: DEFAULT_PEAK_CAP, peakDepreference: true },
};

/** Validate + normalize one window row. Returns {days:Set, start, end} or null.
 *  null ⇒ this row never matches (see invariants). */
export function normalizePeakWindow(w) {
  if (!w || typeof w !== 'object') return null;
  // `startMin`/`endMin` are the current names (minutes-from-midnight in the window's
  // timezone). `startUtcMin`/`endUtcMin` are accepted as legacy aliases so a config
  // written before the timezone knob keeps working unchanged.
  const start = Number(w.startMin ?? w.startUtcMin);
  const end = Number(w.endMin ?? w.endUtcMin);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start < 0 || start >= MINUTES_PER_DAY) return null;   // start is a minute-of-day
  if (end <= 0 || end > MINUTES_PER_DAY) return null;        // end EXCLUSIVE; 1440 == midnight
  if (end === start) return null;                            // zero-length ⇒ never
  const days = Array.isArray(w.days)
    ? [...new Set(w.days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6))]
    : [];
  if (!days.length) return null;                             // no days ⇒ never, not "every day"
  return { days: new Set(days), start, end };
}

/** Wall-clock parts (weekday + minute-of-day) for `now` in an IANA timezone, using
 *  Node's built-in Intl — zero dependencies, and DST-correct by construction (the
 *  offset is resolved for THAT instant, not a fixed number).
 *
 *  `tz` resolution order, per the user requirement (2026-08-18):
 *    1. an explicit IANA zone in config (`peakTimezone`) — for a laptop whose clock
 *       is set to somewhere the user is not,
 *    2. else the MACHINE's local zone (the default: maxpool follows the laptop),
 *    3. else UTC.
 *  An invalid/unknown zone falls back to the machine zone rather than throwing —
 *  a typo must never take routing down.
 */
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const _dtfCache = new Map();

export function wallClockIn(now, tz) {
  const zone = tz || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  let dtf = _dtfCache.get(zone);
  if (!dtf) {
    try {
      dtf = new Intl.DateTimeFormat('en-US', {
        timeZone: zone, hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit',
      });
    } catch {
      // Unknown zone → machine local. Never throw from the routing hot path.
      dtf = new Intl.DateTimeFormat('en-US', { hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });
    }
    _dtfCache.set(zone, dtf);
  }
  const parts = Object.fromEntries(dtf.formatToParts(new Date(now)).map(p => [p.type, p.value]));
  const day = DAY_INDEX[parts.weekday] ?? 0;
  // hour '24' appears at midnight in some locales' hour12:false output — normalize.
  const hour = Number(parts.hour) % 24;
  return { day, min: hour * 60 + Number(parts.minute) };
}

/** Is `now` inside any window, and when does the peak end?
 *  @returns {{inPeak: boolean, endsAt: number|null}} endsAt is an ms epoch; null when
 *  not in peak. Pure in `now` — the caller injects it; no ambient clock reads here. */
export function peakWindowState(windows, now, tz = null) {
  if (!Array.isArray(windows) || !Number.isFinite(now)) return { inPeak: false, endsAt: null };
  // Normalize ONCE — both the match scan and the contiguity chain below read this.
  const norm = [];
  for (const raw of windows) {
    const w = normalizePeakWindow(raw);
    if (w) norm.push(w);
  }
  if (!norm.length) return { inPeak: false, endsAt: null };

  // Window times are WALL-CLOCK in `tz` — the config's `peakTimezone` when set, else the
  // MACHINE's own zone (2026-08-18 user requirement: follow the laptop by default, but
  // let the user pin a zone, because a laptop clock is often set to somewhere they aren't).
  // `endsAt` stays an absolute epoch, derived by projecting the remaining wall-clock
  // minutes from local midnight.
  const { day, min } = wallClockIn(now, tz);
  const midnightUtc = now - min * 60_000 - (now % 60_000);   // local midnight as an epoch
  const yesterday = (day + 6) % 7;
  let endsAt = null;
  const note = (mins) => {
    const t = midnightUtc + mins * 60_000;
    if (endsAt == null || t > endsAt) endsAt = t;
  };

  for (const w of norm) {
    const wraps = w.end < w.start;
    // Segment A — the window's own UTC day (its full length, or to midnight when wrapping).
    if (w.days.has(day)) {
      const segEnd = wraps ? MINUTES_PER_DAY : w.end;
      if (min >= w.start && min < segEnd) note(segEnd);
    }
    // Segment B — the spill onto the NEXT UTC day, for a wrapping window only.
    // Keyed on the START day (yesterday from now), so a Fri 22:00-02:00 window is
    // peak early Saturday but never early Sunday.
    if (wraps && w.days.has(yesterday) && min < w.end) note(w.end);
  }
  if (endsAt == null) return { inPeak: false, endsAt: null };
  // CONTIGUITY EXTENSION: a hold that wakes exactly at endsAt must not land inside a
  // FOLLOW-ON window. Extend endsAt across any window that starts at/before the
  // current end on the same day (chain until no extension). Simple O(n·k); n is tiny.
  let extended = true;
  while (extended) {
    extended = false;
    for (const w of norm) {
      if (!w.days.has(day) || w.end <= w.start) continue;   // wrapping windows never extend
      const curMin = (endsAt - midnightUtc) / 60_000;
      if (w.start <= curMin && w.end > curMin) {
        const t = midnightUtc + w.end * 60_000;
        if (t > endsAt) { endsAt = t; extended = true; }
      }
    }
  }
  return { inPeak: true, endsAt };
}

/** Merge shipped defaults into a provider's settings by key-PRESENCE (an explicit
 *  user value always survives; only an absent key inherits). CLONES — never mutates
 *  the input (the config object is reference-shared with the TUI persist path). */
export function mergePeakDefaults(providers, version) {
  if (Number(version) >= 1) return providers;   // already seeded — respect user edits
  const out = {};
  for (const key of Object.keys(providers || {})) out[key] = { ...(providers[key] || {}) };
  for (const [key, seed] of Object.entries(DEFAULT_PEAK_PROVIDERS)) {
    const existing = out[key] ||= {};
    // Fields come from the seed itself, so a new peak setting added to
    // DEFAULT_PEAK_PROVIDERS is migrated without editing a parallel list here.
    for (const field of Object.keys(seed)) {
      if (!(field in existing)) existing[field] = seed[field];
    }
  }
  return out;
}
