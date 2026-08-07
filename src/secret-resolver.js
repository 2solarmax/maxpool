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

const execFileAsync = promisify(execFile);

const DEFAULT_PROJECT = 'mokka-business-automations';

export async function resolveSecret(secretName, { project = DEFAULT_PROJECT, timeoutMs = 10_000 } = {}) {
  if (!secretName || typeof secretName !== 'string') return null;
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
  const entries = await Promise.all(
    unique.map(async name => [name, await resolveSecret(name, opts)]),
  );
  return Object.fromEntries(entries.filter(([, v]) => v != null));
}
