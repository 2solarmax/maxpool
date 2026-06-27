#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { loadOrCreateConfig, loadConfig, saveConfig, atomicConfigUpdate, getConfigPath, loadState, saveState, getStatePath, readGeneration, flushConfigWrites, flushStateWrites } from './config.js';
import { AccountManager } from './account-manager.js';
import { createProxyServer } from './server.js';
import { Prober } from './prober.js';
import { loginOAuth, fetchProfile, refreshAccessToken, isTokenExpiringSoon } from './oauth.js';
import { TUI } from './tui.js';
import { RestartController } from './restart-controller.js';
import { resolveAccounts } from './account-config.js';
import { maybeCheckForUpdate } from './updater.js';
import {
  runReloadBaton,
  RELOAD_SWAPPED, RELOAD_ROLLED_BACK,
  MSG_LISTEN, MSG_RELEASE, MSG_TAKEOVER, MSG_PROBE_READY,
  MSG_RELOAD_REQUEST, MSG_READY, MSG_FAILED, MSG_RELEASED, MSG_PRIMARY,
} from './reload-protocol.js';

const args = process.argv.slice(2);
const command = args[0];
const SERVER_RESTART_EXIT_CODE = 75;
const SERVER_WORKER_ENV = 'MAXPOOL_SERVER_WORKER';
// Set by the supervisor when it spawns a worker for a seamless reload: that
// worker boots HEADLESS (plain logs, no writer lease) and waits for the baton.
const SERVER_RELOAD_WORKER_ENV = 'MAXPOOL_RELOAD_WORKER';

switch (command) {
  case 'server':
    await serverCommand();
    break;
  case 'run':
    await runCommand();
    break;
  case 'login':
    await loginCommand();
    process.exit(0);
    break;
  case 'env':
    await envCommand();
    process.exit(0);
    break;
  case 'status':
    await statusCommand();
    process.exit(0);
    break;
  case 'accounts':
    await accountsCommand();
    process.exit(0);
    break;
  case 'remove':
    await removeCommand();
    process.exit(0);
    break;
  case 'rename':
    await renameCommand();
    process.exit(0);
    break;
  case 'api':
    await apiCommand();
    process.exit(0);
    break;
  case 'help':
  case '--help':
  case '-h':
    showHelp();
    break;
  default:
    // No command or unknown command → start server
    if (command && !command.startsWith('-')) {
      console.error(`Unknown command: ${command}\n`);
      showHelp();
      process.exit(1);
    }
    await serverCommand();
    break;
}

// ── server ──────────────────────────────────────────────────

async function serverCommand() {
  // A spawned worker (env flag set by the supervisor) runs the proxy itself.
  if (process.env[SERVER_WORKER_ENV] === '1') {
    return serverWorkerCommand();
  }

  // Non-TTY (e.g. `maxpool server` as a background service): keep the existing
  // tested direct-listen path. The seamless-reload feature is only active under
  // the TTY supervisor; a service manager already handles restart/respawn.
  // MAXPOOL_FORCE_SUPERVISOR=1 forces the supervisor path without a TTY (used by
  // the reload integration tests; the worker still runs plain-log without a TTY).
  const forceSupervisor = process.env.MAXPOOL_FORCE_SUPERVISOR === '1';
  if (!forceSupervisor && (!process.stdout.isTTY || !process.stdin.isTTY)) {
    return serverWorkerCommand();
  }

  return supervisorCommand();
}

// ── supervisor (TTY) ─────────────────────────────────────────
//
// Owns the listening socket for its whole life (never closes it) and hands the
// socket HANDLE to exactly one worker at a time over IPC. A worker requests a
// seamless reload; the supervisor spawns a fresh headless worker, runs the
// single-writer baton, then swaps. Any failure falls back to the tested abrupt
// exit-75 respawn. A crash-loop degrades to loud single-worker failure via an
// exponential backoff, never a tight fork loop.

async function supervisorCommand() {
  const { createServer } = await import('node:net');
  const config = await loadOrCreateConfig();
  const port = config.proxy.port;
  const host = config.proxy.host || '127.0.0.1';

  // Bind once. EADDRINUSE / EACCES here is a cold-start failure → exit(1) is
  // correct (there's no worker to keep alive yet).
  let masterServer = createServer();
  // We DROP any connection the supervisor accidentally accepts while a worker is
  // also accepting on the shared handle — but the design avoids that: the
  // supervisor's acceptor is only LIVE during the brief cutover gap (it stops
  // once a worker confirms it is the sole acceptor). A bare handler is required
  // so the rare gap-accepted socket isn't left dangling.
  const relistenMaster = () => new Promise((resolve, reject) => {
    if (masterServer.listening) { resolve(); return; }
    const onErr = err => { masterServer.removeListener('listening', onListen); reject(err); };
    const onListen = () => { masterServer.removeListener('error', onErr); resolve(); };
    masterServer.once('error', onErr);
    masterServer.once('listening', onListen);
    masterServer.listen(port, host);
  });
  const closeMasterAccept = () => new Promise(resolve => {
    if (!masterServer.listening) { resolve(); return; }
    masterServer.close(() => resolve());
  });
  try {
    await relistenMaster();
  } catch (err) {
    handleServerListenError(err, host, port);
    return;
  }

  // Keep the supervisor attached to the shell. The worker shares the supervisor's
  // process group, so a terminal Ctrl-C (SIGINT/SIGTERM) is delivered by the TTY
  // to BOTH already — the supervisor must NOT forward those or the worker gets a
  // doubled signal (the "second Ctrl-C force-quits" footgun). The supervisor
  // ignores SIGINT/SIGTERM itself (the worker drains + exits, ending the turn).
  let activeWorker = null;
  const forwardSignal = sig => { try { activeWorker?.child.kill(sig); } catch { /* ignore */ } };
  process.on('SIGINT', () => { /* delivered to the worker by the TTY group */ });
  process.on('SIGTERM', () => { /* delivered to the worker by the TTY group */ });
  // SIGHUP (from `kill -HUP <supervisor-pid>`) reaches ONLY the supervisor →
  // forward it so the worker requests a seamless reload.
  process.on('SIGHUP', () => forwardSignal('SIGHUP'));
  // A spawn failure / stray rejection must NOT kill the supervisor (it would
  // wedge the port and drop the service). Log and let the supervision loop or
  // the reload's own error handling recover.
  process.on('uncaughtException', err => {
    console.error(`[Maxpool] Supervisor uncaughtException (continuing): ${err?.stack || err}`);
  });
  process.on('unhandledRejection', reason => {
    console.error(`[Maxpool] Supervisor unhandledRejection (continuing): ${reason}`);
  });

  // After SIGKILLing a worker that may have owned the TUI, the worker had no
  // chance to restore the terminal — the supervisor emits the restore itself
  // (exit alt-screen + show cursor + raw off) so the user's shell is clean.
  const restoreTerminalFromSupervisor = () => {
    try {
      if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\x1b[?1049l');
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* ignore */ } }
    } catch { /* never throw */ }
  };
  process.on('exit', restoreTerminalFromSupervisor);

  // Crash-loop guard: count rapid consecutive non-restart exits and back off so
  // a worker that crashes on boot doesn't spin the CPU forking. A clean run for
  // a while resets the counter.
  let crashCount = 0;
  const CRASH_WINDOW_MS = 10_000;
  const MAX_BACKOFF_MS = 8_000;

  let reloadInFlight = false;
  // Resolver for the CURRENT supervision turn. A swap re-points monitoring to
  // the new worker WITHOUT ending the turn; only an exit/fallback resolves it.
  let endTurn = null;

  // Spawn a worker in the SAME process group as the supervisor. A terminal
  // Ctrl-C (SIGINT/SIGTERM) is delivered by the TTY to the whole foreground
  // group, so BOTH already receive it — the supervisor therefore does NOT
  // forward those (that would double-deliver). Same-group also means a group
  // SIGKILL of the supervisor reaps the worker (no orphan holding the port).
  const spawnWorker = ({ reload = false } = {}) => {
    const env = { ...process.env, [SERVER_WORKER_ENV]: '1' };
    if (reload) env[SERVER_RELOAD_WORKER_ENV] = '1';
    const child = spawn(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    });
    const worker = makeWorkerChannel(child);
    if (!reload) {
      // Cold start: hand the socket and tell it to go primary immediately.
      worker.send({ type: MSG_LISTEN }, masterServer);
    }
    return worker;
  };

  // Wire a worker as the active primary: its RELOAD_REQUEST triggers the baton;
  // its MSG_PRIMARY means it is now the sole acceptor (so the supervisor stops
  // its own competing accept loop); its exit/spawn-error ends the turn.
  const monitorAsActive = worker => {
    activeWorker = worker;
    worker.child.removeAllListeners('message');
    worker.child.on('message', msg => {
      if (msg?.type === MSG_RELOAD_REQUEST) orchestrateReload().catch(() => {});
      else if (msg?.type === MSG_PRIMARY && activeWorker === worker) {
        // The worker is now sole acceptor on the handle → stop the supervisor
        // racing it for accepts (the steady-state ~78%-hang bug). The supervisor
        // still HOLDS the socket via the worker's fd; it re-arms only at reload.
        closeMasterAccept().catch(() => {});
      }
    });
    worker.child.once('exit', (code, signal) => {
      // Only the worker that is STILL active when it exits ends the turn. A
      // reaped old worker (already swapped out) exiting must be ignored here.
      if (activeWorker === worker) endTurn?.({ code, signal });
    });
    // A spawn-time failure (EMFILE/EAGAIN under load) surfaces as 'error', not
    // 'exit' — treat it as a crashed turn so backoff handles it (M5).
    worker.child.once('error', err => {
      if (activeWorker === worker) endTurn?.({ code: 1, signal: null, spawnError: err.message });
    });
  };

  // Reload orchestration: spawn a fresh headless worker, run the baton, swap.
  const orchestrateReload = async () => {
    if (reloadInFlight) return;
    reloadInFlight = true;
    const oldWorker = activeWorker;
    let newWorker = null;
    try {
      newWorker = spawnWorker({ reload: true });
      // Hold the new worker's spawn-error so a fork failure mid-baton becomes a
      // clean ROLLED_BACK/FALLBACK instead of crashing the supervisor (M5).
      newWorker.child.once('error', () => { /* surfaced via waitFor reject */ });
      const outcome = await runReloadBaton({
        oldWorker,
        newWorker,
        handle: masterServer,
        // After the OLD worker has released its fd, re-arm the supervisor's own
        // listener to cover the cutover gap, then hand THAT live handle to the
        // new worker. The new worker's MSG_PRIMARY then closes it again.
        prepareHandle: async () => { await relistenMaster(); return masterServer; },
        log: msg => console.log(`[Maxpool] ${msg}`),
      });

      if (outcome === RELOAD_SWAPPED) {
        // Re-point monitoring to the new worker (it's now primary), THEN reap the
        // old one. Order matters: monitorAsActive sets activeWorker=new so the
        // old worker's pending exit handler no-ops. monitorAsActive also handles
        // the new worker's already-sent MSG_PRIMARY is moot here — the new worker
        // sent PRIMARY during the baton; re-assert the master-accept close.
        monitorAsActive(newWorker);
        closeMasterAccept().catch(() => {});
        reapOldWorker(oldWorker, config);
        return;
      }

      if (outcome === RELOAD_ROLLED_BACK) {
        // Old worker never released — it's still fully primary. Kill the new
        // headless worker; nothing else changed. ZERO disruption.
        try { newWorker.child.kill('SIGKILL'); } catch { /* ignore */ }
        return;
      }

      // FALLBACK: the old worker may have released; neither is reliably primary.
      // Kill both and let the respawn loop bring a fresh primary up on the
      // supervisor-owned socket. Queued conns sit in the OS backlog meanwhile.
      try { newWorker.child.kill('SIGKILL'); } catch { /* ignore */ }
      try { oldWorker.child.kill('SIGKILL'); } catch { /* ignore */ }
      restoreTerminalFromSupervisor(); // SIGKILLed workers can't restore the TUI
      activeWorker = null;
      endTurn?.({ code: null, signal: 'SIGKILL', fallback: true });
    } catch (err) {
      console.error(`[Maxpool] Reload error: ${err.message}; falling back to abrupt restart`);
      try { newWorker?.child.kill('SIGKILL'); } catch { /* ignore */ }
      try { oldWorker.child.kill('SIGKILL'); } catch { /* ignore */ }
      restoreTerminalFromSupervisor();
      activeWorker = null;
      endTurn?.({ code: null, signal: 'SIGKILL', fallback: true });
    } finally {
      reloadInFlight = false;
    }
  };

  // One supervision turn: monitor `worker` until it exits (or a fallback forces a
  // respawn). Swaps re-point monitoring without resolving. Resolves exit info.
  const superviseTurn = worker => new Promise(resolve => {
    endTurn = info => { endTurn = null; resolve(info); };
    monitorAsActive(worker);
  });

  try {
    while (true) {
      const worker = spawnWorker({ reload: false });
      const startedAt = Date.now();
      const result = await superviseTurn(worker);

      if (result.fallback) {
        // Fallback swap killed both workers; bring a fresh primary straight back.
        crashCount = 0;
        continue;
      }
      if (result.code === SERVER_RESTART_EXIT_CODE) {
        // Abrupt self-restart (worker-initiated exit-75 fallback path).
        crashCount = 0;
        continue;
      }

      // Non-restart exit. If it died fast, it's likely crash-looping on boot.
      const ranFor = Date.now() - startedAt;
      if (ranFor < CRASH_WINDOW_MS && (result.code ?? 1) !== 0) {
        crashCount++;
        const backoff = Math.min(MAX_BACKOFF_MS, 250 * 2 ** (crashCount - 1));
        console.error(`[Maxpool] Worker exited (code ${result.code}, signal ${result.signal}) after ${ranFor}ms — crash #${crashCount}. Backing off ${backoff}ms before respawn.`);
        await delay(backoff);
        continue;
      }

      // Clean shutdown (q / signal). Propagate the exit code and stop.
      if (result.signal) process.exitCode = 1;
      else process.exitCode = result.code ?? 1;
      return;
    }
  } finally {
    try { masterServer.close(); } catch { /* ignore */ }
  }
}

// Drain + reap a released worker. The worker exits itself once its bounded
// in-flight finishes; the supervisor SIGKILLs it if it outlives the drain cap.
function reapOldWorker(worker, config) {
  if (!worker) return;
  const drainTimeoutMs = Math.max(1000, Number(config.shutdown?.drainTimeoutMs) || 15_000);
  let reaped = false;
  const finish = () => { if (reaped) return; reaped = true; clearTimeout(timer); };
  const timer = setTimeout(() => {
    if (reaped) return;
    console.error(`[Maxpool] Old worker outlived ${Math.ceil(drainTimeoutMs / 1000)}s drain cap; SIGKILL.`);
    try { worker.child.kill('SIGKILL'); } catch { /* ignore */ }
    finish();
  }, drainTimeoutMs);
  timer.unref?.();
  worker.child.once('exit', finish);
}

/**
 * Wrap a child process in a small IPC channel: `.send(msg[,handle])` and an
 * async `.waitFor([types], timeoutMs)` that resolves with the first matching
 * message, or rejects on timeout / premature child exit.
 */
function makeWorkerChannel(child) {
  return {
    child,
    send(msg, handle) {
      try {
        if (handle) child.send(msg, handle);
        else child.send(msg);
      } catch { /* IPC may be torn down mid-swap; baton timeouts cover it */ }
    },
    waitFor(types, timeoutMs) {
      const want = Array.isArray(types) ? types : [types];
      return new Promise((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer);
          child.removeListener('message', onMsg);
          child.removeListener('exit', onExit);
          child.removeListener('error', onError);
        };
        const onMsg = msg => {
          if (msg && want.includes(msg.type)) { cleanup(); resolve(msg); }
        };
        const onExit = (code, signal) => {
          cleanup();
          reject(new Error(`worker exited (code ${code}, signal ${signal}) before ${want.join('/')}`));
        };
        // A spawn failure (EMFILE/EAGAIN) surfaces as 'error', not 'exit' — the
        // baton must see it as a failed step (→ ROLLED_BACK/FALLBACK), not hang.
        const onError = err => { cleanup(); reject(new Error(`worker spawn error before ${want.join('/')}: ${err.message}`)); };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`timed out waiting for ${want.join('/')}`));
        }, timeoutMs);
        timer.unref?.();
        child.on('message', onMsg);
        child.once('exit', onExit);
        child.once('error', onError);
      });
    },
  };
}

function delay(ms) {
  return new Promise(resolve => { const t = setTimeout(resolve, ms); t.unref?.(); });
}

async function serverWorkerCommand() {
  const config = await loadOrCreateConfig();

  // --log-to <dir>
  const logTo = argValue('--log-to');
  if (logTo) config.logDir = logTo;

  if (config.accounts.length === 0) {
    console.error('No accounts configured.\n');
    console.error('Add an account first:');
    console.error('  maxpool login            OAuth login via browser');
    console.error('  maxpool login --api      Add an API key');
    process.exit(1);
  }

  const accounts = await resolveAccounts(config);
  if (accounts.length === 0) {
    console.error('No valid accounts after initialization');
    process.exit(1);
  }

  const threshold = config.switchThreshold || 0.90;
  const accountManager = new AccountManager(accounts, threshold, config.scheduler || {});
  accountManager.setRoutingMode(
    config.routing?.mode,
    config.routing?.preferredAccount,
  );

  // Supervised = spawned by the TTY supervisor over IPC (handle-based listen +
  // baton). A reload worker boots HEADLESS without the writer lease and waits
  // for the baton; a cold-start worker takes the lease on MSG_LISTEN.
  const supervised = typeof process.send === 'function';
  const isReloadWorker = process.env[SERVER_RELOAD_WORKER_ENV] === '1';

  // M6: a reload worker boots WITHOUT the writer lease so the AM-level brick
  // guard (ensureTokenFresh no-op) is CLOSED for the entire headless window —
  // before any code path could trigger a refresh. acquireLease() flips it true
  // at takeover. (writerLease defaults true for the standalone/direct path.)
  if (isReloadWorker) accountManager.setWriterLease(false);

  // Restore quota observed in a previous run so a restart doesn't lose routing
  // accuracy and re-probe from scratch. Stale windows clear on first use.
  // A reload worker restores quota IN-MEMORY only (state file handed via the
  // lease holder); a cold/direct worker reads the on-disk state file.
  const savedState = await loadState();
  if (savedState?.quota) accountManager.restoreQuotaState(savedState.quota);
  // Track the state-file generation we last observed so a stale flush is refused.
  let stateGeneration = Number(savedState?._generation) || 0;

  // ── single-writer baton: refresh / probe / persistence gated by the lease ──
  // A worker without the lease writes NOTHING (no token rotation, no config
  // write, no state write, no probe). Only the lease holder may write.
  let hasLease = false;
  // `force` performs the FINAL flush during a baton release, AFTER releaseLease()
  // has already flipped hasLease=false (and cleared the periodic interval, so no
  // write races this one). Without force, this no-ops post-release and the reload's
  // learned-quota flush is silently dropped — the new worker would boot from up-to-
  // 60s-stale quota and the state generation would never advance across a reload.
  const persistQuotaState = (force = false) => {
    if (!hasLease && !force) return Promise.resolve();
    // The forced final flush (baton release / shutdown) is the SOLE writer at that
    // point — releaseLease() already cleared the periodic interval and the next
    // worker hasn't acquired the lease yet — so it bypasses the cross-worker
    // stale-generation guard. Without this, a 60s-interval write that fired just
    // before releaseLease could bump the on-disk generation and get the forced
    // flush REFUSED (dropping the final quota snapshot). The guard only exists to
    // serialize CROSS-worker writes; the final flush is provably intra-worker.
    const expectedGeneration = force ? null : stateGeneration;
    return saveState({ quota: accountManager.exportQuotaState() }, { expectedGeneration })
      .then(written => { if (written != null) stateGeneration = written; })
      .catch(() => {});
  };
  // Persist quota every minute; unref so it never keeps the process alive.
  let quotaSaveInterval = null;

  // Opt-in background quota probe (config.quotaProbeSeconds, default 0 = off).
  const prober = new Prober(accountManager, { intervalMs: (config.quotaProbeSeconds || 0) * 1000 });

  // Persist refreshed tokens back to config. Defense-in-depth: the updater reads
  // the on-disk refresh token and SKIPS the rotation if a fresher writer already
  // advanced it (generation guard), so a stale write can't double-spend a token.
  //
  // We do NOT gate this on `hasLease`: a refresh that already STARTED (it passed
  // the lease gate in ensureTokenFresh) MUST persist its rotated single-use token
  // even if the lease was dropped while its POST was in flight — otherwise the
  // baton hands off and the new worker boots from the now-invalidated on-disk
  // token (B1/M3). New refreshes can't start without the lease (ensureTokenFresh
  // no-ops), so every callback here is from a legitimate lease-era refresh.
  const persistTokenRefresh = (idx, newTokens) => {
    const account = accountManager.accounts[idx];
    if (!account) return;
    // Keep config.accounts in sync so TUI saveConfig doesn't clobber fresh tokens
    const memIdx = findConfigAccount(config, account);
    if (memIdx >= 0) {
      config.accounts[memIdx].accessToken = newTokens.accessToken;
      config.accounts[memIdx].refreshToken = newTokens.refreshToken;
      config.accounts[memIdx].expiresAt = newTokens.expiresAt;
    }
    atomicConfigUpdate(diskConfig => {
      // Pick up any new accounts from disk so index matching stays correct
      // (only add, don't refresh credentials — we're about to write the authoritative tokens)
      for (const diskAcct of diskConfig.accounts) {
        const known = (diskAcct.accountUuid && config.accounts.some(a => a.accountUuid === diskAcct.accountUuid))
          || config.accounts.some(a => a.name === diskAcct.name);
        if (!known) {
          config.accounts.push(diskAcct);
          accountManager.addAccount(diskAcct);
        }
      }
      // Match by UUID first, then by name — index may have shifted
      const cfgIdx = findConfigAccount(diskConfig, account);
      if (cfgIdx >= 0) {
        const onDisk = diskConfig.accounts[cfgIdx];
        // Generation guard: if the on-disk refresh token already advanced past
        // the token we rotated FROM, another writer beat us — skip the write so
        // we don't revert a fresher single-use token (the brick-the-account case).
        if (onDisk.refreshToken && onDisk.refreshToken !== account._refreshedFrom &&
            onDisk.refreshToken !== newTokens.refreshToken) {
          return;
        }
        onDisk.accessToken = newTokens.accessToken;
        onDisk.refreshToken = newTokens.refreshToken;
        onDisk.expiresAt = newTokens.expiresAt;
      }
    }).catch(err => {
      if (err?.code === 'STALE_GENERATION') return; // another writer advanced; benign
      console.error(`[Maxpool] Failed to save refreshed token: ${err.message}`);
    });
  };
  accountManager.onTokenRefresh(persistTokenRefresh);

  const port = config.proxy.port;
  const host = config.proxy.host || '127.0.0.1';
  // A headless reload worker NEVER drives the TUI (single-owner terminal); it
  // takes the TUI only on baton takeover. Cold/direct workers use it if on a TTY.
  const useTUI = process.stdout.isTTY && process.stdin.isTTY && !isReloadWorker;

  let tui = null;
  let server = null;
  let syncTimer = null;
  let draining = false;
  let restartController = null;

  // Best-effort terminal restore on ANY abnormal exit path (uncaughtException,
  // a bare process.exit, a crash) so the user's shell is never left in raw mode
  // or the alt-screen. Idempotent and safe even when no TUI was running.
  const restoreTerminal = () => {
    try {
      if (tui?.running) { tui.stop(); return; }
      if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\x1b[?1049l');
      if (process.stdin.isTTY) { try { process.stdin.setRawMode(false); } catch { /* ignore */ } }
    } catch { /* never throw from a restore */ }
  };
  process.on('exit', restoreTerminal);
  process.on('uncaughtException', err => {
    console.error(`[Maxpool] Worker uncaughtException: ${err?.stack || err}`);
    restoreTerminal();
    // A reload worker must NEVER exit(1) (escapes the supervisor exit-75 loop).
    // Stay alive so the supervisor's baton timeouts roll us back cleanly.
    if (!isReloadWorker) process.exit(SERVER_RESTART_EXIT_CODE);
  });
  process.on('unhandledRejection', reason => {
    console.error(`[Maxpool] Worker unhandledRejection: ${reason}`);
  });
  // Quit drains in-flight requests, then force-exits. Kept short so a single
  // 'q' / Ctrl-C / SIGTERM actually quits under a continuous request flood
  // (where there are always active requests) instead of waiting indefinitely.
  // A second signal forces an immediate exit. Override via config.shutdown.drainTimeoutMs.
  const drainTimeoutMs = Math.max(1000, Number(config.shutdown?.drainTimeoutMs) || 15_000);
  const hooks = {
    onRequestStart: (id, info) => {
      const accepted = restartController.requestStarted(id);
      if (accepted) tui?.onRequestStart(id, info);
      return accepted;
    },
    onRequestRouted: (id, info) => {
      restartController.requestRouted(id, info.account);
      tui?.onRequestRouted(id, info);
    },
    onRequestEnd: (id, info) => {
      restartController.requestEnded(id);
      tui?.onRequestEnd(id, info);
    },
  };

  // ── writer lease (single-writer baton) ──
  // Acquiring the lease turns ON token rotation, the quota-save interval, and the
  // prober. Releasing turns them all OFF and flushes once. Exactly one worker
  // holds the lease at a time — enforced by the supervisor's baton sequencing.
  const acquireLease = async () => {
    if (hasLease) return;
    // M4: re-read the on-disk state generation NOW. A reload's old worker bumped
    // it during its final flush; without this re-sync the new primary's
    // saveState(expectedGeneration=<boot N>) would be refused for its whole
    // tenure (quota persistence wedged forever). As sole writer it safely adopts
    // the current on-disk generation.
    try { stateGeneration = await readGeneration(getStatePath()); } catch { /* keep prior */ }
    hasLease = true;
    accountManager.setWriterLease(true);
    if (!quotaSaveInterval) {
      quotaSaveInterval = setInterval(() => { persistQuotaState(); }, 60_000);
      quotaSaveInterval.unref?.();
    }
    prober.start();
  };
  // Stop scheduling writes and flip the lease. Returns a promise that settles
  // once any in-flight prober cycle has finished (so no probe-driven token
  // rotation is still pending). Token-refresh draining is awaited separately in
  // the baton release (drainRefreshes) before the lease is handed off.
  const releaseLease = async () => {
    if (!hasLease) return;
    hasLease = false;
    if (quotaSaveInterval) { clearInterval(quotaSaveInterval); quotaSaveInterval = null; }
    accountManager.setWriterLease(false);
    await prober.stop(); // awaits any in-flight probe cycle (B1)
  };

  // Abrupt self-restart — the tested fallback path. Cuts in-flight connections;
  // clients retry ~2s. Used when NOT supervised, or when a seamless reload can't
  // be requested. NEVER exit(1) here (that escapes the exit-75 supervisor loop).
  const restartWorkerNow = () => {
    if (draining) return;
    draining = true;
    if (syncTimer) clearInterval(syncTimer);
    if (tui?.running) { tui.stop(); }
    console.log('\n[Maxpool] Restarting server now; queued requests will reconnect automatically.');
    server.closeAllConnections?.();
    // Best-effort: flush quota + settle in-flight refreshes/prober before exit so
    // the respawned worker doesn't boot from a half-written state. Bounded so the
    // abrupt path stays fast even if a write hangs.
    Promise.race([
      (async () => { await persistQuotaState(); await releaseLease(); await flushConfigWrites(); await flushStateWrites(); })(),
      delay(2000),
    ]).finally(() => process.exit(SERVER_RESTART_EXIT_CODE));
  };

  // Seamless reload entry point. When supervised, ask the supervisor to run the
  // baton (spawn new worker, hand off socket + lease). If anything is off
  // (not supervised, no IPC), fall back to the abrupt restart.
  const requestReload = () => {
    if (draining) return;
    if (supervised) {
      try {
        process.send({ type: MSG_RELOAD_REQUEST });
        return;
      } catch { /* IPC gone — fall through to abrupt restart */ }
    }
    restartWorkerNow();
  };

  restartController = new RestartController({
    pauseAdmission: () => accountManager.setAdmissionPaused(true),
    restartNow: requestReload,
  });

  const shutdownGracefully = (reason, options = {}) => {
    if (draining) {
      console.error(`\n[Maxpool] Force exiting with ${restartController.activeRequests.size} active request(s) still open.`);
      process.exit(1);
    }

    draining = true;
    if (syncTimer) clearInterval(syncTimer);
    if (tui?.running) tui.stop();
    // Best-effort final flush + settle writes (fire-and-forget; the drain timeout
    // below bounds total quit time, and write barriers protect the on-disk state).
    (async () => {
      await releaseLease();
      await accountManager.drainRefreshes();
      await persistQuotaState(true); // force: lease already dropped above (else no-op)
      await flushConfigWrites();
      await flushStateWrites();
    })().catch(() => {});

    console.log(`\n[Maxpool] Draining shutdown (${reason}).`);
    console.log(`[Maxpool] Stopped accepting new requests; waiting up to ${Math.ceil(drainTimeoutMs / 1000)}s for ${restartController.activeRequests.size} active request(s), then forcing exit. Press Ctrl-C again to force now.`);

    let done = false;
    let reportTimer = null;
    let timeoutTimer = null;
    const finish = code => {
      if (done) return;
      done = true;
      if (reportTimer) clearInterval(reportTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (options.restart && code === 0) {
        console.log('[Maxpool] Restarting server...');
        process.exit(SERVER_RESTART_EXIT_CODE);
      }
      process.exit(code);
    };

    reportTimer = setInterval(() => {
      console.log(`[Maxpool] Still draining ${restartController.activeRequests.size} active request(s)...`);
    }, 5000);
    reportTimer.unref();

    timeoutTimer = setTimeout(() => {
      console.error(`[Maxpool] Drain timeout after ${Math.ceil(drainTimeoutMs / 1000)}s; exiting with ${restartController.activeRequests.size} active request(s) still open.`);
      finish(1);
    }, drainTimeoutMs);
    timeoutTimer.unref();

    server.close(err => {
      if (err) {
        console.error(`[Maxpool] Shutdown error: ${err.message}`);
        finish(1);
        return;
      }
      console.log('[Maxpool] Shutdown complete.');
      finish(0);
    });
    server.closeIdleConnections?.();
  };

  if (useTUI) {
    tui = new TUI({
      accountManager, config,
      saveConfig: () => atomicConfigUpdate(async diskConfig => {
        diskConfig.routing = {
          mode: config.routing?.mode || 'automatic',
          preferredAccount: config.routing?.preferredAccount || null,
        };
        // Write in-memory accounts as the authoritative state, preserving
        // extra disk-only fields (e.g. importFrom) where the account still exists.
        // Use live tokens from AccountManager (not the stale config.accounts copy).
        diskConfig.accounts = config.accounts.map(a => {
          const am = accountManager.accounts.find(candidate =>
            (a.accountUuid && candidate.accountUuid === a.accountUuid) || candidate.name === a.name
          );
          const live = am ? {
            ...a,
            accessToken: am.credential,
            refreshToken: am.refreshToken,
            expiresAt: am.expiresAt,
          } : a;
          const diskAcct = diskConfig.accounts.find(
            d => (a.accountUuid && d.accountUuid === a.accountUuid) || d.name === a.name
          );
          return diskAcct ? { ...diskAcct, ...live } : live;
        });
      }),
      syncAccounts: async () => {
        const diskConfig = await loadConfig();
        if (!diskConfig) return 0;
        return syncAccountsFromDisk(diskConfig, config, accountManager);
      },
      onQuit: () => {
        shutdownGracefully('quit');
      },
      onRestart: () => {
        restartController.requestRestart();
      },
    });
  }

  server = createProxyServer(accountManager, config, hooks);
  let syncInFlight = false;
  const syncIntervalMs = config.sync?.accountsIntervalMs ?? 15_000;
  syncTimer = setInterval(async () => {
    if (syncInFlight) return;
    syncInFlight = true;
    try {
      const diskConfig = await loadConfig();
      if (!diskConfig) return;
      const added = await syncAccountsFromDisk(diskConfig, config, accountManager);
      if (added && tui) tui._addLog(`Auto-loaded ${added} account(s) from config`);
    } catch (err) {
      console.error(`[Maxpool] Account auto-sync failed: ${err.message}`);
    } finally {
      syncInFlight = false;
    }
  }, syncIntervalMs);
  syncTimer.unref();

  // Become the live primary: start serving UI/logs, take the writer lease, run
  // the update check. `viaTakeover` true means we acquired the socket through the
  // baton (a reload) — freeze the update check so a reload doesn't re-probe npm
  // (only a cold supervisor start self-updates).
  const becomePrimary = async ({ viaTakeover }) => {
    if (tui) {
      if (tui.start()) {
        console.log(`Listening on ${host}:${port} with ${accounts.length} account(s)`);
      } else {
        tui = null;
        logPlainServerStart({ host, port, accounts, threshold, config });
      }
    } else {
      logPlainServerStart({ host, port, accounts, threshold, config });
    }
    // On a reload TAKEOVER, adopt the latest tokens from disk. The headless
    // reload worker loaded config at spawn time; the OLD worker may have rotated
    // a single-use refresh token DURING the handoff (and flushed it before
    // MSG_RELEASED). Without this re-sync the new worker would present the now-
    // invalidated token on its first refresh → invalid_grant → bricked account.
    if (viaTakeover) {
      try {
        const diskConfig = await loadConfig();
        if (diskConfig) await syncAccountsFromDisk(diskConfig, config, accountManager);
      } catch (err) {
        console.error(`[Maxpool] Token re-sync at takeover failed: ${err.message}`);
      }
    }

    // Acquire the lease (re-syncs state generation + enables writes) BEFORE we
    // announce primacy, so the moment the supervisor reaps the old worker we are
    // a fully-functional sole writer.
    await acquireLease();

    // Tell the supervisor we are the sole acceptor now → it stops its own accept
    // loop (the steady-state race fix). Cold start AND takeover both signal this.
    if (supervised) { try { process.send({ type: MSG_PRIMARY }); } catch { /* ignore */ } }

    // Reload-storm guard: only a cold (non-reload) lease holder probes npm.
    // A reload-spawned/takeover worker must NEVER re-probe (1x not 2x traffic).
    if (!viaTakeover && !isReloadWorker) {
      if (process.env.MAXPOOL_TEST_LOG_UPDATE_CHECK === '1') console.log('[Maxpool] UPDATE_CHECK_FIRED');
      const notify = msg => (tui?._addLog ? tui._addLog(msg) : console.log(`[Maxpool] ${msg}`));
      maybeCheckForUpdate(config, notify).catch(() => {});
    } else if (process.env.MAXPOOL_TEST_LOG_UPDATE_CHECK === '1') {
      console.log('[Maxpool] UPDATE_CHECK_SKIPPED (reload)');
    }
  };

  // ── start accepting ──
  if (supervised) {
    // Supervised: NEVER listen(port) directly — the supervisor owns the socket.
    // Wait for the baton over IPC. A cold worker gets MSG_LISTEN; a reload worker
    // boots headless (already done above) and waits for MSG_PROBE_READY/TAKEOVER.
    server.on('error', err => console.error(`[Maxpool] Server error: ${err.message}`));

    const listenOnHandle = handle => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(handle, () => { server.removeListener('error', reject); resolve(); });
    });

    // Baton release: the old primary gives up acceptance + the writer lease.
    // MSG_RELEASED MUST mean "no write is in flight" — not merely "flag flipped"
    // — so the new worker can acquire the lease and rotate the single-use refresh
    // token WITHOUT racing a still-pending rotation here (B1) and boots from a
    // config that already has any rotated token persisted (M3).
    const releaseBatonAndDrain = async () => {
      if (draining) { try { process.send({ type: MSG_RELEASED }); } catch { /* ignore */ } return; }
      draining = true;
      if (syncTimer) clearInterval(syncTimer);
      // Stop accepting NEW connections; KEEP in-flight requests alive.
      server.maxpoolBeginDrain?.();
      server.close(() => {});
      server.closeIdleConnections?.(); // retire idle keep-alive sockets now

      // 1) Stop scheduling writes + flip the lease + await any in-flight prober
      //    cycle (releaseLease awaits prober.stop()).
      await releaseLease();
      // 2) Await every in-flight OAuth token refresh that started before the lease
      //    dropped — the headline brick hazard (B1).
      await accountManager.drainRefreshes();
      // 3) Final flush of learned quota. FORCE it: releaseLease() above already
      //    flipped hasLease=false, and persistQuotaState no-ops without the lease —
      //    so an unforced call here silently drops the reload's final quota flush.
      await persistQuotaState(true);
      // 4) Barrier: ensure every queued config write (a rotated-token persist is
      //    fire-and-forget) AND state write has actually hit disk before we hand
      //    off (M3 — otherwise the new worker boots from the invalidated token).
      await flushConfigWrites();
      await flushStateWrites();

      if (tui?.running) tui.stop(); // restore terminal before the new worker takes it
      try { process.send({ type: MSG_RELEASED }); } catch { /* ignore */ }

      // Drain bounded in-flight on EXISTING access tokens (no refresh needed),
      // then exit(0). The supervisor SIGKILLs us if we outlive its drain cap.
      const waitForDrain = () => {
        if (restartController.activeRequests.size === 0) { process.exit(0); return; }
      };
      const drainPoll = setInterval(waitForDrain, 200);
      drainPoll.unref?.();
      const hardCap = setTimeout(() => {
        console.error(`[Maxpool] Released worker drain cap reached with ${restartController.activeRequests.size} active; exiting.`);
        process.exit(0);
      }, drainTimeoutMs);
      hardCap.unref?.();
      waitForDrain();
    };

    process.on('message', async (msg, handle) => {
      try {
        if (msg?.type === MSG_LISTEN && handle) {
          // Cold start: take the socket and go primary immediately.
          await listenOnHandle(handle);
          await becomePrimary({ viaTakeover: false });
        } else if (msg?.type === MSG_PROBE_READY) {
          // Headless reload worker: we've booted the new code and restored quota
          // in memory. Confirm readiness (we are NOT yet accepting / writing).
          // Test hook: simulate a new-version that fails to boot → forces the
          // supervisor's rollback (old worker stays primary, zero disruption).
          if (process.env.MAXPOOL_TEST_FAIL_RELOAD_WORKER === '1') {
            process.send({ type: MSG_FAILED, reason: 'test-forced failure' });
          } else {
            process.send({ type: MSG_READY });
          }
        } else if (msg?.type === MSG_TAKEOVER && handle) {
          // Baton acquire: the old worker already released, so we're the SOLE
          // acceptor. Start accepting + take the writer lease + TUI. becomePrimary
          // sends MSG_PRIMARY (the baton waits on it).
          await listenOnHandle(handle);
          await becomePrimary({ viaTakeover: true });
        } else if (msg?.type === MSG_RELEASE) {
          // Baton release: stop accepting NEW (keep in-flight), retire keep-alive
          // sockets with Connection: close, stop writing, flush once, drop TUI.
          await releaseBatonAndDrain();
        }
      } catch (err) {
        // A failed reload worker must NOT exit(1) (kills the supervisor loop).
        // Report failure so the supervisor rolls back; stay alive harmlessly.
        console.error(`[Maxpool] Reload worker error: ${err.message}`);
        try { process.send({ type: MSG_FAILED, reason: err.message }); } catch { /* ignore */ }
      }
    });
  } else {
    // Direct (non-TTY service) path: bind the port ourselves, exactly as before.
    const onListenError = err => handleServerListenError(err, host, port);
    server.once('error', onListenError);
    server.listen(port, host, () => {
      server.removeListener('error', onListenError);
      server.on('error', err => console.error(`[Maxpool] Server error: ${err.message}`));
      becomePrimary({ viaTakeover: false }).catch(err => console.error(`[Maxpool] ${err.message}`));
    });
  }

  process.on('SIGINT', () => shutdownGracefully('SIGINT'));
  process.on('SIGTERM', () => shutdownGracefully('SIGTERM'));
  // SIGHUP requests a seamless reload (the conventional "reload" signal). Under
  // the supervisor this runs the baton; otherwise it falls back to exit-75.
  process.on('SIGHUP', () => requestReload());
}

function logPlainServerStart({ host, port, accounts, threshold, config }) {
  const sep = '='.repeat(60);
  console.log('');
  console.log(sep);
  console.log('  Maxpool Proxy');
  console.log(sep);
  console.log(`  Listen:     ${host}:${port}`);
  console.log(`  Accounts:   ${accounts.length}`);
  console.log(`  Threshold:  ${(threshold * 100).toFixed(0)}%`);
  console.log(`  Scheduler:  adaptive least-loaded`);
  console.log(`  Upstream:   ${config.upstream || 'https://api.anthropic.com'}`);
  console.log('');
  accounts.forEach((a, i) => {
    console.log(`  [${i + 1}] ${a.name} (${a.type})`);
  });
  console.log('');
  console.log('  Run Claude through proxy:  maxpool run');
  console.log('  Show env vars:             maxpool env');
  console.log(sep);
  console.log('');
}

// ── login ───────────────────────────────────────────────────

async function loginCommand() {
  if (args.includes('--api')) {
    await loginApiCommand();
    return;
  }
  if (args.includes('--oauth')) {
    await loginOAuthCommand();
    return;
  }

  // Default to OAuth if not a TTY
  if (!process.stdout.isTTY) {
    await loginOAuthCommand();
    return;
  }

  // Interactive menu
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  console.log('Select login method:\n');
  console.log('  1. Claude subscription  (Pro, Max, Team, Enterprise)');
  console.log('  2. Anthropic API key    (Console API billing)');
  console.log('');
  const choice = await new Promise(resolve => rl.question('Choice [1]: ', resolve));
  rl.close();

  switch (choice.trim() || '1') {
    case '1': await loginOAuthCommand(); break;
    case '2': await loginApiCommand(); break;
    default:
      console.error(`Invalid choice: ${choice.trim()}`);
      process.exit(1);
  }
}

async function loginApiCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const apiKey = await new Promise(resolve => rl.question('Anthropic API key: ', resolve));
  rl.close();

  if (!apiKey.trim()) {
    console.error('No API key provided');
    process.exit(1);
  }

  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('api-')).length + 1;
    name = `api-${n}`;
  }

  config.accounts.push({ name, type: 'apikey', apiKey: apiKey.trim() });
  await saveConfig(config);
  console.log(`Added API key account "${name}"`);
  console.log(`Saved to ${getConfigPath()}`);
}

async function loginOAuthCommand() {
  const config = await loadOrCreateConfig();
  let name = argValue('--name');

  console.log('Starting OAuth login...');
  console.log('Note: this adds whatever account you are currently signed into at claude.ai —');
  console.log('there is no account picker. To add a DIFFERENT account, sign into THAT account at');
  console.log('claude.ai first (or use a logged-out / incognito browser window), then continue.');
  let creds;
  try {
    creds = await loginOAuth();
  } catch (err) {
    console.error(`OAuth login failed: ${err.message}`);
    console.error('');
    console.error('Alternatives:');
    console.error('  maxpool login --api   Add an API key instead');
    process.exit(1);
  }

  await upsertOAuthAccount(config, name, creds, 'login');
}

// ── env ─────────────────────────────────────────────────────

async function envCommand() {
  const config = await loadOrCreateConfig();
  console.log(`export ANTHROPIC_BASE_URL=http://${config.proxy.host || '127.0.0.1'}:${config.proxy.port}`);
  if (args.includes('--with-key')) {
    console.log(`export ANTHROPIC_API_KEY=${config.proxy.apiKey}`);
  }
}

// ── run ─────────────────────────────────────────────────────

async function runCommand() {
  const config = await loadOrCreateConfig();

  // Everything after 'run' (skip -- separator if present)
  const claudeArgs = args.slice(1);
  if (claudeArgs[0] === '--') claudeArgs.shift();

  // Only set ANTHROPIC_BASE_URL — Claude Code keeps its own OAuth token
  // which the proxy accepts from localhost. Not setting ANTHROPIC_API_KEY
  // lets Claude Code stay in subscription mode (full model access).
  // Use spawnSync so the Node process blocks entirely — behaves like execvp.
  const result = spawnSync('claude', claudeArgs, {
    stdio: 'inherit',
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: `http://${config.proxy.host || '127.0.0.1'}:${config.proxy.port}`,
    },
  });

  if (result.error) {
    if (result.error.code === 'ENOENT') {
      console.error('Claude Code not found in PATH. Install it first.');
    } else {
      console.error(`Failed to start claude: ${result.error.message}`);
    }
    process.exit(1);
  }

  process.exit(result.status ?? 1);
}

// ── status ──────────────────────────────────────────────────

async function statusCommand() {
  const config = await loadOrCreateConfig();
  const url = `http://${config.proxy.host || '127.0.0.1'}:${config.proxy.port}/maxpool/status`;

  try {
    const res = await fetch(url, { headers: { 'x-api-key': config.proxy.apiKey } });
    const data = await res.json();

    const routing = data.routing?.mode === 'preferred'
      ? `prefer ${data.routing.preferredAccount} with automatic failover`
      : 'automatic load balancing';
    console.log(`Routing:        ${routing}`);
    console.log(`Last selected:  ${data.currentAccount}`);
    console.log(`Switch at:      ${(data.switchThreshold * 100).toFixed(0)}% usage\n`);
    if (data.upstreamThrottle?.active || data.upstreamThrottle?.queued) {
      const state = data.upstreamThrottle.active
        ? data.upstreamThrottle.probeInFlight
          ? 'probing recovery'
          : `retry at ${data.upstreamThrottle.until}`
        : 'recovering';
      const queued = data.upstreamThrottle.queued || 0;
      const oldest = queued ? `, oldest ${formatDurationMs(data.upstreamThrottle.oldestQueuedMs)}` : '';
      console.log(`Anthropic:      temporarily throttled (${state}, queued ${queued}${oldest})\n`);
    }

    for (const acct of data.accounts) {
      const q = acct.quota;
      const current = acct.name === data.currentAccount ? ' *' : '';

      console.log(`  ${acct.name} (${acct.type})${current}`);
      console.log(`    Status:   ${acct.enabled === false ? 'disabled' : acct.status}`);
      console.log(`    Load:     current ${acct.load?.current?.inFlight || 0}/${acct.load?.current?.activeWeight || 0} weight, 15m ${formatLoadWindow(acct.load?.last15m)}, 1h ${formatLoadWindow(acct.load?.last1h)}`);

      if (acct.type === 'provider') {
        const last = acct.lastStatus ? `${acct.lastStatus} in ${formatDurationMs(acct.lastResponseMs)}` : '-';
        console.log(`    Active:   ${acct.inFlight}    OK: ${acct.completedRequests}    Failed: ${acct.failedRequests}`);
        console.log(`    Last:     ${last}`);
        if (q.genericLimit != null && q.genericRemaining != null) {
          const used = q.genericLimit - q.genericRemaining;
          const reset = q.genericReset ? `    Reset: ${new Date(q.genericReset).toISOString()}` : '';
          console.log(`    Limit:    ${used}/${q.genericLimit} used${reset}`);
        }
      } else if (q.unified5h != null || q.unified7d != null) {
        const ses = q.unified5h != null ? (q.unified5h * 100).toFixed(1) + '%' : '-';
        const wk = q.unified7d != null ? (q.unified7d * 100).toFixed(1) + '%' : '-';
        console.log(`    Session:  ${ses} used    Weekly: ${wk} used`);
      } else {
        const tok = q.tokensLimit ? ((1 - q.tokensRemaining / q.tokensLimit) * 100).toFixed(1) + '%' : '-';
        const req = q.requestsLimit ? ((1 - q.requestsRemaining / q.requestsLimit) * 100).toFixed(1) + '%' : '-';
        console.log(`    Tokens:   ${tok} used    Requests: ${req} used`);
      }

      console.log(`    Total:    ${acct.usage.totalInputTokens + acct.usage.totalOutputTokens} tokens, ${acct.usage.totalRequests} requests`);
      if (acct.rateLimitedUntil) console.log(`    Throttled until: ${acct.rateLimitedUntil}`);
      console.log('');
    }
  } catch {
    console.error(`Cannot connect to proxy at ${config.proxy.host || '127.0.0.1'}:${config.proxy.port}`);
    console.error('Is the server running? Start with: maxpool server');
    process.exit(1);
  }
}

// ── accounts ────────────────────────────────────────────────

async function accountsCommand() {
  const config = await loadOrCreateConfig();
  const verbose = args.includes('-v') || args.includes('--verbose');

  if (config.accounts.length === 0) {
    console.log('No accounts configured.');
    console.log('Add one with: maxpool login (browser) or maxpool login --api');
    return;
  }

  // Refresh expired tokens before fetching profiles
  let configDirty = false;
  await Promise.all(config.accounts.map(async (a) => {
    if (a.type !== 'oauth' || !a.refreshToken) return;
    if (!isTokenExpiringSoon(a.expiresAt)) return;
    try {
      const newTokens = await refreshAccessToken(a.refreshToken);
      a.accessToken = newTokens.accessToken;
      a.refreshToken = newTokens.refreshToken;
      a.expiresAt = newTokens.expiresAt;
      configDirty = true;
    } catch {
      // refresh failed — fetchProfile will report the specific error
    }
  }));
  if (configDirty) await saveConfig(config);

  // Fetch profiles in parallel for all OAuth accounts
  const profiles = await Promise.all(
    config.accounts.map(a =>
      a.type === 'oauth' && a.accessToken ? fetchProfile(a.accessToken) : null
    )
  );

  // Deduplicate by accountUuid — keep the last (most recently added) entry
  const seen = new Map();
  let removed = 0;
  for (let i = config.accounts.length - 1; i >= 0; i--) {
    const a = config.accounts[i];
    const uuid = profiles[i]?.accountUuid || a.accountUuid;
    if (uuid) {
      if (seen.has(uuid)) {
        config.accounts.splice(i, 1);
        profiles.splice(i, 1);
        removed++;
      } else {
        seen.set(uuid, i);
        // Update stored UUID and name from profile
        if (profiles[i] && !profiles[i].error) {
          a.accountUuid = profiles[i].accountUuid;
          if (profiles[i].email) a.name = profiles[i].email;
        }
      }
    }
  }
  if (removed > 0) {
    await saveConfig(config);
    console.log(`Removed ${removed} duplicate account(s)\n`);
  }

  for (const [i, a] of config.accounts.entries()) {
    const p = profiles[i];

    if (a.type === 'apikey') {
      console.log(`  [${i + 1}] ${a.name} (apikey)  ${a.apiKey?.slice(0, 15)}...`);
      continue;
    }

    // OAuth account
    const hasProfile = p && !p.error;
    const tier = hasProfile ? (p.hasClaudeMax ? 'Max' : p.hasClaudePro ? 'Pro' : 'subscription') : null;
    const status = hasProfile ? `Claude ${tier}` : `unknown (${p?.error || 'no token'})`;
    const src = a.source ? `, ${a.source}` : '';
    console.log(`  [${i + 1}] ${a.name} (${status}${src})`);
    if (hasProfile && p.email && p.email !== a.name) console.log(`       Email: ${p.email}`);
    if (hasProfile && p.orgName) console.log(`       Org:   ${p.orgName}`);
    if (verbose && a.expiresAt) {
      const remaining = a.expiresAt - Date.now();
      if (remaining <= 0) {
        console.log(`       Token: expired`);
      } else {
        const mins = Math.floor(remaining / 60000);
        const hrs = Math.floor(mins / 60);
        const expiry = hrs > 0 ? `${hrs}h ${mins % 60}m` : `${mins}m`;
        console.log(`       Token: expires in ${expiry}`);
      }
    }
  }
}

// ── api ─────────────────────────────────────────────────────

async function apiCommand() {
  const config = await loadOrCreateConfig();
  const path = args[1];

  if (!path) {
    console.error('Usage: maxpool api <path> [--account NAME] [--method POST] [--data JSON]');
    console.error('Example: maxpool api /api/oauth/claude_cli/roles');
    process.exit(1);
  }

  // Find account to use
  const accountName = argValue('--account');
  const method = (argValue('--method') || 'GET').toUpperCase();
  const data = argValue('--data');

  const accounts = await resolveAccounts(config);
  let account;
  if (accountName) {
    account = accounts.find(a => a.name === accountName);
    if (!account) { console.error(`Account "${accountName}" not found`); process.exit(1); }
  } else {
    account = accounts.find(a => a.type === 'oauth') || accounts[0];
    if (!account) { console.error('No accounts configured'); process.exit(1); }
  }

  const credential = account.accessToken || account.apiKey;
  const isOAuth = account.type === 'oauth';
  const upstream = config.upstream || 'https://api.anthropic.com';
  const url = path.startsWith('http') ? path : `${upstream}${path}`;

  const headers = isOAuth
    ? { 'Authorization': `Bearer ${credential}` }
    : { 'x-api-key': credential };

  const fetchOpts = { method, headers };
  if (data) {
    headers['Content-Type'] = 'application/json';
    fetchOpts.body = data;
  }

  const res = await fetch(url, fetchOpts);

  // Print response headers to stderr
  console.error(`${res.status} ${res.statusText}`);
  for (const [k, v] of res.headers.entries()) {
    console.error(`  ${k}: ${v}`);
  }
  console.error('');

  // Print body to stdout
  const body = await res.text();
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2));
  } catch {
    console.log(body);
  }
}

// ── remove ──────────────────────────────────────────────────

async function removeCommand() {
  const config = await loadOrCreateConfig();
  const name = args[1];

  if (!name) {
    console.error('Usage: maxpool remove <account-name>');
    process.exit(1);
  }

  const idx = config.accounts.findIndex(a => a.name === name);
  if (idx < 0) {
    console.error(`Account "${name}" not found`);
    process.exit(1);
  }

  config.accounts.splice(idx, 1);
  await saveConfig(config);
  console.log(`Removed account "${name}"`);
}

// Resolve an account by exact name, else by 1-based index. Returns -1 if none.
function resolveAccountIndex(accounts, target) {
  let idx = accounts.findIndex(a => a.name === target);
  if (idx < 0 && /^\d+$/.test(String(target))) idx = Number(target) - 1;
  return idx >= 0 && idx < accounts.length ? idx : -1;
}

async function renameCommand() {
  const config = await loadOrCreateConfig();
  const target = args[1];
  const newName = args[2];

  if (!target || !newName) {
    console.error('Usage: maxpool rename <account-name|number> <new-name>');
    process.exit(1);
  }

  const idx = resolveAccountIndex(config.accounts, target);
  if (idx < 0) {
    console.error(`Account "${target}" not found`);
    process.exit(1);
  }
  if (config.accounts.some((a, i) => i !== idx && a.name === newName)) {
    console.error(`An account named "${newName}" already exists`);
    process.exit(1);
  }

  const old = config.accounts[idx].name;
  config.accounts[idx].name = newName;
  // Keep manual-preference routing pointing at the renamed account.
  if (config.routing?.preferredAccount === old) config.routing.preferredAccount = newName;
  await saveConfig(config);
  console.log(`Renamed "${old}" → "${newName}"`);
  console.log('Restart maxpool to apply this to a running proxy (or rename live from the TUI: a → n).');
}

// ── help ────────────────────────────────────────────────────

function showHelp() {
  console.log(`Maxpool - Multi-account Claude proxy

Usage: maxpool [command] [options]

Commands:
  server              Start the proxy server (default)
  login               OAuth login via browser (adds the account you're signed into at claude.ai)
  login --api         Add an API key account
  env [--with-key]    Print env vars to use with Claude
  run [-- args...]    Run Claude Code through the proxy
  status              Show proxy & account status (live)
  accounts            List configured accounts
  remove <name>       Remove an account
  rename <name|#> <new>  Rename an account (by name or list number)
  api <path>          Call an API endpoint with account credentials
  help                Show this help

Options:
  --name NAME         Set account name (login)
  --log-to DIR        Log full requests/responses to DIR (server, one file per request)
  --with-key          Include proxy API key in maxpool env output

Config: ${getConfigPath()}
`);
}

// ── shared account upsert ────────────────────────────────────

async function upsertOAuthAccount(config, name, creds, source = 'unknown') {
  // Fetch profile to auto-name and deduplicate by account UUID
  const profile = await fetchProfile(creds.accessToken);
  const profileOk = profile && !profile.error;

  if (!profileOk) {
    console.error(`Warning: could not fetch account profile — ${profile?.error || 'no token'}`);
  }
  if (!name && profile?.email) {
    name = profile.email;
    const tier = profile.hasClaudeMax ? 'Max' : profile.hasClaudePro ? 'Pro' : null;
    if (tier) console.log(`Detected Claude ${tier} account: ${profile.email}`);
  }
  if (!name) {
    const n = config.accounts.filter(a => a.name.startsWith('account-')).length + 1;
    name = `account-${n}`;
  }

  const account = {
    name,
    type: 'oauth',
    source,
    accountUuid: profile?.accountUuid || null,
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
  };

  // Deduplicate: match by UUID first, then by name
  let idx = profile?.accountUuid
    ? config.accounts.findIndex(a => a.accountUuid === profile.accountUuid)
    : -1;
  if (idx < 0) idx = config.accounts.findIndex(a => a.name === name);

  if (idx >= 0) {
    config.accounts[idx] = account;
    console.log(`Updated account "${name}"`);
  } else {
    config.accounts.push(account);
    console.log(`Added account "${name}"`);
  }

  await saveConfig(config);
  console.log(`Saved to ${getConfigPath()}`);
}

// ── config sync helpers ─────────────────────────────────────

/**
 * Find a config account entry matching an in-memory account (by UUID, then name).
 */
function findConfigAccount(diskConfig, account) {
  if (account.accountUuid) {
    const idx = diskConfig.accounts.findIndex(a => a.accountUuid === account.accountUuid);
    if (idx >= 0) return idx;
  }
  return diskConfig.accounts.findIndex(a => a.name === account.name);
}

/**
 * Sync accounts from disk config: add new accounts and refresh credentials
 * for existing ones (handles re-imported OAuth tokens, rotated API keys, etc.).
 * Returns the number of new accounts added.
 */
async function syncAccountsFromDisk(diskConfig, memConfig, accountManager) {
  let added = 0;
  for (const diskAcct of diskConfig.accounts) {
    const matchByUuid = diskAcct.accountUuid
      ? memConfig.accounts.findIndex(a => a.accountUuid === diskAcct.accountUuid)
      : -1;
    const matchByName = memConfig.accounts.findIndex(a => a.name === diskAcct.name);
    const memIdx = (matchByUuid >= 0 ? matchByUuid : null) ?? (matchByName >= 0 ? matchByName : -1);

    if (memIdx < 0) {
      // New account discovered on disk — add to running server
      memConfig.accounts.push(diskAcct);
      accountManager.addAccount(diskAcct);
      added++;
      console.log(`[Maxpool] Picked up new account "${diskAcct.name}" from config`);
      continue;
    }

    // Existing account — resolve fresh credentials from disk
    let freshCred = null;
    if (diskAcct.type === 'oauth' && diskAcct.accessToken) {
      freshCred = { accessToken: diskAcct.accessToken, refreshToken: diskAcct.refreshToken, expiresAt: diskAcct.expiresAt };
    } else if (diskAcct.type === 'apikey' && diskAcct.apiKey) {
      freshCred = { apiKey: diskAcct.apiKey };
    } else if (diskAcct.type === 'provider' && (diskAcct.authToken || diskAcct.apiKey)) {
      freshCred = { authToken: diskAcct.authToken || diskAcct.apiKey };
    }

    if (!freshCred) continue;

    // Find the corresponding AccountManager entry and update credentials
    const mgr = accountManager.accounts.find(a =>
      (diskAcct.accountUuid && a.accountUuid === diskAcct.accountUuid) || a.name === diskAcct.name
    );
    if (!mgr) continue;
    const enabled = diskAcct.enabled !== false;
    if (mgr.enabled !== enabled) {
      accountManager.setAccountEnabled(mgr.index, enabled);
      console.log(`[Maxpool] ${enabled ? 'Enabled' : 'Disabled'} account "${mgr.name}" from config`);
    }
    memConfig.accounts[memIdx] = { ...memConfig.accounts[memIdx], ...diskAcct };

    if (freshCred.accessToken) {
      const changed = mgr.credential !== freshCred.accessToken ||
        mgr.refreshToken !== freshCred.refreshToken;
      // Don't overwrite in-memory credentials with staler ones from disk
      // (e.g. after a TUI import updated the AM before saveConfig wrote to disk)
      const diskIsStaler = freshCred.expiresAt && mgr.expiresAt &&
        freshCred.expiresAt < mgr.expiresAt;
      if (changed && !diskIsStaler) {
        accountManager.updateAccountTokens(mgr.index, freshCred);
        console.log(`[Maxpool] Refreshed credentials for "${mgr.name}"`);
      }
    } else if (freshCred.apiKey && mgr.credential !== freshCred.apiKey) {
      mgr.credential = freshCred.apiKey;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[Maxpool] Updated API key for "${mgr.name}"`);
    } else if (freshCred.authToken && mgr.credential !== freshCred.authToken) {
      mgr.credential = freshCred.authToken;
      if (mgr.status === 'error') mgr.status = 'active';
      console.log(`[Maxpool] Updated provider token for "${mgr.name}"`);
    }
  }
  memConfig.routing = {
    mode: diskConfig.routing?.mode || 'automatic',
    preferredAccount: diskConfig.routing?.preferredAccount || null,
  };
  const preferredApplied = accountManager.setRoutingMode(
    memConfig.routing.mode,
    memConfig.routing.preferredAccount,
  );
  if (memConfig.routing.mode === 'preferred' && !preferredApplied) {
    memConfig.routing = { mode: 'automatic', preferredAccount: null };
  }
  return added;
}

// ── helpers ─────────────────────────────────────────────────

function argValue(flag) {
  const i = args.indexOf(flag);
  return (i >= 0 && args[i + 1]) ? args[i + 1] : null;
}

function handleServerListenError(err, host, port) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[Maxpool] ${host}:${port} is already in use.`);
    console.error('Another Maxpool proxy may already be running.');
    console.error('Check the existing server with: maxpool status');
    console.error(`Find the listener with: lsof -nP -iTCP:${port} -sTCP:LISTEN`);
  } else if (err.code === 'EACCES') {
    console.error(`[Maxpool] Permission denied while listening on ${host}:${port}.`);
    console.error('Choose a non-privileged port in the Maxpool config.');
  } else {
    console.error(`[Maxpool] Failed to listen on ${host}:${port}: ${err.message}`);
  }
  process.exit(1);
}

function formatDurationMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)}s`;
  return `${Math.floor(sec / 60)}m${String(Math.round(sec % 60)).padStart(2, '0')}s`;
}

function formatLoadWindow(load = {}) {
  const avg = load.avgMs != null ? ` avg ${formatDurationMs(load.avgMs)}` : '';
  const failed = load.failed ? `, ${load.failed} failed` : '';
  return `${load.requests || 0} req${avg}${failed}`;
}
