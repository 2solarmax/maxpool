import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function getConfigPath() {
  if (process.env.MAXPOOL_CONFIG) return process.env.MAXPOOL_CONFIG;
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG; // legacy env
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  const current = join(configDir, 'maxpool.json');
  if (existsSync(current)) return current;
  // Seamless upgrade from the project's former name: keep using an existing
  // teamclaude.json in place rather than starting empty.
  const legacy = join(configDir, 'teamclaude.json');
  if (existsSync(legacy)) return legacy;
  return current;
}

/**
 * Path to the runtime state file (a sibling of the config). Holds volatile data
 * learned at runtime — quota utilization observed passively from traffic — kept
 * out of the hand-editable config so config stays clean and isn't rewritten on
 * every state save.
 */
export function getStatePath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.state.json') : cfg + '.state';
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      host: '127.0.0.1',
      apiKey: 'mp-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    // On startup, check npm for a newer maxpool and notify. Set false to disable.
    updateCheck: true,
    // When true, a newer version is installed automatically (npm i -g maxpool@latest)
    // and applied on the NEXT restart — running sessions are never interrupted.
    autoUpdate: false,
    // Per-account "stop using this account" gate, applied to BOTH the 5h
    // session window and the 7d weekly window (whichever utilization is
    // higher). 0.90 = stop routing to an account once it crosses 90% of a
    // window, leaving a 10% safety margin so it is never hard-limited (429).
    // Raise toward 0.97 to squeeze more out of accounts before rotating
    // (less margin, slightly higher 429 risk); lower to rotate more eagerly.
    switchThreshold: 0.90,
    quotaProbeSeconds: 0, // background quota probe; 0 = off (opt-in)
    routing: {
      mode: 'automatic',
      preferredAccount: null,
    },
    scheduler: {
      mode: 'adaptive-least-loaded',
      safetyMaxActivePerAccount: 50,
      safetyMaxGlobalActive: 150,
      cooldownMs: 30_000,
      maxCooldownMs: 15 * 60_000,
      // Weekly (7d) quota tiers — how aggressively to de-prioritise an account
      // as its weekly usage climbs. Each is a fraction (0..1) of the weekly
      // limit. Below soft = full speed; soft..reserve = mild penalty;
      // reserve..critical = heavy penalty; above exhausted = effectively
      // parked until the weekly window resets. Tune to trade burst capacity
      // against weekly-limit safety.
      weeklySoftThreshold: 0.65,
      weeklyReserveThreshold: 0.85,
      weeklyCriticalThreshold: 0.95,
      weeklyExhaustedThreshold: 0.985,
    },
    retry: {
      maxAttemptsPerRequest: 0,
      maxRetryBufferBytes: 10 * 1024 * 1024,
    },
    // On quit (q / Ctrl-C / SIGTERM): stop accepting new requests, give
    // in-flight requests up to drainTimeoutMs to finish, then force-exit.
    // A second signal forces an immediate exit. Kept short so quit works
    // under a continuous request flood instead of hanging.
    shutdown: {
      drainTimeoutMs: 15_000,
    },
    // When every account is rate-limited, hold the request and retry until one
    // frees up, instead of erroring and killing the session. Only error if
    // nothing recovers within the window below (the early-exit gates on each
    // account's REAL reset time, so a generous bound never spins pointlessly).
    queue: {
      enabled: true,
      maxWaitMs: 24 * 60 * 60 * 1000,    // hard ceiling for any hold
      autoMaxWaitMs: null,               // 5h/session-cap hold (null = maxWaitMs)
      capacityMaxWaitMs: 15 * 60 * 1000, // upstream 529/overload — stays short, never governed by the others
      weeklyMaxWaitMs: 24 * 60 * 60 * 1000, // weekly (7d) cap hold; was 0 (fail-fast) — that killed sessions on weekly cap
      nonStreamMaxWaitMs: 5 * 60 * 1000, // non-streaming requests have no keepalive; cap their wait
      maxConcurrentQueued: 64,           // backpressure: max requests held at once
      maxQueuedBytes: 1024 * 1024 * 1024, // backpressure: max aggregate buffered body bytes (1 GiB)
      maxQueuedBodyBytes: 256 * 1024 * 1024, // per-request cap on a queueable body
      pollMs: 1000,
      heartbeatMs: 10_000,
    },
    accounts: [],
  };
}

export async function loadConfig() {
  const path = getConfigPath();
  let raw;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    // With atomic temp+rename writes a torn read is impossible, so a parse
    // failure means genuine corruption. Surface it clearly rather than as a
    // cryptic crash, and do NOT return null — that would let a caller overwrite
    // the file with defaults and lose recoverable OAuth credentials.
    throw new Error(`config at ${path} is not valid JSON (corrupt?): ${err.message}`);
  }
}

export async function loadOrCreateConfig() {
  let config = await loadConfig();
  if (!config) {
    config = createDefaultConfig();
    await saveConfig(config);
    console.log(`Created config at ${getConfigPath()}`);
  }
  return config;
}

/**
 * Atomic 0600 write: a crash/power-loss mid-write must never truncate the file
 * (config holds every account's OAuth tokens). Write a sibling temp file, force
 * 0600 (writeFile's mode only applies on create, not when overwriting an
 * existing 0644 file), then rename — atomic within a filesystem on POSIX.
 */
async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

export async function saveConfig(config) {
  await atomicWrite(getConfigPath(), JSON.stringify(config, null, 2) + '\n');
}

/** Load runtime state (regenerable). Returns null if missing or unreadable —
 *  never throws, since stale/corrupt learned state must not crash startup. */
export async function loadState() {
  try {
    return JSON.parse(await readFile(getStatePath(), 'utf-8'));
  } catch {
    return null;
  }
}

export async function saveState(state) {
  await atomicWrite(getStatePath(), JSON.stringify(state, null, 2) + '\n');
}

let _configWriteChain = Promise.resolve();

/**
 * Serialize an in-process read-modify-write of the config so concurrent updates
 * cannot lose each other's writes — e.g. a background OAuth token refresh
 * (fire-and-forget) racing a TUI account add/delete. Each update re-reads the
 * latest config, applies updater(config), then saves atomically.
 *
 * NOTE: this serializes writes within THIS process only. A separate
 * `maxpool import`/`login` process writing concurrently is not coordinated
 * (that would require a lockfile) — but those are short, rare, human-driven.
 */
export function atomicConfigUpdate(updater) {
  const run = async () => {
    const config = await loadConfig() || createDefaultConfig();
    await updater(config);
    await saveConfig(config);
    return config;
  };
  // Run after any in-flight update regardless of whether it resolved or
  // rejected, so one failure doesn't poison the chain; the caller still sees
  // this update's real result/error.
  const result = _configWriteChain.then(run, run);
  _configWriteChain = result.then(() => {}, () => {});
  return result;
}
