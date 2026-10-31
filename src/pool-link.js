/**
 * Team-pool link — one remote maxpool appearing as a single routable account
 * inside a local pool (owner decision D8, 2026-10-29).
 *
 * The remote pool is configured as `pools: [{ name, url, keySecret? | key? }]`
 * in the local config. This module OWNS three things:
 *
 * 1. Remote status polling (fetchRemoteStatus): GET <url>/maxpool/status with
 *    the person's key. Refreshed on a slow interval (default 30s). The result
 *    drives BOTH the routing score (an unavailable remote pool must not eat
 *    requests) and the TUI/screen rows (every remote account, labelled).
 * 2. Duplicate detection (computeDuplicates): identity of a remote account is
 *    (uuid) for Claude OAuth, (provider + credential fingerprint) for GLM/Kimi
 *    keys. A local account with the same identity is AUTO-BENCHED — never
 *    routed, never token-refreshed — and labelled "lives in team pool".
 *    Benching is computed here but APPLIED by AccountManager.applyPoolLinks so
 *    the same logic drives eligibility + ensureTokenFresh + TUI.
 * 3. Hop marking (hopHeader): every forwarded request carries x-maxpool-hops
 *    so a downstream pool can refuse a loop (A→B→A) instead of hanging.
 */
import { createHash } from 'node:crypto';

export const HOP_HEADER = 'x-maxpool-hops';
export const MAX_HOPS = 2;

/** Fingerprint a credential for duplicate matching WITHOUT exposing it.
 *  Same shape as the TUI's token fingerprints (first chars of a sha). */
export function credentialFp(credential) {
  if (!credential) return null;
  return createHash('sha256').update(String(credential)).digest('hex').slice(0, 12);
}

/** Stable identity of an account for duplicate matching. Claude OAuth →
 *  accountUuid; provider key → provider + key fingerprint. null = no identity
 *  (an unnamed apikey account can't be matched — it never benches anything). */
export function accountIdentity(account) {
  if (!account) return null;
  if (account.type === 'oauth') {
    return account.accountUuid ? `uuid:${account.accountUuid}` : null;
  }
  if (account.type === 'provider' && account.provider && account.credential) {
    return `key:${account.provider}:${credentialFp(account.credential)}`;
  }
  return null;
}

/** Identity map from a REMOTE pool's status JSON (key-gated /maxpool/status):
 *  { accounts: [{name,type,provider,accountUuid,enabled,...}], callers, ... }.
 *  Provider rows don't carry credentials — the remote pool exports a
 *  keyFingerprint per provider account so links can match without secrets. */
export function remoteIdentities(status) {
  const out = new Map();
  if (!status || !Array.isArray(status.accounts)) return out;
  for (const a of status.accounts) {
    if (a.enabled === false) continue; // a benched remote row doesn't bench the local copy
    let id = null;
    if (a.type === 'oauth' && a.accountUuid) id = `uuid:${a.accountUuid}`;
    else if (a.type === 'provider' && a.keyFingerprint) id = `key:${a.provider}:${a.keyFingerprint}`;
    if (id) out.set(id, { name: a.name, provider: a.provider, type: a.type });
  }
  return out;
}

/** Given local accounts and remote identities, return the local indexes that
 *  must be benched (duplicates) — { index, remoteName }. Pure: no mutation. */
export function computeDuplicates(accounts, remoteIdentitiesMap) {
  const out = [];
  if (!remoteIdentitiesMap || remoteIdentitiesMap.size === 0) return out;
  for (const a of accounts) {
    const id = accountIdentity(a);
    const hit = id ? remoteIdentitiesMap.get(id) : null;
    if (hit) out.push({ index: a.index, identity: id, remoteName: hit.name, provider: hit.provider });
  }
  return out;
}

/** Parse/step the hop header. Returns the new value for the OUTGOING request,
 *  or null when forwarding must be refused (loop). */
export function nextHopCount(headerValue) {
  const n = Number.parseInt(String(headerValue ?? ''), 10);
  const hops = Number.isFinite(n) && n >= 0 ? n : 0;
  return hops + 1 <= MAX_HOPS ? hops + 1 : null;
}

/** Fetch a remote pool's status. Returns { ok, status, json, error, at }.
 *  Never throws; a network failure is a normal condition (remote down),
 *  surfaced via ok:false so the caller can bench the link account. */
export async function fetchRemoteStatus(url, key, { fetchFn = fetch, timeoutMs = 10_000, now = Date.now } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${String(url).replace(/\/+$/, '')}/maxpool/status`, {
      headers: key ? { 'x-api-key': key } : {},
      signal: ctl.signal,
      cache: 'no-store',
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, json: null, error: 'key rejected', at: now() };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, json: null, error: `HTTP ${res.status}`, at: now() };
    }
    const json = await res.json();
    return { ok: true, status: 200, json, error: null, at: now() };
  } catch (err) {
    return { ok: false, status: null, json: null, error: err?.name === 'AbortError' ? 'timeout' : (err?.message || 'network error'), at: now() };
  } finally {
    clearTimeout(t);
  }
}

/** Aggregate a remote status into link health + capacity, for scoring.
 *  conservative: counts an account as spent when its weekly window is ≥95%,
 *  needs-login rows as unusable, and unknown quota as usable-but-unknown. */
export function summarizeRemote(status) {
  const accts = Array.isArray(status?.accounts) ? status.accounts.filter(a => a.enabled !== false) : [];
  const usable = accts.filter(a => {
    if (a.refreshDead) return false;
    const week = a.quota?.unified7d ?? a.quota?.providerWk ?? null;
    if (week != null && week >= 0.95) return false;
    return a.status !== 'error';
  });
  return {
    total: accts.length,
    usable: usable.length,
    needsLogin: accts.filter(a => a.refreshDead).length,
    callers: status?.callers || {},
  };
}

/** Test seam holder for PoolLink's timer (so tests don't leak handles). */
/** Strip terminal control characters (ESC + C0/C1 except tab) from a string that
 *  came off-box. Remote pool/account/caller names are rendered raw into the owner's
 *  terminal; an OSC 52 / CSI sequence there can rewrite the clipboard or blank the
 *  screen (security review 2026-10-31). Sanitized at INGRESS so no renderer has to. */
export function safeText(v) {
  if (typeof v !== 'string') return v;
  return v.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, '');
}

function sanitizeRemoteStatus(json) {
  if (!json || typeof json !== 'object') return json;
  for (const a of Array.isArray(json.accounts) ? json.accounts : []) {
    if (a && typeof a === 'object') { a.name = safeText(a.name); a.provider = safeText(a.provider); a.lastError = safeText(a.lastError); }
  }
  for (const p of Array.isArray(json.pools) ? json.pools : []) {
    if (p && typeof p === 'object') {
      p.name = safeText(p.name);
      for (const a of Array.isArray(p.accounts) ? p.accounts : []) if (a && typeof a === 'object') a.name = safeText(a.name);
    }
  }
  // Person names key both maps; the People page reads callerWindows.
  for (const field of ['callers', 'callerWindows']) {
    if (json[field] && typeof json[field] === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(json[field])) clean[safeText(k)] = v;
      json[field] = clean;
    }
  }
  return json;
}

/**
 * Boot-time single-writer guard (red-team 2026-10-31, blocking): a fresh PoolLink
 * starts with EMPTY identities, so a boot during a link outage saw ids={} and the
 * duplicate guard RELEASED every local copy — which then served and rotated tokens
 * the cloud still held (invalid_grant on the cloud row when the link returned; the
 * healthy local copy re-benched → account dark on BOTH sides). The last good
 * identity map is persisted in state.json; seedPoolIdentities() restores it at boot
 * so a link that hasn't polled yet still benches what it benched last run.
 */
const BOOT_IDS_TTL_MS = 14 * 24 * 3600 * 1000;  // stale beyond this → trust a fresh boot instead

export class PoolLink {
  constructor(def, deps = {}) {
    this.name = def.name;
    this.url = def.url;
    this.key = def.key || null;           // resolved by caller (secret) or literal
    this.keySecret = def.keySecret || null;
    this.intervalMs = Math.max(5_000, Number(def.intervalMs) || 30_000);
    this._fetchRemoteStatus = deps.fetchRemoteStatus || fetchRemoteStatus;
    this._now = deps.now || Date.now;
    this._timer = null;
    this._polling = false;
    // Last poll result. ok:false → link account benched + UI shows why.
    this.status = null;        // raw remote status JSON when ok
    this.lastError = null;
    this.lastOkAt = null;
    this.identities = new Map();
    this.summary = null;
  }

  /** Seed identities persisted from a previous run (state.json). Used until the
   *  first successful poll replaces them; old seeds (>14d) are ignored. */
  seedPoolIdentities(saved, savedAt) {
    if (!saved || typeof saved !== 'object') return;
    if (savedAt != null && Date.now() - savedAt > BOOT_IDS_TTL_MS) return;
    if (this.identities && this.identities.size > 0) return;   // a real poll already ran
    const m = new Map(Object.entries(saved).map(([k, v]) => [k, v]));
    if (m.size > 0) {
      this.identities = m;
      this._seedAt = savedAt ?? null;
    }
  }

  /** Identity map for persistence (plain object). */
  exportPoolIdentities() {
    return this.identities && this.identities.size > 0
      ? Object.fromEntries(this.identities) : null;
  }

  async poll() {
    if (this._polling) return; // never stack polls
    this._polling = true;
    try {
      const r = await this._fetchRemoteStatus(this.url, this.key);
      if (r.ok) {
        this.status = sanitizeRemoteStatus(r.json);
        this.lastOkAt = r.at;
        this.lastError = null;
        this.identities = remoteIdentities(r.json);
        this.summary = summarizeRemote(r.json);
      } else {
        // Keep the LAST good status for display, but mark the link degraded so
        // routing benches it and the UI names the error.
        this.lastError = r.error;
        this.summary = null;
      }
      return r;
    } finally {
      this._polling = false;
    }
  }

  start(onPoll) {
    this.stop();
    const tick = async () => {
      await this.poll();
      onPoll?.(this);
    };
    this._timer = setInterval(() => { tick().catch(() => {}); }, this.intervalMs);
    this._timer.unref?.();
    tick().catch(() => {}); // immediate first poll
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }
}
