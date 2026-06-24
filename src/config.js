import { readFile, writeFile, mkdir, rename, chmod, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export function getConfigPath() {
  if (process.env.TEAMCLAUDE_CONFIG) return process.env.TEAMCLAUDE_CONFIG;
  const configDir = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
  return join(configDir, 'teamclaude.json');
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      host: '127.0.0.1',
      apiKey: 'tc-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    switchThreshold: 0.90,
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
    },
    retry: {
      maxAttemptsPerRequest: 0,
      maxRetryBufferBytes: 10 * 1024 * 1024,
    },
    queue: {
      enabled: true,
      maxWaitMs: 24 * 60 * 60 * 1000,
      autoMaxWaitMs: null,
      capacityMaxWaitMs: 15 * 60 * 1000,
      maxQueuedBodyBytes: 256 * 1024 * 1024,
      weeklyMaxWaitMs: 0,
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

export async function saveConfig(config) {
  const path = getConfigPath();
  await mkdir(dirname(path), { recursive: true });
  // Atomic write: a crash/power-loss mid-write must never truncate the file
  // (it holds every account's OAuth tokens). Write a sibling temp file, force
  // 0600 (writeFile's mode only applies on create, not when overwriting an
  // existing 0644 file), then rename — atomic within a filesystem on POSIX.
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
}

let _configWriteChain = Promise.resolve();

/**
 * Serialize an in-process read-modify-write of the config so concurrent updates
 * cannot lose each other's writes — e.g. a background OAuth token refresh
 * (fire-and-forget) racing a TUI account add/delete. Each update re-reads the
 * latest config, applies updater(config), then saves atomically.
 *
 * NOTE: this serializes writes within THIS process only. A separate
 * `teamclaude import`/`login` process writing concurrently is not coordinated
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
