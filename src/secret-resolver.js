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

export async function resolveSecret(secretName, { project = DEFAULT_PROJECT, timeoutMs = 45_000, useCache = true } = {}) {
  if (!secretName || typeof secretName !== 'string') return null;
  if (useCache) {
    const cached = fromCache(secretName);
    if (cached) return cached;
  }
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
