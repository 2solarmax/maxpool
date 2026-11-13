// IPC message vocabulary + the supervisor-side baton orchestration for the
// near-zero-downtime reload (issue #6). Pure logic, no process side-effects, so
// the baton sequence is unit-testable against fake workers.
//
// Roles:
//   Supervisor — owns the listening socket for life, never closes it, spawns
//     workers and hands the socket HANDLE to exactly one acceptor at a time.
//   Worker     — accepts on the shared handle; exactly one worker holds the
//     WRITER LEASE (refresh/probe/persist) at any instant.
//
// The baton (single-writer guarantee): old worker RELEASES (stops accepting +
// stops writing, flushes once) BEFORE the new worker ACQUIRES. Reads overlap;
// writes never do.

// Supervisor → worker
export const MSG_LISTEN = 'listen';       // (with handle) accept on this socket + take TUI/lease
// Tells the surviving old worker WHY a reload rolled back. 'timeout' = the new worker
// was merely slow to signal ready (a loaded machine) — safe to retry with a cold
// restart. 'failed' = it reported failure or died before ready — a cold restart there
// would commit to a build that cannot boot and leave NO working proxy.
export const MSG_ROLLED_BACK = 'rolled-back';
export const MSG_RELEASE = 'release';     // stop accepting, stop writing, flush, give up TUI
export const MSG_TAKEOVER = 'takeover';   // (with handle) start accepting + acquire writer lease + TUI
export const MSG_PROBE_READY = 'probe-ready'; // ask a headless worker to confirm it booted OK

// Worker → supervisor
export const MSG_RELOAD_REQUEST = 'reload-request'; // primary worker asks for a seamless reload
export const MSG_READY = 'ready';         // headless worker booted new code successfully
export const MSG_FAILED = 'failed';       // worker failed to boot/bind/restore
export const MSG_RELEASED = 'released';   // old worker stopped accepting + writing, flushed
export const MSG_PRIMARY = 'primary';     // new worker is now sole acceptor + lease holder
export const MSG_QUOTA_STATE = 'quota-state'; // old worker hands its in-memory quota to supervisor
export const MSG_CONN = 'conn';           // (with socket) supervisor-accepted connection handed to a worker to serve

/**
 * Outcome codes for a reload attempt, surfaced to the supervisor so it can log
 * and decide fallback. SWAPPED = fully cut over; ROLLED_BACK = old worker stays
 * primary (no disruption); FALLBACK = abrupt exit-75 restart path taken.
 */
export const RELOAD_SWAPPED = 'swapped';
export const RELOAD_ROLLED_BACK = 'rolled-back';
export const RELOAD_FALLBACK = 'fallback';

/**
 * Drive the baton handshake over two worker "channels" (anything with
 * .send(msg[,handle]) and an async waitFor(type, timeoutMs) that resolves with
 * the message payload or rejects on timeout/exit). Returns one of the RELOAD_*
 * outcomes. The caller (supervisor) owns spawning, killing, reaping and the
 * actual fallback restart; this function only sequences the protocol and tells
 * the caller what happened.
 *
 * Sequence (matches design step 2a–2e):
 *   a. new worker already spawned headless (no lease); we ask it to confirm READY
 *   b. READY fails  → ROLLED_BACK: caller kills new, old stays primary
 *   c. old RELEASE  → waits RELEASED (old stopped accepting + writing, flushed)
 *   d. new TAKEOVER → waits PRIMARY (new is sole acceptor + lease holder)
 *   e. caller drains+reaps old
 *
 * Any throw → FALLBACK (caller does the tested abrupt restart). All-or-nothing:
 * we never leave both accepting or both writing.
 */
export async function runReloadBaton({
  oldWorker,
  newWorker,
  handle,
  prepareHandle = async h => h,
  readyTimeoutMs = 10_000,
  releaseTimeoutMs = 20_000,
  takeoverTimeoutMs = 10_000,
  log = () => {},
  reloadId,
}) {
  // Every rollback notice names the reload it is about, so the old worker can tell a
  // late notice for an EARLIER reload from one for the reload it has open.
  const rolledBack = reason => {
    try { oldWorker.send({ type: MSG_ROLLED_BACK, reason, reloadId }); } catch { /* old worker gone */ }
  };
  // (a) Confirm the freshly-spawned headless worker booted the new code.
  let ready;
  try {
    newWorker.send({ type: MSG_PROBE_READY });
    ready = await newWorker.waitFor([MSG_READY, MSG_FAILED], readyTimeoutMs);
  } catch (err) {
    // Tell the old worker BEFORE logging: it resumes serving on this notice, and a log
    // line must never stand between the two (2026-11-13: a blocked terminal write did).
    // Only an expired timer is 'timeout' (merely slow: a cold restart may retry it). A
    // new worker that exited or could not be spawned is 'failed' — as is any rejection
    // whose cause is unknown, since a cold restart into a build that cannot boot leaves
    // no working proxy.
    rolledBack(err?.reason === 'timeout' ? 'timeout' : 'failed');
    log(`reload: readiness wait failed (${err.message}); rolling back`);
    return RELOAD_ROLLED_BACK;
  }
  // (b) New worker did not come up cleanly → roll back fully, old stays primary.
  if (!ready || ready.type === MSG_FAILED) {
    rolledBack('failed');
    log(`reload: new worker reported failed (${ready?.reason || 'no ready'}); rolling back`);
    return RELOAD_ROLLED_BACK;
  }

  // (c) Old worker releases: stop accepting NEW, keep in-flight, stop writing,
  //     flush config+state ONE final time, drop the TUI. After this point the
  //     old worker holds no lease and no acceptor — and (single-writer) no
  //     refresh/prober write is still in flight (it awaits drainRefreshes).
  try {
    oldWorker.send({ type: MSG_RELEASE });
    await oldWorker.waitFor([MSG_RELEASED], releaseTimeoutMs);
  } catch (err) {
    // Old worker didn't ack release. We must NOT hand the socket to the new
    // worker (would risk two acceptors) — fall back to the abrupt path.
    log(`reload: old worker did not release (${err.message}); falling back`);
    return RELOAD_FALLBACK;
  }

  // The old worker has now freed the listening fd. Re-arm the supervisor's own
  // acceptor over the cutover gap (covers new conns in the OS backlog) and get a
  // fresh re-sendable handle for the new worker.
  let liveHandle = handle;
  try {
    liveHandle = await prepareHandle(handle);
  } catch (err) {
    log(`reload: could not re-arm listening socket (${err.message}); falling back`);
    return RELOAD_FALLBACK;
  }

  // (d) New worker takes over: it becomes the SOLE acceptor (old already closed)
  //     and ACQUIRES the writer lease (refresh/probe/persist re-enabled) + TUI.
  try {
    newWorker.send({ type: MSG_TAKEOVER }, liveHandle);
    await newWorker.waitFor([MSG_PRIMARY], takeoverTimeoutMs);
  } catch (err) {
    // The new worker failed to start accepting after the old already released.
    // Neither is accepting now — fall back so the supervisor force-restarts and
    // a worker comes back up on the supervisor-owned socket (queued conns drain).
    log(`reload: new worker did not take over (${err.message}); falling back`);
    return RELOAD_FALLBACK;
  }

  log('reload: cutover complete; new worker is primary');
  return RELOAD_SWAPPED;
}

/**
 * Wrap a child process in a small IPC channel: `.send(msg[,handle])` and an
 * async `.waitFor([types], timeoutMs)` that resolves with the first matching
 * message, or rejects on timeout / premature child exit.
 */
export function makeWorkerChannel(child) {
  return {
    child,
    send(msg, handle) {
      try {
        if (handle) child.send(msg, handle);
        else child.send(msg);
      } catch { /* IPC may be torn down mid-swap; baton timeouts cover it */ }
    },
    // A rejection carries `.reason`: 'timeout' (the timer expired), 'exited' (the child
    // exited first — or had already exited) or 'spawn-error'.
    waitFor(types, timeoutMs) {
      const want = Array.isArray(types) ? types : [types];
      const fail = (reason, message) => Object.assign(new Error(message), { reason });
      if (child.exitCode != null || child.signalCode != null) {
        return Promise.reject(fail('exited', `worker already exited (code ${child.exitCode}, signal ${child.signalCode}) before ${want.join('/')}`));
      }
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
          reject(fail('exited', `worker exited (code ${code}, signal ${signal}) before ${want.join('/')}`));
        };
        // A spawn failure (EMFILE/EAGAIN) surfaces as 'error', not 'exit' — the
        // baton must see it as a failed step (→ ROLLED_BACK/FALLBACK), not hang.
        const onError = err => { cleanup(); reject(fail('spawn-error', `worker spawn error before ${want.join('/')}: ${err.message}`)); };
        const timer = setTimeout(() => {
          cleanup();
          reject(fail('timeout', `timed out waiting for ${want.join('/')}`));
        }, timeoutMs);
        timer.unref?.();
        child.on('message', onMsg);
        child.once('exit', onExit);
        child.once('error', onError);
      });
    },
  };
}

// Sent to the NEW primary worker once the OLD worker has actually exited. Node calls
// libuv's uv_tty_reset_mode() on process exit, which restores the termios the dying
// process saved when IT first enabled raw mode — clobbering the live worker's terminal
// back to canonical (cooked) mode. `process.stdin.isRaw` still reads true, so nothing
// in-process can detect it; the TUI keeps rendering while the kernel line-buffers, so
// every keystroke (r / q / p) is swallowed. Measured on a real pty 2026-08-07.
export const MSG_TTY_REASSERT = 'tty-reassert';

/** One log line for the update-window record (release B, B11): when the old worker exited and how. */
export function describeOldWorkerExit({ swappedAt, exitedAt, killed = false }) {
  const after = ((exitedAt - swappedAt) / 1000).toFixed(1);
  return `reload: old worker exited at ${new Date(exitedAt).toISOString()} (${after}s after swap, ${killed ? 'SIGKILL after the drain cap' : 'clean exit'})`;
}

/**
 * What the old worker does with a rollback notice. `noticeId` is the reload id the
 * supervisor echoed (absent from a supervisor that predates ids), `currentId` the id
 * of the reload this worker requested last, `open` whether that reload is still
 * waiting for an outcome.
 *   'settle'        — the notice names the open reload: act on it now
 *   'settle-idless' — an id-less notice (a supervisor that predates ids — it survives
 *                     seamless updates) while a reload is open: resume serving now, but
 *                     its reason never authorizes a cold restart. That supervisor tags
 *                     every readiness rejection 'timeout', a new build that died before
 *                     ready included, and cannot say which reload it means (red-team
 *                     round 2, 2026-11-13)
 *   'ignore'        — a notice about an earlier reload, or nothing is open
 */
export function rollbackNoticeAction({ noticeId, currentId, open }) {
  if (!open) return 'ignore';
  if (noticeId == null) return 'settle-idless';
  return noticeId === currentId ? 'settle' : 'ignore';
}
