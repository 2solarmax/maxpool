// CLI `maxpool login` → linked cloud team pool. Pure helpers (no top-level side
// effects) so tests can import them without running the CLI in index.js.
// Mirrors src/tui.js _sendLoginToTarget: same request shape, 20s timeout, and the
// single-writer rule — a cloud failure NEVER falls back to a local save.

const TIMEOUT_MS = 20_000;

/**
 * POST a fresh OAuth login to the team pool. Never throws.
 * @returns {Promise<{ok:boolean, result?:string, name?:string, error?:string}>}
 */
export async function sendLoginToPool({ url, key, name, profile, creds, fetchImpl = fetch, timeoutMs = TIMEOUT_MS }) {
  // No uuid → the server cannot dedupe a re-authorization and would ADD a duplicate
  // row (the v1.24.67 bug class). Refuse rather than risk it.
  if (!profile?.accountUuid) return { ok: false, kind: 'no-uuid', error: 'Account profile unavailable — no account id to add or re-authorize safely' };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${String(url).replace(/\/+$/, '')}/maxpool/accounts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key || '' },
      body: JSON.stringify({
        account: {
          name, type: 'oauth',
          accountUuid: profile?.accountUuid,
          organizationUuid: profile?.organizationUuid,
          accessToken: creds.accessToken,
          refreshToken: creds.refreshToken,
          expiresAt: creds.expiresAt,
          source: 'remote-login',
        },
      }),
      signal: ctl.signal,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.ok) return { ok: true, result: json.result, name: json.name || name };
    return { ok: false, kind: 'rejected', error: `Team pool rejected the login (HTTP ${res.status}: ${json?.message || json?.error || 'unknown error'})` };
  } catch (e) {
    return { ok: false, kind: 'unreachable', error: `Could not reach the team pool (${e?.name === 'AbortError' ? 'timed out' : e?.message})` };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Decide where a CLI login goes. `pools` = pools WITH a usable key (caller resolves).
 * `answer` = the T/l reply when a TTY prompt was shown (undefined/'' = Enter).
 * @returns {'local'|'cloud'|'ask'}  'ask' = TTY, no flag, pool present: caller must
 *   prompt, then call again with `answer`.
 */
export function chooseLoginTarget({ pools, flags = {}, isTTY, answer }) {
  const hasPool = Array.isArray(pools) && pools.length > 0;
  if (flags.local) return 'local';
  if (!hasPool) return 'local';
  if (flags.cloud) return 'cloud';
  if (!isTTY) return 'cloud';
  if (answer === undefined) return 'ask';
  return String(answer).trim().toLowerCase() === 'l' ? 'local' : 'cloud';
}

/**
 * Split configured pools into usable (have a key) and unresolved (configured but
 * the key could not be loaded). The caller needs the difference: "no pool
 * configured" and "pool configured, key missing" must never look the same.
 * @returns {Promise<{usable:Array, unresolved:string[], error?:string}>}
 */
export async function resolveUsablePools(configPools, resolve) {
  const defs = (Array.isArray(configPools) ? configPools : []).filter(p => p && p.name && p.url);
  const names = defs.map(p => p.keySecret).filter(Boolean);
  let resolved = {};
  let error;
  if (names.length) {
    try { resolved = (await resolve(names)) || {}; } catch (e) { resolved = {}; error = e?.message || String(e); }
  }
  const all = defs.map(p => ({ name: p.name, url: p.url, key: p.keySecret ? (resolved[p.keySecret] || null) : (p.key || null) }));
  const out = { usable: all.filter(p => p.key), unresolved: all.filter(p => !p.key).map(p => p.name) };
  if (error) out.error = error;
  return out;
}

/**
 * Full CLI decision (pure). Inputs: usable/unresolved from resolveUsablePools,
 * localMatch (account already in config.accounts), flags {local,cloud,pool},
 * isTTY, and prompt replies (answer = T/l, poolAnswer = pool pick, fallbackAnswer = y/N).
 * @returns {{action:'local'|'cloud'|'fail'|'ask-pool'|'ask-target'|'ask-fallback', pool?:object, message?:string}}
 */
export function planCliLogin({ usable = [], unresolved = [], error, localMatch = null, flags = {}, isTTY, answer, poolAnswer, fallbackAnswer }) {
  const unresolvedMsg = (n) => `Team pool '${n}' is configured but its key could not be loaded${error ? ` (${error})` : ''}.`;
  if (flags.local && flags.cloud) return { action: 'fail', message: 'Use either --cloud or --local, not both.' };
  if (flags.local) return { action: 'local' };
  // An account lives in exactly ONE pool: a local match is re-authenticated locally.
  if (localMatch) {
    if (flags.cloud) return { action: 'fail', message: `This account is already on this laptop as "${localMatch.name}" — an account lives in one pool only. Re-run without --cloud to re-authenticate it here.` };
    return { action: 'local' };
  }
  let pool = null;
  if (flags.pool) {
    pool = usable.find(p => p.name === flags.pool) || null;
    if (!pool) {
      return { action: 'fail', message: unresolved.includes(flags.pool)
        ? unresolvedMsg(flags.pool)
        : `No team pool named '${flags.pool}' is configured.` };
    }
  } else if (usable.length === 0) {
    if (unresolved.length) {
      const msg = unresolved.map(unresolvedMsg).join(' ');
      if (flags.cloud || !isTTY) return { action: 'fail', message: `${msg} Nothing was saved.${flags.cloud ? '' : ' Use --local to save on this laptop.'}` };
      if (fallbackAnswer === undefined) return { action: 'ask-fallback', message: msg };
      return String(fallbackAnswer).trim().toLowerCase() === 'y'
        ? { action: 'local' }
        : { action: 'fail', message: 'Nothing was saved.' };
    }
    if (flags.cloud) return { action: 'fail', message: '--cloud: no team pool is configured (config.pools). Nothing was saved.' };
    return { action: 'local' };
  } else if (usable.length === 1) {
    pool = usable[0];
  } else {
    if (!isTTY) return { action: 'fail', message: `${usable.length} team pools are linked (${usable.map(p => p.name).join(', ')}) — pass --pool <name> to choose one, or --local. Nothing was saved.` };
    if (poolAnswer === undefined) return { action: 'ask-pool' };
    const a = String(poolAnswer).trim();
    pool = a === '' ? usable[0] : (usable[Number(a) - 1] || usable.find(p => p.name === a) || null);
    if (!pool) return { action: 'fail', message: `'${a}' is not one of the linked pools. Nothing was saved.` };
  }
  const t = chooseLoginTarget({ pools: [pool], flags, isTTY, answer });
  if (t === 'ask') return { action: 'ask-target', pool };
  return t === 'local' ? { action: 'local' } : { action: 'cloud', pool };
}
