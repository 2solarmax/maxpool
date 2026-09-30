/**
 * z.ai Quota Reset Cards — list + redeem, via the same API key the quota poller
 * already uses. Zero browser, zero captcha (the exact pain that motivated this:
 * ~6 provider accounts, each a manual web login with an aggressive captcha to
 * check for a card that usually isn't there).
 *
 * Endpoints (verified live 2026-09-30):
 *   GET  /api/biz/customer-package-reset/list?targetType=PERSONAL
 *        -> data.fiveHourResets[] / weekResets[], each {recordId, grantType,
 *           expireTime 'YYYY-MM-DD HH:mm:ss' (UTC), available}
 *   POST /api/biz/customer-package-reset/use
 *        body {recordId, targetType:'PERSONAL', resetType:'WEEK'|'FIVE_HOUR',
 *              requestId}  -> envelope; data echoes the recordId on success
 *
 * Semantics measured live:
 *   - a WEEKLY card ALSO refills the 5h window (z.ai docs) — never spend a weekly
 *     card on a 5h wall.
 *   - `requestId` is the idempotency key: a retry with the SAME id cannot burn a
 *     second card. We derive it deterministically from recordId so any retry of a
 *     failed redeem is automatically safe.
 *   - the envelope returns HTTP 200 with success:false on failure — always check
 *     the envelope, never the status code.
 *   - an unavailable/expired/foreign card returns code 400 "The specified reset
 *     attempt is unavailable. Refresh and try again".
 *   - invalid resetType vocabulary yields 400 "Unsupported reset type: X" (safe
 *     probe that cannot spend anything).
 */
import { createHash } from 'node:crypto';

const BASE = 'https://api.z.ai/api/biz/customer-package-reset';
const LIST_URL = `${BASE}/list?targetType=PERSONAL`;
const USE_URL = `${BASE}/use`;

/** 'YYYY-MM-DD HH:mm:ss' (z.ai has no timezone suffix; it is UTC) -> epoch ms. */
export function parseCardExpiry(s) {
  if (!s || typeof s !== 'string') return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

/** Normalize a raw card array -> [{recordId, expiresAt, expired}], available only. */
function normalizeCards(arr, now = Date.now()) {
  const out = [];
  for (const c of (Array.isArray(arr) ? arr : [])) {
    if (!c || c.available !== true) continue;
    const recordId = Number(c.recordId);
    if (!Number.isFinite(recordId)) continue;
    const expiresAt = parseCardExpiry(c.expireTime);
    out.push({ recordId, expiresAt, expired: expiresAt != null && expiresAt <= now });
  }
  // Soonest-expiring first — that's the one to spend first.
  out.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  return out;
}

/** List this account's available reset cards. Zero-spend read.
 *  Returns { fiveHour: [], weekly: [] } | { error }. */
export async function listResetCards(token, { signal } = {}) {
  if (!token) return { error: 'no token' };
  try {
    const res = await fetch(LIST_URL, {
      headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
      signal,
    });
    if (res.status === 401) return { error: 'unauthorized' };
    const data = await res.json();
    if (data?.code !== 200 || !data?.data) {
      return { error: `bad_envelope${data?.code != null ? ' code=' + data.code : ''}` };
    }
    const now = Date.now();
    return {
      fiveHour: normalizeCards(data.data.fiveHourResets, now),
      weekly: normalizeCards(data.data.weekResets, now),
      source: 'zai',
    };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/** Deterministic requestId for a card: retries of the SAME redeem are idempotent
 *  server-side, so a network blip mid-redeem can never double-spend. */
function requestIdFor(recordId) {
  const h = createHash('sha256').update(`maxpool-zai-card-${recordId}`).digest('hex').slice(0, 24);
  return `maxpool-${h}`;
}

/** Redeem one card. NEVER retries on the wire here (the idempotency key makes a
 *  caller-level retry safe). Returns { ok:true, recordId } | { ok:false, error, code }. */
export async function redeemResetCard(token, recordId, resetType, { signal } = {}) {
  if (resetType !== 'WEEK' && resetType !== 'FIVE_HOUR') {
    return { ok: false, error: `invalid resetType ${resetType}` };
  }
  if (!Number.isFinite(recordId)) return { ok: false, error: 'invalid recordId' };
  try {
    const res = await fetch(USE_URL, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        recordId, targetType: 'PERSONAL', resetType,
        requestId: requestIdFor(recordId),
      }),
      signal,
    });
    const data = await res.json().catch(() => null);
    if (data?.success === true && (data.code === 200 || data.code === 0)) {
      return { ok: true, recordId, data: data.data ?? null };
    }
    return {
      ok: false,
      error: data?.msg || `envelope code ${data?.code} (HTTP ${res.status})`,
      code: data?.code ?? null,
    };
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}
