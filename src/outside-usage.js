// OUTSIDE-USAGE DETECTOR (2026-10-27).
//
// The pool knows every request IT sends per account; z.ai counts EVERY request
// against the account, including ones sent by anyone else holding the same API
// key. From 2026-08-10 to 2026-10-26 an outside holder of max+1's key burned its
// weekly quota and all three reset cards (final week: 45,155 z.ai calls vs 1,682
// pool sends) and nothing in the pool could see it — the owner spotted it by
// accident. This module compares, per account, z.ai's hourly call counts (monitor
// API, zero-spend) with the pool's own hourly sends, over the complete hours the
// pool has been running, and flags when the outside share dominates.
//
// Why REQUESTS per HOUR, not tokens per day: the pool's token ledger excludes
// cached input that z.ai bills, so even a clean account reads ~200x apart on
// tokens (measured: glm1 3.43B z.ai vs 15.6M ledger). Request counts on a clean
// account agree to ~1.1x (glm1, 2026-10-23..27). Counting only hours the pool was
// up means a restart or an update cutover can never manufacture a false alarm.
//
// z.ai's monitor labels hours in UTC+8 ("2026-10-24 12:00" = 04:00Z).

export const OUTSIDE_FACTOR = 3;          // z.ai > 3x pool over the window = outside traffic
export const OUTSIDE_MIN_CALLS = 50;      // below this the window is noise
export const OUTSIDE_WINDOW_HOURS = 24;   // compare at most the last 24 complete hours
export const OUTSIDE_CHECK_MS = 60 * 60_000; // re-check each account hourly
const HOUR = 3600_000;
const ZAI_TZ_OFFSET_MS = 8 * HOUR;

export const hourFloor = (ms) => Math.floor(ms / HOUR) * HOUR;

/** z.ai model-usage `data` ({x_time:["YYYY-MM-DD HH:mm"...], modelCallCount:[...]})
 *  → Map(utcHourStartMs → calls). Unparseable rows are skipped. */
export function zaiHourlyCalls(data) {
  const out = new Map();
  const xs = data?.x_time, cs = data?.modelCallCount;
  if (!Array.isArray(xs) || !Array.isArray(cs)) return out;
  for (let i = 0; i < xs.length; i++) {
    const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(String(xs[i]));
    if (!m) continue;
    const labelAsUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    const utc = labelAsUtc - ZAI_TZ_OFFSET_MS;
    const c = Number(cs[i]) || 0;
    out.set(utc, (out.get(utc) || 0) + c);
  }
  return out;
}

/** Compare z.ai's and the pool's hourly counts over the complete hours in
 *  [max(poolUpSince ceiled to the next hour, now - window), floor(now)).
 *  Returns {hours, zaiCalls, poolCalls, outside, from, to}; hours=0 when no
 *  complete hour is comparable yet (then outside is always false). */
export function compareOutsideUsage(zaiHours, poolHours, { now, poolUpSince, factor = OUTSIDE_FACTOR, minCalls = OUTSIDE_MIN_CALLS, windowHours = OUTSIDE_WINDOW_HOURS } = {}) {
  const to = hourFloor(now);
  const upFrom = Math.ceil(poolUpSince / HOUR) * HOUR;   // first hour the pool saw in full
  const from = Math.max(upFrom, to - windowHours * HOUR);
  let zaiCalls = 0, poolCalls = 0, hours = 0;
  for (let h = from; h < to; h += HOUR) {
    hours++;
    zaiCalls += zaiHours?.get(h) || 0;
    poolCalls += poolHours?.get(h) || 0;
  }
  const outside = hours > 0 && zaiCalls >= minCalls && zaiCalls > poolCalls * factor;
  return { hours, zaiCalls, poolCalls, outside, from, to };
}
