/**
 * Resolve a GCP Secret Manager secret name to its plaintext value.
 *
 * Uses `gcloud secrets versions access` — the same path load-secrets.sh uses.
 * The key is resolved ONCE at startup (or when a provider is added via the TUI)
 * and held in maxpool's process memory, never written to disk or logs.
 *
 * Returns null on any failure (missing secret, no gcloud, auth error) so a
 * broken provider degrades to "disabled" instead of crashing the proxy.
 */
import { execFile } from 'node:child_process';
import https from 'node:https';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const execFileAsync = promisify(execFile);

const DEFAULT_PROJECT = 'mokka-business-automations';

// A single `gcloud secrets versions access` costs ~17-33s on this machine (python
// interpreter start + an ADC round-trip), and running them CONCURRENTLY makes it
// worse, not better: measured 2026-08-10, 5 secrets in parallel → 3 of 5 hit the
// 45s timeout; the same 5 sequentially → 4 of 5. Either way providers boot as
// "secret-unresolved", which is what stranded `kimi max@gomokka.com` and let the
// header path create a duplicate `kimi-fallback` row beside it.
//
// The workspace already maintains a local plaintext cache of these same secrets
// (written by scripts/load-secrets.sh, mode 0600, sanctioned by the secrets-directory
// rule). Reading it is sub-millisecond and needs no auth, so try it FIRST and fall
// back to gcloud only for what it does not carry.
let cacheMemo;
let cachePathMemo;

function cachePath() {
  if (!cachePathMemo) cachePathMemo = join(homedir(), '.claude', '.credentials-cache');
  return cachePathMemo;
}

/** Test seam: drop the memo so a re-read picks up a freshly-written cache. */
export function __resetSecretCache() { cacheMemo = undefined; cachePathMemo = undefined; }

function readCredentialCache() {
  if (cacheMemo !== undefined) return cacheMemo;
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8'));
    cacheMemo = (parsed && typeof parsed === 'object') ? parsed : null;
  } catch {
    cacheMemo = null;   // absent/unreadable/corrupt → gcloud path, never a crash
  }
  return cacheMemo;
}

function fromCache(secretName) {
  const cache = readCredentialCache();
  const v = cache?.[secretName];
  return (typeof v === 'string' && v.trim()) ? v.trim() : null;
}

// REST PATH FIRST (2026-10-08). `gcloud secrets versions access` hung on this machine
// (>60s, 21 piled-up gcloud processes) while a plain Secret Manager REST call with the
// same user's token answered in 0.75s. Every startup resolve AND every 5-minute
// re-resolve went through the hung CLI, so all z.ai providers stayed
// "secret-unresolved" until a manual restart happened to land on a good moment.
// The token itself comes from `gcloud auth print-access-token` (fast — it reads the
// stored credential, no Secret Manager round-trip) and is reused for ~45 min.
let tokenMemo = { value: null, at: 0 };
const TOKEN_TTL_MS = 45 * 60_000;

async function accessToken(timeoutMs) {
  if (tokenMemo.value && Date.now() - tokenMemo.at < TOKEN_TTL_MS) return tokenMemo.value;
  const { stdout } = await execFileAsync('gcloud', ['auth', 'print-access-token'],
    { timeout: Math.min(timeoutMs, 20_000), maxBuffer: 64 * 1024 });
  const t = stdout.trim();
  if (!t) throw new Error('empty token');
  tokenMemo = { value: t, at: Date.now() };
  return t;
}

// IPv4-PINNED GET (2026-10-08). On this network IPv6 to Google is black-holed:
// secretmanager.googleapis.com advertises AAAA records, an IPv6 connect hangs until
// timeout, and IPv4 answers fine (measured: `curl -6` 8s timeout, `curl -4` OK). gcloud's
// own HTTP stack tries IPv6 first and HANGS — that is why every CLI resolve timed out.
// `family: 4` makes this path immune; the CLI fallback below stays as a last resort.
function ipv4Get(url, { headers, signal }) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers, family: 4, signal }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, json: async () => JSON.parse(body) });
      });
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

/** Test seam: inject a fetch + token source. */
let restDeps = { fetch: ipv4Get, token: accessToken };
export function __setRestDeps(d) { restDeps = { ...restDeps, ...d }; }
export function __resetRestDeps() { restDeps = { fetch: ipv4Get, token: accessToken }; tokenMemo = { value: null, at: 0 }; }

async function viaRest(secretName, project, timeoutMs) {
  const tok = await restDeps.token(timeoutMs);
  const url = `https://secretmanager.googleapis.com/v1/projects/${encodeURIComponent(project)}`
    + `/secrets/${encodeURIComponent(secretName)}/versions/latest:access`;
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), Math.min(timeoutMs, 15_000));
  try {
    const res = await restDeps.fetch(url, { headers: { Authorization: `Bearer ${tok}` }, signal: ctl.signal });
    if (res.status === 401) { tokenMemo = { value: null, at: 0 }; return null; }  // stale token → CLI fallback
    // 403/404: the server answered definitively — the CLI would get the same answer.
    if (res.status === 403 || res.status === 404) return { value: null, definitive: true };
    if (!res.ok) return null;
    const j = await res.json();
    const b64 = j?.payload?.data;
    if (!b64) return { value: null, definitive: true };
    const v = Buffer.from(b64, 'base64').toString('utf8').trim();
    return { value: v || null, definitive: true };
  } finally { clearTimeout(t); }
}

export async function resolveSecret(secretName, { project = DEFAULT_PROJECT, timeoutMs = 45_000, useCache = true } = {}) {
  if (!secretName || typeof secretName !== 'string') return null;
  if (useCache) {
    const cached = fromCache(secretName);
    if (cached) return cached;
  }
  // ONE time budget for the whole lookup: REST first, then the CLI with whatever is
  // left. A definitive REST answer (the secret does not exist / no access) skips the
  // CLI entirely — the CLI would only re-ask the same server, and on an IPv6-broken
  // network it hangs for the full timeout anyway.
  const deadline = Date.now() + timeoutMs;
  try {
    const r = await viaRest(secretName, project, timeoutMs);
    if (r?.value) return r.value;
    if (r?.definitive) return null;
  } catch { /* transport failure — fall through to the CLI path */ }
  const remaining = deadline - Date.now();
  if (remaining < 1000) return null;
  timeoutMs = remaining;
  try {
    const { stdout } = await execFileAsync(
      'gcloud',
      ['secrets', 'versions', 'access', 'latest', '--secret', secretName, '--project', project],
      { timeout: timeoutMs, maxBuffer: 1024 * 1024 },
    );
    const value = stdout.trim();
    return value || null;
  } catch {
    // Missing secret, no gcloud, auth expired, no network — all degrade to null.
    // The TUI shows the provider as "error: secret-unresolved" so the operator
    // knows which secret failed, not just that "the provider is broken".
    return null;
  }
}

/**
 * Resolve multiple secrets in parallel. Returns { name → value } for the ones
 * that resolved; failed ones are simply absent (caller treats absence as
 * "provider can't activate"). Parallel because N secrets at ~500ms each
 * serialized would add seconds to startup.
 */
export async function resolveSecrets(secretNames, opts = {}) {
  const unique = [...new Set(secretNames.filter(Boolean))];
  if (!unique.length) return {};

  // Cache hits first — free, and on this machine that is usually all of them.
  const out = {};
  const misses = [];
  for (const name of unique) {
    const cached = opts.useCache === false ? null : fromCache(name);
    if (cached) out[name] = cached;
    else misses.push(name);
  }

  // Only genuine misses pay gcloud, and SEQUENTIALLY — concurrent invocations
  // contend and time each other out (measured: 3 of 5 failed in parallel vs 1 of 5
  // sequentially). Sequential over a handful of misses is strictly better here.
  for (const name of misses) {
    const v = await resolveSecret(name, { ...opts, useCache: false });
    if (v != null) out[name] = v;
  }
  return out;
}

/**
 * Re-resolve config-sourced providers whose key never loaded. Accounts carry their
 * key in `credential` (upsertRuntimeAccount maps authToken -> credential); the first
 * version of this loop (v1.24.6) tested and wrote `authToken`, a field accounts never
 * hold — so every provider looked unresolved forever, its status was reset to
 * 'unknown' every 5 min, and a genuinely-unresolved one was never actually repaired.
 * Returns the number of providers recovered.
 */
export function pendingProviders(accounts) {
  return accounts.filter(a => a.configSourced && a.type === 'provider' && a.secretName && !a.credential);
}

/**
 * Pick up ROTATED keys. A key resolves once at startup, so a new secret version (a
 * key swap in Secret Manager) stayed invisible until the next restart — the pool kept
 * calling with the old key (2026-10-09: all six z.ai keys moved to the account's
 * "zcode-api-key", which is the only key z.ai issues reset cards for). Re-reads every
 * loaded provider's secret, bypassing the local cache, and swaps `credential` when the
 * value changed. A failed read keeps the current key. Returns the number swapped.
 */
export async function refreshRotatedProviders(accounts, resolve = (names) => resolveSecrets(names, { useCache: false })) {
  const loaded = accounts.filter(a => a.configSourced && a.type === 'provider' && a.secretName && a.credential);
  if (!loaded.length) return 0;
  const resolved = await resolve([...new Set(loaded.map(a => a.secretName))]);
  let swapped = 0;
  for (const a of loaded) {
    const tok = resolved[a.secretName];
    if (!tok || tok === a.credential) continue;
    a.credential = tok;
    swapped++;
  }
  return swapped;
}

export async function reresolveProviders(accounts, resolve = resolveSecrets) {
  const pending = pendingProviders(accounts);
  if (!pending.length) return 0;
  const resolved = await resolve(pending.map(a => a.secretName));
  let fixed = 0;
  for (const a of pending) {
    const tok = resolved[a.secretName];
    if (!tok) continue;
    a.credential = tok;
    if (a.status === 'error' && a.lastError === 'secret-unresolved') { a.status = 'active'; a.lastError = null; }
    fixed++;
  }
  return fixed;
}
