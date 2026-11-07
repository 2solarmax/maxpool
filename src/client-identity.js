// One fixed client identity per upstream account (owner 2026-11-07, after two z.ai
// "usage risk" notices). Claude Code stamps every request with a per-INSTALL id
// (metadata.user_id → device_id) and its machine/runtime details (x-stainless-*,
// user-agent). Forwarded verbatim, one pooled account shows several installs on
// different machines alternating within seconds. Here every request leaving for an
// account carries that account's own stable device id and one machine profile, so
// each account presents as one laptop whoever sent the request. Sessions stay as
// sent (one person legitimately runs many sessions), and anything that is not a
// Claude Code request passes through untouched.
import { createHash } from 'node:crypto';

const FIXED_MACHINE = { 'x-stainless-os': 'MacOS', 'x-stainless-arch': 'arm64' };
const CC_UA = /^claude-cli\/\d+(?:\.\d+)*.*$/;

/** Stable per-account seed: the Claude account uuid, else the row name (NOT the
 *  provider key — z.ai key rotation would silently change the identity; the name
 *  survives rotation). Same account on two pools → same identity. */
function accountSeed(account) {
  if (account.accountUuid) return `uuid:${account.accountUuid}`;
  return `name:${account.name}`;
}

export function virtualDeviceId(account) {
  return createHash('sha256').update(`maxpool-device-v1:${accountSeed(account)}`).digest('hex');
}

// The metadata.user_id string Claude Code sends today is a JSON object as a STRING
// inside the outer JSON body: metadata.user_id = '{"device_id":"…","account_uuid":"…","session_id":"…"}'.
// We operate on the RAW body string, splicing only that inner string. The rest of
// the body is never parsed or re-serialized: JSON.parse→stringify corrupts integers
// above 2^53 (snowflake ids in tool results) and reformats exponents — byte drift
// the transcript does not forgive (red-team M1, 2026-11-07).

/** Find the escaped-string value of metadata.user_id in a raw JSON body.
 *  Returns { start, end, text } — the value's source range WITHOUT quotes and its
 *  unescaped text — or null. Scanning, not regex: real bodies vary spacing, and the
 *  value itself contains escapes a naive [^"]* would cut short. */
function scanMetadataUserId(bodyStr) {
  const key = bodyStr.indexOf('"user_id"');
  if (key === -1) return null;
  let i = bodyStr.indexOf(':', key + 9);
  if (i === -1) return null;
  i++;
  while (i < bodyStr.length && /\s/.test(bodyStr[i])) i++;
  if (bodyStr[i] === '{') {
    // Not a string (someone sent an object) — not ours to touch.
    return null;
  }
  if (bodyStr[i] !== '"') return null;
  i++;
  const start = i;
  while (i < bodyStr.length) {
    const c = bodyStr[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '"') break;
    i++;
  }
  if (i >= bodyStr.length) return null;
  let text;
  try { text = JSON.parse(`"${bodyStr.slice(start, i)}"`); } catch { return null; }
  return { start, end: i, text };
}

/** Build the account's replacement for the inner user_id string. */
function replacementUserId(account, originalText) {
  const device = virtualDeviceId(account);
  const acctUuid = account.type === 'oauth' && account.accountUuid ? account.accountUuid : '';
  let o = null;
  try { o = JSON.parse(originalText); } catch { return null; }
  if (!o || typeof o !== 'object' || !('device_id' in o) || !('session_id' in o)) return null;
  o.device_id = device;
  if ('account_uuid' in o) o.account_uuid = acctUuid;
  const next = JSON.stringify(o);
  return next === originalText ? null : next;
}

/** Rewrite metadata.user_id in a RAW request-body string. Returns the new body
 *  string, or null when nothing applies (not Claude Code's shape → untouched). */
export function rewriteMetadataUserIdRaw(bodyStr, account) {
  if (typeof bodyStr !== 'string' || !bodyStr.includes('"metadata"')) return null;
  const hit = scanMetadataUserId(bodyStr);
  if (!hit) return null;
  // Legacy flat form first: it is not JSON, so replacementUserId would reject it.
  const legacy = /^user_[0-9a-f]+_account_[^_]*_session_(.+)$/.exec(hit.text);
  const acctUuid = account.type === 'oauth' && account.accountUuid ? account.accountUuid : '';
  let next = legacy
    ? `user_${virtualDeviceId(account)}_account_${acctUuid}_session_${legacy[1]}`
    : replacementUserId(account, hit.text);
  if (next == null) return null;
  return bodyStr.slice(0, hit.start) + JSON.stringify(next).slice(1, -1) + bodyStr.slice(hit.end);
}

/** Normalize outgoing headers in place: one machine profile for every account (the
 *  per-account device id is what tells them apart). Client versions are left as
 *  sent: pinning to the "newest seen" made every account's version regress after a
 *  restart (red-team M2) and mid-retry UA flips — and several versions is what a
 *  normal auto-updating fleet of installs looks like anyway. Only touches requests
 *  that identify as Claude Code (user-agent claude-cli/…). */
export function normalizeClientHeaders(headers) {
  const uaKey = Object.keys(headers).find(k => k.toLowerCase() === 'user-agent');
  if (!uaKey || !CC_UA.test(String(headers[uaKey]))) return false;
  const lower = new Map(Object.keys(headers).map(k => [k.toLowerCase(), k]));
  for (const [h, v] of Object.entries(FIXED_MACHINE)) {
    if (lower.has(h)) headers[lower.get(h)] = v;
  }
  return true;
}
