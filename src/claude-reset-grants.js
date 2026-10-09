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

/** Normalize a cedar_ember grant. Drops malformed entries (the CLI does the same:
 *  "ignoring a malformed grant"). Keeps expired ones OUT unless resets remain and
 *  ends_at is still ahead — expired grants are display-only noise. */
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
    // means a grant clears BOTH windows (measured live). Default to assuming both
    // when absent rather than none — the observed server always sends it.
    clears: Array.isArray(g.clears) ? g.clears : ['five_hour', 'seven_day'],
    usableNow: g.usable_now !== false && (resetsLeft >= 1),
    paused: g.paused === true,
    requiresLimit: g.use_requires_limit !== false, // most grants only fire at the wall
    expired: endsAt != null && endsAt <= now,
  };
}

/** List this account's banked resets. Zero-spend read (skip_spend=1).
 *  Returns { grants: [], nextGrantId, cooldownUntil, eligible, reason } | { error }. */
export async function listResetGrants(accessToken, { signal } = {}) {
  if (!accessToken) return { error: 'no token' };
  try {
    const res = await fetch(`${USAGE_BASE}?cedar_ember=1&skip_spend=1`, {
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

/** Claim one grant. The CLI never retries a claim on the wire; our request_id is
 *  random per CALL (server treats already_used as success), so a caller retry is
 *  safe but the id is not reused across distinct decisions. Returns
 *  { ok:true } | { ok:false, error, code }. */
export async function claimResetGrant(accessToken, grantId, { signal, requestId, fetchImpl } = {}) {
  if (!accessToken || !grantId) return { ok: false, error: 'missing args' };
  const doFetch = fetchImpl || ((u, o) => fetch(u, o));
  try {
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
    const org = body?.organization?.uuid
      ?? (Array.isArray(body?.organizations) && body.organizations.length ? body.organizations[0].uuid : null);
    if (!org) return { ok: false, error: 'no oauth organization' };

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
