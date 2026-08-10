const NON_UPSTREAM_ROUTES = new Set(['(queued)', '(none available)']);

export class RestartController {
  constructor({
    pauseAdmission,
    resumeAdmission = () => {},
    restartNow,
    log = console.log,
    // Bounded drain: wait at most this long for in-flight upstream requests to
    // finish, then force the restart anyway. Without a bound, a single long
    // streaming/thinking request (minutes) — or a held stream on the 7-day
    // heartbeat — pins the restart on "Restart pending…" forever (the stuck-`r`
    // bug). Dropped requests reconnect after restart, as the message promises.
    drainTimeoutMs = 10_000,
    // When the reload is SEAMLESS, the old worker keeps serving its in-flight
    // requests through the baton handoff (releaseBatonAndDrain, 60s+ cap) — so
    // pre-draining here buys nothing and costs every OTHER session a hard 503 for
    // the whole window. With ~30 sessions running 30-60s requests the 10s drain
    // NEVER completes naturally; it times out every time. So it was 10 guaranteed
    // seconds of "Maxpool is restarting" across the fleet in exchange for zero
    // drained requests — the reported 503 storm. Returns true when the restart
    // path will hand off seamlessly, in which case we skip straight to the swap.
    isSeamless = () => false,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
  }) {
    this.pauseAdmission = pauseAdmission;
    this.resumeAdmission = resumeAdmission;
    this.restartNow = restartNow;
    this.log = log;
    this.drainTimeoutMs = drainTimeoutMs;
    this.isSeamless = isSeamless;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
    this.setIntervalFn = setIntervalFn;
    this.clearIntervalFn = clearIntervalFn;
    this._progressTimer = null;
    this.activeRequests = new Set();
    this.upstreamRequests = new Set();
    this.pending = false;
    this.restarting = false;
    this._drainTimer = null;
  }

  requestStarted(id) {
    if (this.pending || this.restarting) return false;
    this.activeRequests.add(id);
    return true;
  }

  /**
   * Abort a restart that was requested but never completed because the process is
   * STILL ALIVE — a seamless reload that rolled back (the new worker failed to boot,
   * so the old worker was never released and never exited). Without this the latched
   * `pending`/`restarting` flags make requestStarted() return false forever → the
   * worker 503s EVERY request until a manual restart. Reset the flags + resume
   * admission so it keeps serving. No-op if no restart is in progress.
   */
  cancelRestart() {
    if (!this.pending && !this.restarting) return false;
    this.pending = false;
    this.restarting = false;
    if (this._drainTimer) { this.clearTimeoutFn(this._drainTimer); this._drainTimer = null; }
    if (this._progressTimer) { this.clearIntervalFn(this._progressTimer); this._progressTimer = null; }
    this.resumeAdmission();
    return true;
  }

  requestRouted(id, account) {
    if (!this.activeRequests.has(id)) return false;
    if (NON_UPSTREAM_ROUTES.has(account)) this.upstreamRequests.delete(id);
    else this.upstreamRequests.add(id);
    this._maybeRestart();
    return true;
  }

  requestEnded(id) {
    this.activeRequests.delete(id);
    this.upstreamRequests.delete(id);
    this._maybeRestart();
  }

  requestRestart() {
    // Idempotent against a restart ALREADY in progress — restarting OR pending (drain).
    // Without the `pending` guard a second call (e.g. auto-apply firing while a manual
    // restart is draining) would orphan the first _drainTimer and re-log.
    if (this.restarting || this.pending) return;
    this.pauseAdmission();
    if (this.upstreamRequests.size === 0) {
      this._restart();
      return;
    }

    // Seamless handoff → do not pre-drain (see isSeamless above). The in-flight
    // requests finish on the OLD worker after the baton passes; holding admission
    // here would only 503 the rest of the fleet for nothing.
    if (this.isSeamless()) {
      this.log(`[Maxpool] Restarting now — ${this.upstreamRequests.size} in-flight request(s) finish on the current version; new requests go to the updated one.`);
      this._restart();
      return;
    }

    this.pending = true;
    const queuedOrIdle = Math.max(0, this.activeRequests.size - this.upstreamRequests.size);
    this.log(`[Maxpool] Restart pending; admission paused while ${this.upstreamRequests.size} upstream request(s) finish (up to ${Math.round(this.drainTimeoutMs / 1000)}s). ${queuedOrIdle} queued/idle request(s) will reconnect after restart.`);
    // Progress ticks while draining. Without these the TUI shows one line and then
    // silence for the whole window, which reads as "nothing happened" — the reported
    // complaint. A countdown makes the wait legible and bounded.
    this._tick = 0;
    const tickMs = 2000;
    this._progressTimer = this.setIntervalFn?.(() => {
      if (!this.pending || this.restarting) return;
      this._tick += tickMs;
      const left = Math.max(0, Math.ceil((this.drainTimeoutMs - this._tick) / 1000));
      const n = this.upstreamRequests.size;
      if (n === 0) return;   // _maybeRestart is about to fire
      this.log(`[Maxpool] Restarting — waiting for ${n} request(s) to finish (${left}s left)…`);
    }, tickMs);
    this._progressTimer?.unref?.();

    // Force the restart if the drain overruns — never hang on a long stream.
    this._drainTimer = this.setTimeoutFn(() => {
      if (!this.pending || this.restarting) return;
      this.log(`[Maxpool] Restart drain timed out; forcing restart with ${this.upstreamRequests.size} upstream request(s) still in flight (they will reconnect).`);
      this._restart();
    }, this.drainTimeoutMs);
    this._drainTimer?.unref?.();
  }

  _maybeRestart() {
    if (!this.pending || this.restarting || this.upstreamRequests.size > 0) return;
    this._restart();
  }

  _restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.pending = false;
    if (this._drainTimer) {
      this.clearTimeoutFn(this._drainTimer);
      this._drainTimer = null;
    }
    if (this._progressTimer) {
      this.clearIntervalFn(this._progressTimer);
      this._progressTimer = null;
    }
    this.restartNow();
  }
}
