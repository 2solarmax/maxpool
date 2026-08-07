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

/**
 * Path to the persistent event log (a sibling of the config). Default-on; holds a
 * rotating record of routing / network errors / cooldowns / reloads so incidents
 * are investigable after the in-memory TUI feed has scrolled away.
 */
export function getLogPath() {
  const cfg = getConfigPath();
  return cfg.endsWith('.json') ? cfg.replace(/\.json$/, '.log') : cfg + '.log';
}

export function createDefaultConfig() {
  return {
    proxy: {
      port: 3456,
      host: '127.0.0.1',
      apiKey: 'mp-' + randomBytes(24).toString('base64url'),
    },
    upstream: 'https://api.anthropic.com',
    // (macOS) Keep the system awake while requests are in flight so long overnight
    // streams survive Maintenance Sleep; the Mac sleeps normally when idle. Set false
    // to disable. AC power only; the display still sleeps (screen stays dark).
    preventSleep: true,
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
    // Background quota probe: poll every account's real 5h/7d utilization from the
    // zero-spend usage endpoint every N seconds. ON by default — without it maxpool
    // is blind to idle / out-of-band-used accounts and the scorer will pile traffic
    // onto exactly the account it cannot see. 0 = off.
    quotaProbeSeconds: 60,
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
      // Fixed cooldown for network-class failures (lost connectivity / token-refresh
      // fetch-failed) — short + non-escalating so the fleet auto-recovers seconds after
      // connectivity returns, never the exponential maxCooldownMs bench.
      networkCooldownMs: 5_000,
      // Weekly (7d) quota tiers — how aggressively to de-prioritise an account
      // as its weekly usage climbs. Each is a fraction (0..1) of the weekly
      // limit. Below soft = full speed; soft..reserve = mild penalty;
      // reserve..critical = heavy penalty; above exhausted = effectively
      // parked until the weekly window resets. Tune to trade burst capacity
      // against weekly-limit safety.
      weeklySoftThreshold: 0.65,
      weeklyReserveThreshold: 0.85,
      weeklyCriticalThreshold: 0.95,
      // Use-it-or-lose-it: bench only at 99.9% (the weekly quota resets, so reserving
      // the top ~1.5% wastes it). A real 429 sets util≈1.0 and still benches.
      weeklyExhaustedThreshold: 0.999,
      // Cross-PROVIDER fallback policy for 'cc all' (profile=all): whether a session
      // may be served by a provider family other than its home (Claude → GLM/Kimi).
      //   'never'         — (DEFAULT) a Claude Code session stays on Anthropic; no
      //                     GLM/Kimi fallback. Routing Claude→providers proved unreliable
      //                     (the coding legs 403/429 + ignore the model id), so it's OFF
      //                     by default — re-enable here or via the TUI 'f' key.
      //   'when-exhausted'— home family preferred; a Claude session falls to GLM/Kimi
      //                     only once all Claude accounts are unavailable.
      //   'always'        — providers peer with Claude for a Claude/unknown session.
      // A GLM/Kimi-origin session NEVER routes to Anthropic under ANY policy — that
      // direction 400s on the non-`srvtoolu_` tool-use id and is unfixable. Toggle
      // live in the TUI (Routing sub-mode, 'f' key).
      crossProviderFallbackPolicy: 'never',
      // The OTHER cross direction (independent of the policy above): may a provider-origin
      // (GLM/Kimi) session cross to the OTHER provider (GLM↔Kimi)? Default ON — reliable,
      // both legs accept each other's ids. Only has effect under policy:'never'.
      providerCrossFallback: true,
      // Per-provider Claude→provider control (TUI routing: g = GLM, k = Kimi). Same values
      // as the policy above; unset inherits it. Default 'never' — a Claude session that
      // finishes on a provider comes back with thinking blocks Anthropic rejects (Maxpool
      // repairs that automatically, but a provider server-tool call is unrepairable).
      // Left EMPTY: an unset provider inherits the policy above, so off-by-default holds
      // without shadowing it. The TUI writes an entry here only when you steer one
      // provider differently from the other.
      providers: {},
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
      maxWaitMs: 24 * 60 * 60 * 1000,    // hard ceiling for non-streaming/capacity holds; streaming uses streamHoldMaxMs
      autoMaxWaitMs: null,               // 5h/session-cap hold (null = maxWaitMs)
      capacityMaxWaitMs: 15 * 60 * 1000, // short cap for NON-streaming capacity holds + the concurrency-cap clamp. A STREAMING capacity/throttle hold uses maxWaitMs (held on the heartbeat until capacity frees), NOT this.
      weeklyMaxWaitMs: 24 * 60 * 60 * 1000, // legacy bound; streaming holds use streamHoldMaxMs
      // Streaming hold ceiling: how long a streaming session is held ALIVE on the
      // heartbeat waiting for any account to free up. 7d so a session is never
      // killed while a real reset is on the way; only permanent failures (all
      // accounts logged out / no eligible route) error fast. Lower if your client
      // uses a wall-clock total-request timeout the heartbeat can't reset.
      streamHoldMaxMs: 7 * 24 * 60 * 60 * 1000,
      nonStreamMaxWaitMs: 5 * 60 * 1000, // non-streaming requests have no keepalive; cap their wait
      maxConcurrentQueued: 64,           // backpressure: max requests held at once
      maxQueuedBytes: 1024 * 1024 * 1024, // backpressure: max aggregate buffered body bytes (1 GiB)
      maxQueuedBodyBytes: 256 * 1024 * 1024, // per-request cap on a queueable body
      pollMs: 1000,
      heartbeatMs: 10_000,
    },
    accounts: [],
    // Config-sourced provider accounts (GLM/Kimi). Each entry references a GCP
    // Secret Manager secret by NAME — the key is resolved at startup and held in
    // memory only. See src/secret-resolver.js.
    //   [{ name, provider:'zai'|'kimi', secretName, upstream?, priority? }]
    providers: [],
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
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // With atomic temp+rename writes a torn read is impossible, so a parse
    // failure means genuine corruption. Surface it clearly rather than as a
    // cryptic crash, and do NOT return null — that would let a caller overwrite
    // the file with defaults and lose recoverable OAuth credentials.
    throw new Error(`config at ${path} is not valid JSON (corrupt?): ${err.message}`);
  }
  // Backfill top-level keys ABSENT from an older on-disk config with the current
  // defaults, so a changed default (e.g. quotaProbeSeconds flipping on) actually
  // reaches existing installs instead of shipping inert. A key that is present —
  // even falsy, like an explicit `0` — is an intentional user choice and always
  // wins; only genuinely-missing keys inherit the default.
  if (parsed && typeof parsed === 'object') {
    const defaults = createDefaultConfig();
    for (const key of Object.keys(defaults)) {
      if (!(key in parsed)) parsed[key] = defaults[key];
    }
  }
  return parsed;
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

/**
 * Read just the `_generation` integer of an on-disk JSON file (config or state)
 * without parsing it as a typed object. Returns 0 when the file is missing,
 * unreadable, or carries no generation (legacy files), so a first write always
 * advances to >=1. Never throws.
 */
export async function readGeneration(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8'));
    const g = Number(parsed?._generation);
    return Number.isFinite(g) && g > 0 ? g : 0;
  } catch {
    return 0;
  }
}

/**
 * Generation-guarded state write (defense-in-depth single-writer enforcement).
 *
 * `state.quota` carries the learned quota. We stamp a monotonic `_generation`
 * and refuse to clobber a file whose on-disk generation is NEWER than the one
 * we last observed — that means another writer (a stale ex-lease worker) raced
 * us, and overwriting would revert fresher quota. The baton sequencing already
 * guarantees a single writer; this guard catches a sequencing bug.
 *
 * Pass `{ expectedGeneration }` to assert the on-disk file is still at the
 * generation you read; omit it to read-then-bump unconditionally (single-owner
 * fast path). Returns the generation written, or null when refused.
 */
let _stateWriteChain = Promise.resolve();

export function saveState(state, { expectedGeneration = null } = {}) {
  // Serialize state writes (a 60s interval flush can otherwise race the final
  // baton flush, read the same on-disk generation, and double-write).
  const run = async () => {
    const path = getStatePath();
    const onDisk = await readGeneration(path);
    if (expectedGeneration != null && onDisk > expectedGeneration) {
      // A newer writer advanced the file under us — refuse the stale flush.
      return null;
    }
    const next = onDisk + 1;
    await atomicWrite(path, JSON.stringify({ ...state, _generation: next }, null, 2) + '\n');
    return next;
  };
  const result = _stateWriteChain.then(run, run);
  _stateWriteChain = result.then(() => {}, () => {});
  return result;
}

/** Barrier: resolves once every queued state write has settled. */
export const flushStateWrites = () => _stateWriteChain;

let _configWriteChain = Promise.resolve();

/** Barrier: resolves once every queued config write (e.g. a fire-and-forget
 *  token-refresh persist) has settled. Awaited on baton release so a rotated
 *  token can't be left unwritten when the new worker boots from disk (M3). */
export const flushConfigWrites = () => _configWriteChain;

/**
 * Serialize an in-process read-modify-write of the config so concurrent updates
 * cannot lose each other's writes — e.g. a background OAuth token refresh
 * (fire-and-forget) racing a TUI account add/delete. Each update re-reads the
 * latest config, applies updater(config), then saves atomically.
 *
 * Defense-in-depth single-writer guard: the config carries a monotonic
 * `_generation`. If `guardGeneration` is supplied and the on-disk generation is
 * already NEWER than it, the write is REFUSED (a stale ex-lease worker raced the
 * current writer). The updater additionally receives the on-disk generation as
 * `config._generation` so a refresh updater can SKIP a token rotation it sees a
 * fresher writer already performed. The generation is bumped on every write.
 *
 * NOTE: this serializes writes within THIS process only. A separate
 * `maxpool import`/`login` process writing concurrently is not coordinated
 * (that would require a lockfile) — but those are short, rare, human-driven.
 */
export function atomicConfigUpdate(updater, { guardGeneration = null } = {}) {
  const run = async () => {
    const config = await loadConfig() || createDefaultConfig();
    const onDisk = Number(config._generation) || 0;
    if (guardGeneration != null && onDisk > guardGeneration) {
      // Refuse: a newer writer already advanced the config. Surface the live
      // config so the caller can reconcile, but write nothing.
      const refused = new Error('config generation advanced; stale write refused');
      refused.code = 'STALE_GENERATION';
      refused.onDiskGeneration = onDisk;
      refused.config = config;
      throw refused;
    }
    const result = await updater(config);
    config._generation = onDisk + 1;
    await saveConfig(config);
    return result === undefined ? config : result;
  };
  // Run after any in-flight update regardless of whether it resolved or
  // rejected, so one failure doesn't poison the chain; the caller still sees
  // this update's real result/error.
  const result = _configWriteChain.then(run, run);
  _configWriteChain = result.then(() => {}, () => {});
  return result;
}
