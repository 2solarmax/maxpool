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

// The version of the CODE currently EXECUTING, captured ONCE before any self-install.
// getCurrentVersion() reads package.json FROM DISK, which `npm i -g` rewrites — so
// after a background self-install the disk version != the running version. Every
// "am I behind?" and loop-guard decision keys on THIS fixed value, not the disk read.
let _bootVersion;
// The newest version this process has already ATTEMPTED to auto-apply. The loop guard:
// a version that installs fine but fails to BOOT rolls back to the old worker, which is
// still running _bootVersion with its timer armed — without this it would re-detect the
// on-disk version every check and re-apply forever (a boot-broken release → infinite
// reload loop, ~30s of refused admission each cycle). We apply only versions strictly
// newer than max(_bootVersion, _lastAttemptedTarget), so a rolled-back target is
// quarantined until an even newer release appears.
let _lastAttemptedTarget = null;

/** Test-only: reset the module's version-tracking state between cases. */
export function __resetUpdaterState() { _bootVersion = undefined; _lastAttemptedTarget = null; }

/**
 * Check for an update; with `config.autoUpdate` also self-install; with
 * `config.autoApply` SIGNAL that the caller should seamlessly reload to APPLY it
 * (returns `selfUpdated:true`). All failures swallowed. Deps are injectable for tests.
 *
 * `onVersionInfo` is ALWAYS invoked with { current, latest, hasUpdate, checkedAt } —
 * current + hasUpdate keyed on the RUNNING version (so the banner stays accurate after a
 * background download, until the reload). `deps.announce===false` suppresses the passive
 * "Update available" line (the periodic path — the persistent banner already shows it).
 *
 * Returns { hasUpdate, selfUpdated, installedVersion? }.
 */
export async function maybeCheckForUpdate(config, notify, onVersionInfo, deps = {}) {
  const _get = deps.getCurrentVersion || getCurrentVersion;
  const _check = deps.checkForUpdate || checkForUpdate;
  const _self = deps.selfUpdate || selfUpdate;
  const announce = deps.announce !== false;

  if (_bootVersion === undefined) _bootVersion = await _get();
  const current = _bootVersion;
  const result = config?.updateCheck === false ? null : await _check(current);
  const hasUpdate = Boolean(result?.hasUpdate);

  if (onVersionInfo) {
    try {
      onVersionInfo({ current, latest: result?.latest ?? null, hasUpdate, checkedAt: Date.now() });
    } catch { /* indicator is best-effort; never break startup */ }
  }

  if (!hasUpdate) return { hasUpdate: false, selfUpdated: false };
  if (announce) notify(`Update available: ${result.current} → ${result.latest}`);

  if (!config?.autoUpdate) {
    if (announce) notify(`Run 'npm i -g ${PACKAGE}' to update, or set "autoUpdate": true in your config.`);
    return { hasUpdate: true, selfUpdated: false };
  }

  // Skip the reinstall if the latest is ALREADY on disk (a prior check downloaded it) —
  // otherwise every periodic check re-runs `npm i -g` + re-logs until a manual restart.
  const onDisk = await _get();
  if (!onDisk || compareVersions(onDisk, result.latest) < 0) {
    notify(`Auto-updating to ${result.latest}…`);
    const r = await _self();
    if (!r.ok) {
      notify(`Auto-update failed: ${r.error}. Run: npm i -g ${PACKAGE}`);
      return { hasUpdate: true, selfUpdated: false };
    }
  }

  const installed = await _get();
  // Loop/quarantine guard — apply only a version strictly newer than the newest we've
  // already booted-as OR already tried to apply.
  const floor = (_lastAttemptedTarget && compareVersions(_lastAttemptedTarget, current) > 0)
    ? _lastAttemptedTarget : current;
  const canApply = Boolean(installed) && compareVersions(installed, floor) > 0;

  if (config?.autoApply && canApply) {
    _lastAttemptedTarget = installed;   // mark BEFORE the reload so a rollback can't re-trigger
    notify(`Updated to ${installed}. Applying now (seamless reload)…`);
    return { hasUpdate: true, selfUpdated: true, installedVersion: installed };
  }
  if (config?.autoApply && installed && _lastAttemptedTarget
      && compareVersions(installed, _lastAttemptedTarget) <= 0) {
    notify(`Update ${installed} already attempted and rolled back — staying on ${current}; will retry only a newer release.`);
  } else if (announce) {
    notify(`Updated to ${installed || result.latest}. Restart maxpool to apply (sessions are not interrupted).`);
  }
  return { hasUpdate: true, selfUpdated: false, installedVersion: installed };
}
