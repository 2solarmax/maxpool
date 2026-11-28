/* Adapted from TeamClaude v1.1.30 (KarpelesLab).

MIT License

Copyright (c) 2026 KarpelesLab

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// Codex rate-limit headers.
//
// A Codex response carries its quota the way Anthropic does, just under a
// different spelling. The shape observed on a live response (values here are
// illustrative):
//
//   x-codex-primary-used-percent: 42
//   x-codex-primary-window-minutes: 10080
//   x-codex-primary-reset-at: <epoch seconds>
//   x-codex-secondary-used-percent: 0
//   x-codex-secondary-window-minutes: 0
//   x-codex-<name>-primary-used-percent: 0
//   x-codex-<name>-primary-window-minutes: 300
//   x-codex-<name>-secondary-window-minutes: 10080
//   x-codex-<name>-limit-name: <model family>
//
// Two things follow from that shape.
//
// First, limits arrive in FAMILIES: an unnamed one that is the account-wide
// limit, and named ones (carrying `-limit-name`) that are model-scoped — the
// direct counterpart of Anthropic's `7d_oi` Fable bucket.
//
// Second, `primary` and `secondary` are positions, not durations. The
// account-wide family above puts the 7-day window in `primary` while the
// model-scoped family puts a 5-hour window there. So windows are classified by
// their stated `window-minutes`, never by position — reading `primary` as
// "the 5h bucket" would file a weekly reading as a session one and rotate on
// the wrong number.

/** Window durations we recognise, in minutes, with a tolerance for rounding. */
const FIVE_HOUR_MINUTES = 300;
const SEVEN_DAY_MINUTES = 10080;
const WINDOW_TOLERANCE = 0.1;

const near = (value, target) => Math.abs(value - target) <= target * WINDOW_TOLERANCE;

/**
 * The bucket a window of this many minutes belongs to, or null for any other
 * length — a monthly or hourly window is neither, and is dropped rather than
 * filed under the nearest one.
 *
 * @param {number} minutes
 * @returns {'fiveHour'|'weekly'|null}
 */
export function windowBucket(minutes) {
  return near(minutes, FIVE_HOUR_MINUTES) ? 'fiveHour'
    : near(minutes, SEVEN_DAY_MINUTES) ? 'weekly'
      : null;
}

const HEADER_RE = /^x-codex-(?:(.+)-)?(primary|secondary)-(used-percent|window-minutes|reset-at)$/;
const LIMIT_NAME_RE = /^x-codex-(.+)-limit-name$/;

/**
 * Group `x-codex-*` headers into families keyed by slug ('' for the
 * account-wide family), each holding its primary/secondary window readings.
 */
function collectFamilies(headers) {
  const families = new Map();
  const family = (slug) => {
    if (!families.has(slug)) families.set(slug, { slug, name: null, windows: {} });
    return families.get(slug);
  };

  for (const [rawKey, rawValue] of (typeof headers?.entries === 'function' ? headers.entries() : Object.entries(headers || {}))) {
    const key = rawKey.toLowerCase();
    const value = String(rawValue ?? '').trim();
    if (value === '') continue;

    const named = LIMIT_NAME_RE.exec(key);
    if (named) { family(named[1]).name = value; continue; }

    const m = HEADER_RE.exec(key);
    if (!m) continue;
    const [, slug = '', position, field] = m;
    const w = (family(slug).windows[position] ??= {});
    if (field === 'used-percent') w.usedPercent = Number(value);
    else if (field === 'window-minutes') w.windowMinutes = Number(value);
    else w.resetAt = Number(value);
  }
  return families;
}

/**
 * One window reading: utilization as a 0-1 fraction, reset as ms epoch or null.
 *
 * @typedef {{utilization: number, resetAt: number|null}} QuotaWindow
 */

/**
 * Turn one family's windows into `{ fiveHour, weekly }` readings, keyed by the
 * window's own duration rather than its primary/secondary position.
 *
 * A window with no `window-minutes`, a zero duration, or an unparseable
 * utilization is dropped: a zeroed window is how this API says "not
 * applicable", and treating that as 0% used would look like full headroom.
 *
 * @param {Record<string, {usedPercent?: number, windowMinutes?: number, resetAt?: number}>} windows
 * @returns {{fiveHour?: QuotaWindow, weekly?: QuotaWindow}}
 */
function classify(windows) {
  /** @type {{fiveHour?: QuotaWindow, weekly?: QuotaWindow}} */
  const out = {};
  for (const w of Object.values(windows)) {
    const minutes = Number(w.windowMinutes);
    const percent = Number(w.usedPercent);
    if (!Number.isFinite(minutes) || minutes <= 0) continue;
    if (!Number.isFinite(percent) || percent < 0) continue;

    const bucket = windowBucket(minutes);
    if (!bucket) continue;

    out[bucket] = {
      // Anthropic reports utilization as a 0-1 fraction and the rest of the
      // manager compares against `switchThreshold` in those units, so convert
      // here rather than teaching every consumer about percentages.
      utilization: percent / 100,
      // Epoch seconds upstream, milliseconds everywhere in this codebase.
      resetAt: Number.isFinite(w.resetAt) && w.resetAt > 0 ? w.resetAt * 1000 : null,
    };
  }
  return out;
}

/**
 * A parsed reading: the fields `account.quota` already uses, each present only
 * when the headers stated it.
 *
 * @typedef {object} CodexQuota
 * @property {number} [unified5h] Session-window utilization, 0-1.
 * @property {number} [unified5hReset] When that window resets, ms epoch.
 * @property {number} [unified7d] Weekly-window utilization, 0-1.
 * @property {number} [unified7dReset] When that window resets, ms epoch.
 * @property {{slug: string, name: string, utilization: number, resetAt: number|null}[]} [modelFiveHourBuckets] Model-scoped session buckets.
 * @property {{slug: string, name: string, utilization: number, resetAt: number|null}[]} [modelBuckets] Model-scoped weekly buckets.
 */

/**
 * Parse Codex rate-limit headers into the fields `account.quota` already uses.
 *
 * Returns only what the headers actually stated, so a caller can assign over
 * an existing quota without blanking readings this response did not mention.
 * An empty object means "this response carried no quota", which is normal:
 * the catalog fetch (`/models`) has none.
 *
 * @returns {CodexQuota}
 */
export function parseCodexQuota(headers) {
  const families = collectFamilies(headers);
  /** @type {CodexQuota} */
  const quota = {};

  const account = classify(families.get('')?.windows || {});
  if (account.fiveHour) {
    quota.unified5h = account.fiveHour.utilization;
    if (account.fiveHour.resetAt) quota.unified5hReset = account.fiveHour.resetAt;
  }
  if (account.weekly) {
    quota.unified7d = account.weekly.utilization;
    if (account.weekly.resetAt) quota.unified7dReset = account.weekly.resetAt;
  }

  for (const family of families.values()) {
    if (!family.slug) continue;
    const { fiveHour, weekly } = classify(family.windows);
    const identity = { slug: family.slug, name: family.name || family.slug };
    if (fiveHour) (quota.modelFiveHourBuckets ??= []).push({ ...identity, ...fiveHour });
    if (weekly) (quota.modelBuckets ??= []).push({ ...identity, ...weekly });
  }

  return quota;
}

/**
 * Is a window at or past its limit?
 *
 * Readings are 0-1 fractions here, and the comparison is `>=` because upstream
 * keeps counting once a window is past its limit: 104% arrives as 1.04. A
 * window the headers did not state is not spent — `classify` has already
 * dropped the unparseable and the zeroed.
 *
 * @param {number} [utilization]
 */
const isSpent = (utilization) => utilization != null && utilization >= 1;

/**
 * Which windows these headers report as spent — at or past their limit. Empty
 * when none are, including when the response carried no Codex quota at all.
 *
 * Anthropic names a spent bucket outright, as `…-status: rejected`. This API
 * publishes no status at all: it reports how much of each window is gone, and a
 * window at its limit is the same fact in the other spelling. That distinction
 * is what a 429 handler needs, because a spent window is durable — the account
 * cannot serve again until the window resets, so waiting out `retry-after` and
 * asking the SAME account again is futile, however momentary the 429 looked.
 *
 * Bare labels are account-wide. Named labels identify the independent five-hour
 * or weekly meter. Seeing that meter on a response does not bind unrelated models.
 *
 * @param {Record<string, string>} headers Rate-limit headers from the response.
 * @returns {string[]} One label per spent window, e.g. `['weekly']`.
 */
export function codexSpentWindows(headers) {
  const quota = parseCodexQuota(headers);
  const spent = [];
  if (isSpent(quota.unified5h)) spent.push('5h');
  if (isSpent(quota.unified7d)) spent.push('weekly');
  for (const bucket of quota.modelFiveHourBuckets ?? []) {
    if (isSpent(bucket.utilization)) spent.push(`${bucket.name} 5h`);
  }
  for (const bucket of quota.modelBuckets ?? []) {
    if (isSpent(bucket.utilization)) spent.push(`${bucket.name} weekly`);
  }
  return spent;
}

/**
 * Is this `codexSpentWindows` label a window the whole account shares?
 *
 * A model-scoped bucket always includes its name and duration, so it cannot
 * collide with the two bare labels. The scope matters to the 429 handler: a
 * spent account-wide window refuses every request, so the account is held; a
 * spent model bucket refuses one family only, and holding the account for it
 * would park a subscription that still serves every other model.
 *
 * @param {string} label One label from `codexSpentWindows`.
 */
export const isAccountWideCodexWindow = (label) => label === '5h' || label === 'weekly';

/** The subscription plan upstream reports, for status output. Null when absent. */
export function parseCodexPlanType(headers) {
  const value = typeof headers?.get === 'function' ? headers.get('x-codex-plan-type') : headers?.['x-codex-plan-type'];
  return value ? String(value).trim() || null : null;
}

/**
 * The limit that metered this response, from `x-codex-active-limit`. Null when
 * absent.
 *
 * Upstream already spells it the way the usage probe keys `codexModelBuckets`,
 * so it is kept as sent: a live Pro account answered `premium` for every model,
 * and a Pro Lite account answered `base_model_inference` for `gpt-reserve`, the
 * key its probe files the `gpt-reserve` bucket under.
 *
 * @param {Record<string, string>} headers Rate-limit headers from the response.
 * @returns {string|null}
 */
export function parseCodexActiveLimit(headers) {
  const value = typeof headers?.get === 'function' ? headers.get('x-codex-active-limit') : headers?.['x-codex-active-limit'];
  return value ? String(value).trim().toLowerCase() || null : null;
}

/**
 * A named reading is evidence for this request only if it matches its active
 * meter. Headers often advertise other families too. If the active bucket is
 * absent, use the ordinary 429 retry hint instead of another family's reset.
 */
export function codexRateLimit(headers, model, now = Date.now(), knownLimit = null) {
  const quota = parseCodexQuota(headers);
  const sessionSpent = isSpent(quota.unified5h);
  const weeklySpent = isSpent(quota.unified7d);
  const active = parseCodexActiveLimit(headers) || knownLimit;
  const matches = bucket => isSpent(bucket.utilization)
    && (active ? bucket.slug === active : bucket.slug === model || bucket.name === model);
  const session = quota.modelFiveHourBuckets?.find(matches);
  const weekly = quota.modelBuckets?.find(matches);
  const scoped = !sessionSpent && !weeklySpent && (weekly || session);
  // A longer named reset must never lengthen a genuine account-wide cooldown.
  const resetAt = scoped ? Math.max(session?.resetAt || 0, weekly?.resetAt || 0)
    : Math.max(sessionSpent ? quota.unified5hReset || 0 : 0, weeklySpent ? quota.unified7dReset || 0 : 0);
  return {
    scope: 'account',
    modelScope: scoped ? scoped.slug : null,
    ...(scoped ? { modelWindow: weekly && (!session || (weekly.resetAt || 0) >= (session.resetAt || 0)) ? 'weekly' : '5h' } : {}),
    retryAfter: resetAt > now ? Math.ceil((resetAt - now) / 1000) : 0,
  };
}

/** Read only the refused account's shared weekly meter, never a named or session limit. */
export function codexWeeklyRefusal(headers, limit) {
  if (!limit || limit.modelScope) return null;
  const { unified7d, unified5h } = parseCodexQuota(headers);
  return unified7d >= 1 || (unified7d >= 0.999 && !(unified5h >= 0.999))
    ? { window: 'weekly', weeklyUtil: unified7d } : null;
}
