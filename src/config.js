import { readFile, writeFile, mkdir } from 'node:fs/promises';
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
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
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
  await writeFile(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Atomically update the config: re-reads from disk, calls updater(config),
 * then saves. Returns the updated config. This prevents overwriting changes
 * made by other processes (e.g. `teamclaude import` while the server runs).
 */
export async function atomicConfigUpdate(updater) {
  const config = await loadConfig() || createDefaultConfig();
  await updater(config);
  await saveConfig(config);
  return config;
}
