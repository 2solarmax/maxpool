import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const PACKAGE = 'maxpool';
const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** Read the running maxpool version from its own package.json. Null on failure. */
export async function getCurrentVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(await readFile(join(here, '..', 'package.json'), 'utf-8'));
    return pkg.version || null;
  } catch {
    return null;
  }
}

/** Compare two dotted versions. Returns 1 if a>b, -1 if a<b, 0 if equal. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => Number(n) || 0);
  const pb = String(b).split('.').map(n => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

/**
 * Check npm for a newer published version. Network-failure-safe: returns null
 * on any error (offline, timeout, bad response) so a check never breaks startup.
 */
export async function checkForUpdate(currentVersion, { timeoutMs = 4000, registry = DEFAULT_REGISTRY } = {}) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(`${registry}/${PACKAGE}/latest`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return null;
    const data = await res.json();
    const latest = data.version;
    if (!latest) return null;
    return {
      latest,
      current: currentVersion,
      hasUpdate: currentVersion ? compareVersions(latest, currentVersion) > 0 : false,
    };
  } catch {
    return null;
  }
}

/** Run `npm install -g maxpool@latest`. Returns {ok, output|error}. */
export async function selfUpdate({ timeoutMs = 120_000 } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('npm', ['install', '-g', `${PACKAGE}@latest`], { timeout: timeoutMs });
    return { ok: true, output: (stdout || stderr || '').trim() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Startup hook: check for an update and either notify (default) or self-install
 * (config.autoUpdate). Never auto-restarts a running proxy — the new version
 * applies on the next restart, so in-flight sessions are never interrupted.
 * Fire-and-forget; all failures are swallowed.
 */
export async function maybeCheckForUpdate(config, notify) {
  if (config?.updateCheck === false) return;
  const current = await getCurrentVersion();
  const result = await checkForUpdate(current);
  if (!result || !result.hasUpdate) return;

  notify(`Update available: ${result.current} → ${result.latest}`);
  if (config?.autoUpdate) {
    notify(`Auto-updating to ${result.latest}…`);
    const r = await selfUpdate();
    notify(r.ok
      ? `Updated to ${result.latest}. Restart maxpool to apply (running sessions are not interrupted).`
      : `Auto-update failed: ${r.error}. Run: npm i -g ${PACKAGE}`);
  } else {
    notify(`Run 'npm i -g ${PACKAGE}' to update, or set "autoUpdate": true in your config.`);
  }
}
