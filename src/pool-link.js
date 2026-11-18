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
import http from 'node:http';
import https from 'node:https';

export const HOP_HEADER = 'x-maxpool-hops';
export const MAX_HOPS = 2;

/** Fingerprint a credential for duplicate matching WITHOUT exposing it.
 *  Same shape as the TUI's token fingerprints (first chars of a sha). */
export function credentialFp(credential) {
  if (!credential) return null;
  return createHash('sha256').update(String(credential)).digest('hex').slice(0, 12);
}

/** Stable identity of an account for duplicate matching. Claude OAuth →
 *  accountUuid (+ organizationUuid when known); provider key → provider + key
 *  fingerprint. null = no identity (an unnamed apikey account can't be matched —
 *  it never benches anything). */
export function accountIdentity(account) {
  if (!account) return null;
  if (account.type === 'oauth') {
    if (!account.accountUuid) return null;
    return account.organizationUuid ? `uuid:${account.accountUuid}:${account.organizationUuid}` : `uuid:${account.accountUuid}`;
  }
  if (account.type === 'provider' && account.provider && account.credential) {
    return `key:${account.provider}:${credentialFp(account.credential)}`;
  }
  return null;
}

// Keys a LOCAL row looks up in a remote identity map. A row whose organization is
// known also accepts the remote's org-less wildcard `uuid:<uuid>:*` (the remote
// saved the login before organizations were recorded, or runs an older version);
// an org-less row looks up the bare `uuid:<uuid>`, which an org-bearing remote row
// also registers while that user has a single organization there. Two KNOWN and
// different organizations never match.
export function identitiesOf(account) {
  const id = accountIdentity(account);
  if (!id) return [];
  if (account.type === 'oauth' && account.organizationUuid) return [id, `uuid:${account.accountUuid}:*`];
  return [id];
}

/** Identity of a REMOTE status row (same key shape as accountIdentity). */
export function remoteAccountIdentity(a) {
  if (!a) return null;
  if (a.type === 'oauth') return accountIdentity(a);
  if (a.type === 'provider' && a.provider && a.keyFingerprint) return `key:${a.provider}:${a.keyFingerprint}`;
  return null;
}

/** Identity map from a REMOTE pool's status JSON (key-gated /maxpool/status):
 *  { accounts: [{name,type,provider,accountUuid,enabled,...}], callers, ... }.
 *  Provider rows don't carry credentials — the remote pool exports a
 *  keyFingerprint per provider account so links can match without secrets. */
export function remoteIdentities(status) {
  const out = new Map();
  if (!status || !Array.isArray(status.accounts)) return out;
  const orgsByUser = new Map();   // uuid -> Set of known organizations
  const exactBare = new Set();    // bare keys owned by an org-less remote row
  for (const a of status.accounts) {
    if (a.enabled === false) continue; // a benched remote row doesn't bench the local copy
    const row = { name: a.name, provider: a.provider, type: a.type };
    if (a.type === 'oauth') {
      if (!a.accountUuid) continue;
      const bare = `uuid:${a.accountUuid}`;
      if (a.organizationUuid) {
        out.set(`${bare}:${a.organizationUuid}`, row);
        if (!out.has(bare)) out.set(bare, row);       // for an org-less local copy
        const set = orgsByUser.get(a.accountUuid) || new Set();
        set.add(a.organizationUuid); orgsByUser.set(a.accountUuid, set);
      } else {
        out.set(bare, row); exactBare.add(bare);
        out.set(`${bare}:*`, row);                     // for an org-bearing local copy
      }
    } else if (a.type === 'provider' && a.keyFingerprint) {
      out.set(`key:${a.provider}:${a.keyFingerprint}`, row);
    }
  }
  // Two known organizations of one user make an org-less local copy ambiguous:
  // drop the bare key rather than bench on a guess (unless an org-less remote row
  // owns it exactly).
  for (const [uuid, orgs] of orgsByUser) {
    const bare = `uuid:${uuid}`;
    if (orgs.size > 1 && !exactBare.has(bare)) out.delete(bare);
  }
  return out;
}

/** Given local accounts and remote identities, return the local indexes that
 *  must be benched (duplicates) — { index, remoteName }. Pure: no mutation. */
export function computeDuplicates(accounts, remoteIdentitiesMap) {
  const out = [];
  if (!remoteIdentitiesMap || remoteIdentitiesMap.size === 0) return out;
  // The org-less wildcard `uuid:<user>:*` is resolved only while the user has at
  // most ONE known organization locally. Two local orgs against one org-less
  // remote row is ambiguous (the remote holds at most one of the two
  // subscriptions), so then only an exact identity match benches — mirroring the
  // remote-side ambiguity rule below.
  const orgCount = new Map();
  for (const a of accounts) {
    if (a?.type === 'oauth' && a.accountUuid && a.organizationUuid) {
      orgCount.set(a.accountUuid, (orgCount.get(a.accountUuid) || 0) + 1);
    }
  }
  for (const a of accounts) {
    const ids = identitiesOf(a);
    const wildcard = ids[1];
    const usable = orgCount.get(a.accountUuid) > 1 && wildcard ? ids.slice(0, 1) : ids;
    const hit = usable.map(id => remoteIdentitiesMap.get(id)).find(Boolean);
    if (hit) out.push({ index: a.index, identity: ids[0], remoteName: hit.name, provider: hit.provider });
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
/** Status-poll timeout. The poll is NOT the liveness signal (the 5 s probe is) and it
 *  carries 0.5-1 MB from a busy cloud, so it gets a generous budget (was 10 s). */
export const STATUS_TIMEOUT_MS = 20_000;

export async function fetchRemoteStatus(url, key, { fetchFn = fetch, timeoutMs = STATUS_TIMEOUT_MS, now = Date.now } = {}) {
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

/** Dead-link probe (2026-11-18): GET <url>/maxpool/ping on a FRESH connection
 *  (agent:false — a pooled socket can be half-dead behind a silently-dropped tunnel)
 *  with a hard timeout. ANY HTTP status proves the tunnel and the cloud's event loop
 *  (an older cloud's 404/401 included); only a timeout / socket error is a miss.
 *  Resolves { status, error } — status null = miss. Never throws. */
export function probeLink(url, { timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    let req = null;
    const done = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { req?.destroy(); } catch { /* already gone */ }
      resolve({ status, error });
    };
    const timer = setTimeout(() => done(null, 'timeout'), timeoutMs);
    timer.unref?.();
    try {
      const target = new URL(`${String(url).replace(/\/+$/, '')}/maxpool/ping`);
      const mod = target.protocol === 'https:' ? https : http;
      req = mod.request(target, { method: 'GET', agent: false, headers: { connection: 'close' } }, (res) => {
        res.resume();
        done(res.statusCode, null);
      });
      req.on('error', (err) => done(null, err?.code || err?.message || 'network error'));
      req.end();
    } catch (err) {
      done(null, err?.message || 'bad url');
    }
  });
}

export const PROBE_TIMEOUT_MS = 3_000;
export const PROBE_INTERVAL_MS = 5_000;
export const PROBE_MISSES_BEFORE_DOWN = 3;
export const PROBE_HITS_BEFORE_UP = 2;

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
export const FAILS_BEFORE_DOWN = 2;

/** Plain-English cause of a link failure, for the one-line cloud banner. */
export function describeLinkError(err) {
  const e = String(err || '');
  if (e === 'key rejected') return "the cloud pool rejected this laptop's key";
  if (/^HTTP 5\d\d$/.test(e)) return `the cloud pool answered with an error (${e})`;
  if (/^HTTP /.test(e)) return `the cloud pool answered ${e}`;
  // timeout, ECONNREFUSED/RESET, "fetch failed", DNS… — from here they look alike.
  return `no connection — check your internet or the tunnel (${e || 'network error'})`;
}

export class PoolLink {
  constructor(def, deps = {}) {
    this.name = def.name;
    this.url = def.url;
    this.key = def.key || null;           // resolved by caller (secret) or literal
    this.keySecret = def.keySecret || null;
    this.intervalMs = Math.max(5_000, Number(def.intervalMs) || 30_000);
    this._fetchRemoteStatus = deps.fetchRemoteStatus || fetchRemoteStatus;
    this._probeFn = deps.probeFn || probeLink;
    this._now = deps.now || Date.now;
    this._timer = null;
    this._polling = false;
    // Last poll result. ok:false → link account benched + UI shows why.
    this.status = null;        // raw remote status JSON when ok
    this.lastError = null;
    this.lastOkAt = null;
    this.failStreak = 0;       // consecutive failed checks
    this.downSince = null;     // when lastError was first set (the outage start)
    this.identities = new Map();
    this.summary = null;
    // Dead-link probe state (see probe()). probeDown takes the link's mirrors out of
    // routing exactly like lastError, but within ~15 s instead of 40-70 s.
    this._probeTimer = null;
    this._probing = null;      // the in-flight probe promise (never stacked)
    this._probeOnChange = null;
    this._downListeners = new Set();
    this._upListeners = new Set();
    this.probeMisses = 0;
    this.probeHits = 0;
    this.probeDown = false;
    this.probeFirstMissAt = null;
    this.probeDownAt = null;
    this.lastProbeOkAt = null; // last time the probe got ANY answer (liveness authority)
  }

  /** True while the dead-link probe vouches for the link: it has run, is not down,
   *  and answered within the last two probe intervals. */
  probeSaysAlive() {
    return !this.probeDown && this.lastProbeOkAt != null
      && this._now() - this.lastProbeOkAt <= 2 * PROBE_INTERVAL_MS;
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
        this.failStreak = 0;
        this._softFailLogged = false;
        this.downSince = null;
        this.identities = remoteIdentities(r.json);
        this.summary = summarizeRemote(r.json);
      } else {
        // One missed check on a flaky network is not an outage: a single timeout
        // used to flip every cloud row to ✕ while requests were still getting
        // through. Mark the link down only after FAILS_BEFORE_DOWN checks in a row
        // (a rejected key is never transient — down at once). Keep the LAST good
        // status for display; down → routing benches it and the UI names the cause.
        this.failStreak = (this.failStreak || 0) + 1;
        this.lastPollError = r.error;
        // Liveness authority (2026-11-18 false-outage fix): the ~1 MB status body can
        // be slow through a busy tunnel while the link is fine. A timeout / network
        // error (no HTTP answer) never marks the link down while the 5 s probe says it
        // is alive — keep the last good status (stale-but-usable). A rejected key or
        // an HTTP error from the cloud is a real answer and still marks down below.
        const softFail = r.status == null && r.error !== 'key rejected';
        if (softFail && this.lastOkAt != null && !this.lastError && this.probeSaysAlive()) {
          if (!this._softFailLogged) {
            this._softFailLogged = true;
            console.log(`[Maxpool] link "${this.name}" status poll slow/failed (${r.error}) — link alive per probe; keeping last status`);
          }
          return r;
        }
        if (this.failStreak >= FAILS_BEFORE_DOWN || r.error === 'key rejected' || this.lastOkAt == null) {
          if (!this.lastError) this.downSince = r.at;
          this.lastError = r.error;
          this.summary = null;
        }
      }
      return r;
    } finally {
      this._polling = false;
    }
  }

  /** One probe. PROBE_MISSES_BEFORE_DOWN misses in a row → probeDown (onChange, then
   *  the onDown listeners, once); while down, PROBE_HITS_BEFORE_UP answers in a row →
   *  up (onChange, then the onUp listeners, once). A single answer resets the miss streak. Never stacks: a call
   *  while a probe is in flight joins it. Resolves true when the cloud answered. */
  probe() {
    if (this._probing) return this._probing;
    this._probing = (async () => {
      let r;
      try { r = await this._probeFn(this.url, { timeoutMs: PROBE_TIMEOUT_MS }); } catch (err) { r = { status: null, error: err?.message || 'probe failed' }; }
      const alive = Number.isFinite(r?.status);
      const now = this._now();
      let changed = false;
      if (alive) {
        this.lastProbeOkAt = now;
        this.probeMisses = 0;
        this.probeFirstMissAt = null;
        if (this.probeDown) {
          this.probeHits += 1;
          if (this.probeHits >= PROBE_HITS_BEFORE_UP) {
            const downS = this.probeDownAt != null ? Math.round((now - this.probeDownAt) / 1000) : 0;
            this.probeDown = false;
            this.probeDownAt = null;
            this.probeHits = 0;
            changed = true;
            console.log(`[Maxpool] link "${this.name}" back UP after ${downS}s`);
          }
        }
      } else {
        this.probeHits = 0;
        if (this.probeMisses === 0) this.probeFirstMissAt = now;
        this.probeMisses += 1;
        // Red team F3: a near-miss streak is logged so the false-alarm rate is measurable.
        if (this.probeMisses === PROBE_MISSES_BEFORE_DOWN - 1) {
          console.log(`[Maxpool] link "${this.name}" ${this.probeMisses} probes unanswered (first miss ${new Date(this.probeFirstMissAt).toISOString()})`);
        }
        // Red team F3: VETO — bytes flowed on this link within one probe interval, so the
        // tunnel is alive (a ping can miss on an event-loop stall or a new-connection limit
        // while live streams keep flowing). Cutting those hops would re-bill their prefill.
        const recentBytes = [...(this._inflight || [])].some(e => e?.lastByteAt != null && now - e.lastByteAt < PROBE_INTERVAL_MS);
        if (!this.probeDown && this.probeMisses >= PROBE_MISSES_BEFORE_DOWN && recentBytes) {
          console.log(`[Maxpool] link "${this.name}" — ${this.probeMisses} probes unanswered but replies are still flowing; NOT declaring down`);
        } else if (!this.probeDown && this.probeMisses >= PROBE_MISSES_BEFORE_DOWN) {
          this.probeDown = true;
          this.probeDownAt = now;
          changed = true;
          console.log(`[Maxpool] link "${this.name}" DOWN — no answer to ${this.probeMisses} probes (first miss ${new Date(this.probeFirstMissAt).toISOString()}, declared ${new Date(now).toISOString()})`);
        }
      }
      if (changed) {
        // Re-sync routing FIRST (mirrors leave), then cut in-flight waits — so a cut
        // request's failover already sees the link's rows out of routing.
        try { this._probeOnChange?.(this); } catch (err) { console.error(`[Maxpool] link "${this.name}" probe onChange failed: ${err?.message || err}`); }
        for (const fn of this.probeDown ? this._downListeners : this._upListeners) {
          try { fn(this); } catch (err) { console.error(`[Maxpool] link "${this.name}" ${this.probeDown ? 'down' : 'up'} listener failed: ${err?.message || err}`); }
        }
      }
      return alive;
    })().finally(() => { this._probing = null; });
    return this._probing;
  }

  /** Fire one probe now (a request just hit a link fault). Non-blocking; joins an
   *  in-flight probe instead of stacking. */
  probeNow() {
    return this.probe().catch(() => false);
  }

  /** Register a callback run once per DOWN transition (the server cuts in-flight
   *  link waits). Returns an unsubscribe function. */
  onDown(fn) {
    this._downListeners.add(fn);
    return () => this._downListeners.delete(fn);
  }

  /** Register a callback run once per UP transition, after onChange revived the
   *  mirrors (the account manager lifts any link-fault bench on them). Returns an
   *  unsubscribe function. */
  onUp(fn) {
    this._upListeners.add(fn);
    return () => this._upListeners.delete(fn);
  }

  startProbe(onChange, intervalMs = PROBE_INTERVAL_MS) {
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
    this._probeOnChange = onChange || null;
    this._probeTimer = setInterval(() => this.probeNow(), Math.max(1, Number(intervalMs) || PROBE_INTERVAL_MS));
    this._probeTimer.unref?.();
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
    if (this._probeTimer) { clearInterval(this._probeTimer); this._probeTimer = null; }
  }
}
