/**
 * Claude banked usage-limit resets (internal program `cedar_ember`; the
 * session-only 1/week program is `juniper_tide` — deliberately NOT auto-claimed
 * here: it costs a scarce weekly slot for the least valuable window).
 *
 * Endpoints (same shape Claude Code itself uses; verified against the 2.1.285
 * binary and third-party implementations, 2026-09-30):
 *   GET  /api/oauth/usage?cedar_ember=1&skip_spend=1
 *        -> cedar_ember: { eligible, ineligible_reason, grants: [...],
 *           next_grant_id, cooldown_until, weekly_resets_at }
 *        Grant: { id, resets_total, resets_left, starts_at, ends_at, usable_now,
 *                 paused, use_requires_limit }
 *   GET  /api/oauth/profile -> organization uuids (organizations[].uuid)
 *   POST /api/organizations/{org}/reset_rate_limits
 *        { program:'cedar_ember', grant_id, request_id }
 *
 * CRITICAL: without a Claude Code User-Agent the usage endpoint answers
 * eligible:false, ineligible_reason:"surface" for EVERY token — the grants exist
 * but are invisible. Mirror the CLI's UA exactly.
 *
 * Envelope: claim returns HTTP 200 with success:false on failure; `already_used`
 * counts as success (idempotent) — request_id is the client's idempotency key.
 */
import { randomUUID } from 'node:crypto';

const USAGE_BASE = 'https://api.anthropic.com/api/oauth/usage';
const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const CLAIM_PATH = '/api/organizations';

function cliUserAgent() {
  // Match the installed CLI's version so server-side cli_version gating treats us
  // like the real client. Falls back to a known-good recent version.
  const v = process.env.MAXPOOL_CLAUDE_CLI_VERSION || '2.1.285';
  return `claude-cli/${v} (external, cli)`;
}

function headers(accessToken) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'User-Agent': cliUserAgent(),
    'Accept': 'application/json',
  };
}

/** Parse an ISO/epoch-ish timestamp into ms, or null. */
function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1e3;   // s vs ms heuristics
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

// Scope map (D1 + research Q5, from the Claude Code 2.1.322 client rule
// `clears.includes(L) || (L==='seven_day' && givesBackWeekly)`): which limit a
// `clears` key refills. An UNMAPPED key means "we don't know what this refills" —
// the grant is shown, never claimed, and never lifts a cap (fail closed; the
// October z.ai drift class — never invent scope from a name).
export const GRANT_SCOPE_BY_KEY = {
  seven_day: 'general',                 // refills the general weekly
  five_hour: 'session',                 // refills the session window only
  seven_day_overage_included: 'fable',  // model-scoped: refills the Fable weekly
};

/** One shared applicability answer (per D1): the limits this grant refills.
 *  Returns an array of scopes from {general, session, fable}; unknown/unmapped
 *  keys contribute NOTHING (fail closed), and `unknown` is never returned as a
 *  scope — a grant with only unmapped keys has appliesTo() = [] (display-only).
 *  A `gives_back_weekly` grant ALSO returns 'general' (its model reset returns
 *  that model's usage to the general weekly) — the client's own OR rule. */
export function appliesTo(grant) {
  if (!grant) return [];
  const out = new Set();
  for (const key of (Array.isArray(grant.clears) ? grant.clears : [])) {
    const scope = GRANT_SCOPE_BY_KEY[key];
    if (scope) out.add(scope);
  }
  if (grant.gives_back_weekly === true) out.add('general');
  return [...out];
}

// Process-wide: the first listing logs the raw grant KEY SET (keys only, never
// values) once, so a schema drift is visible without per-sweep spam. Set by
// listResetGrants on the first grants-bearing response.
let _loggedRawGrantKeys = false;

/** Normalize a cedar_ember grant. Drops malformed entries (the CLI does the same:
 *  "ignoring a malformed grant"). Keeps expired ones OUT unless resets remain and
 *  ends_at is still ahead — expired grants are display-only noise.
 *
 *  FAIL-CLOSED defaults (pre-mortem #11, 2026-11-10): the old normalizer INVENTED
 *  scope and usability from missing fields (clears → ['five_hour','seven_day'],
 *  usable_now → true). A missing `clears` is scope UNKNOWN: [] — shown, never
 *  claimed, never lifts a cap. Missing `gives_back_weekly` is false. Missing
 *  `usable_now` is false (a usable grant's listing always says so). */
export function normalizeGrant(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const g = raw.id != null ? raw : { ...raw, id: raw };   // tolerate id-less shapes
  const resetsTotal = Number(g.resets_total ?? g.resetsTotal);
  const resetsLeft = Number(g.resets_left ?? g.resetsLeft);
  if (!Number.isFinite(resetsTotal) || resetsTotal < 1) return null;
  // resets_left:0 = SPENT (live 2026-09-30: the opus55-launch grant on
  // max@gomokka.com shows resets_total:1, resets_left:0, usable_now:false — already
  // consumed at the Opus 5.5 launch). Keep it OUT of the claimable list; the LIST
  // still surfaces it so the TUI can show the spent history if wanted.
  if (!Number.isFinite(resetsLeft) || resetsLeft < 1) return null;
  const startsAt = toMs(g.starts_at ?? g.startsAt);
  const endsAt = toMs(g.ends_at ?? g.endsAt);
  return {
    id: g.id,
    label: g.label || null,
    resetsLeft, resetsTotal, startsAt, endsAt,
    // clears is the money field: [five_hour, seven_day, seven_day_overage_included]
    // (measured live, 2026-11-10). Missing → [] = scope unknown: display-only,
    // never claimed, never lifts a cap. Never assume both.
    clears: Array.isArray(g.clears) ? g.clears : [],
    givesBackWeekly: g.gives_back_weekly === true,
    blocking: g.blocking === true,
    unavailableReason: typeof g.unavailable_reason === 'string' ? g.unavailable_reason : null,
    percentUsed: Number.isFinite(Number(g.percent_used)) ? Number(g.percent_used) : null,
    // Fail closed: a grant the listing does not explicitly mark usable is NOT
    // claimable (pre-mortem #11). usable_now:false also fails here.
    usableNow: g.usable_now === true && (resetsLeft >= 1),
    paused: g.paused === true,
    requiresLimit: g.use_requires_limit !== false, // most grants only fire at the wall
    expired: endsAt != null && endsAt <= now,
  };
}

/** Log the raw grant key set once per process (drift visibility). Keys only. */
function _logRawGrantKeysOnce(ce, log = console.log) {
  if (_loggedRawGrantKeys) return;
  _loggedRawGrantKeys = true;
  const keys = new Set();
  for (const g of (Array.isArray(ce.grants) ? ce.grants : [])) {
    if (g && typeof g === 'object') for (const k of Object.keys(g)) keys.add(k);
  }
  try { log(`[reset-grant] cedar_ember grant keys: [${[...keys].sort().join(', ')}]`); } catch { /* log-only */ }
}

/** List this account's banked resets. Zero-spend read (skip_spend=1).
 *  Returns { grants: [], nextGrantId, cooldownUntil, eligible, reason } | { error }.
 *  `fetchImpl` is the test seam (never hits api.anthropic.com from tests). */
export async function listResetGrants(accessToken, { signal, fetchImpl = (u, o) => fetch(u, o) } = {}) {
  if (!accessToken) return { error: 'no token' };
  try {
    const res = await fetchImpl(`${USAGE_BASE}?cedar_ember=1&skip_spend=1`, {
      headers: headers(accessToken), signal,
    });
    if (res.status === 401) return { error: 'unauthorized' };
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const body = await res.json();
    const ce = body?.cedar_ember;
    if (!ce || typeof ce !== 'object') {
      // Not an error: most accounts simply aren't in the program.
      return { grants: [], nextGrantId: null, cooldownUntil: null, eligible: false, reason: 'not_offered' };
    }
    if (ce.eligible === false) {
      return { grants: [], nextGrantId: null, cooldownUntil: toMs(ce.cooldown_until ?? ce.cooldownUntil),
               eligible: false, reason: ce.ineligible_reason || 'ineligible' };
    }
    const now = Date.now();
    if (Array.isArray(ce.grants) && ce.grants.length) _logRawGrantKeysOnce(ce);
    const grants = (Array.isArray(ce.grants) ? ce.grants : []).map(g => normalizeGrant(g, now)).filter(Boolean);
    return {
      grants,
      nextGrantId: ce.next_grant_id ?? ce.nextGrantId ?? null,
      cooldownUntil: toMs(ce.cooldown_until ?? ce.cooldownUntil),
      eligible: true,
      reason: null,
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

// C6: org uuid cache — one profile GET per account per process (pre-mortem #6: a
// failing claim retried a profile GET + POST per sweep per account). Keyed by the
// account's credential fingerprint-free identity: the CALLER passes accountKey
// (the account name); the cache holds { key, org } so a caller with a different
// account name but same cache slot still refetches.
const _orgCache = new Map();   // accountKey -> org uuid

/** Claim one grant. The CLI never retries a claim on the wire; our request_id is
 *  random per CALL (server treats already_used as success), so a caller retry is
 *  safe but the id is not reused across distinct decisions. Returns
 *  { ok:true } | { ok:false, error, code }.
 *  `accountKey` (account name) caches the org uuid per account (C6): one profile
 *  GET per account per process. */
export async function claimResetGrant(accessToken, grantId, { signal, requestId, fetchImpl, accountKey } = {}) {
  if (!accessToken || !grantId) return { ok: false, error: 'missing args' };
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  try {
    let org = accountKey != null ? _orgCache.get(accountKey) : undefined;
    if (org == null) {
      const prof = await doFetch(PROFILE_URL, { headers: headers(accessToken), signal });
      if (!prof.ok) return { ok: false, error: `profile HTTP ${prof.status}` };
      const body = await prof.json();
      // The profile returns `organization` (SINGULAR object) — measured live on
      // maxim.krasnykh@gmail.com 2026-10-09: {account, organization, application}.
      // v1.24.0-12 read only the plural `organizations` array (null for personal
      // accounts), so EVERY cedar_ember claim on a personal account failed with
      // 'no oauth organization' while the account sat exhausted with a usable reset
      // (owner report: 'this account is exhausted but the reset is not being used').
      // Accept both shapes; singular wins when present.
      org = body?.organization?.uuid
        ?? (Array.isArray(body?.organizations) && body.organizations.length ? body.organizations[0].uuid : null);
      if (!org) return { ok: false, error: 'no oauth organization' };
      if (accountKey != null) _orgCache.set(accountKey, org);
    }

    const rid = requestId || randomUUID();
    const res = await doFetch(`https://api.anthropic.com${CLAIM_PATH}/${org}/reset_rate_limits`, {
      method: 'POST',
      headers: { ...headers(accessToken), 'Content-Type': 'application/json' },
      body: JSON.stringify({ program: 'cedar_ember', grant_id: grantId, request_id: rid }),
      signal,
    });
    const data = await res.json().catch(() => null);
    // Success shapes observed: {success:true} or result:"already_used" (idempotent).
    const okFlag = data?.success === true || data?.result === 'already_used';
    if (okFlag) return { ok: true, grantId, alreadyUsed: data?.result === 'already_used' };
    return { ok: false, error: data?.error?.message || JSON.stringify(data).slice(0, 200), code: data?.error?.type };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

/** Test seam: reset the once-per-process raw-key-set logger. */
export function _resetGrantKeyLogForTest() { _loggedRawGrantKeys = false; }
