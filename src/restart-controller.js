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
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  }) {
    this.pauseAdmission = pauseAdmission;
    this.resumeAdmission = resumeAdmission;
    this.restartNow = restartNow;
    this.log = log;
    this.drainTimeoutMs = drainTimeoutMs;
    this.setTimeoutFn = setTimeoutFn;
    this.clearTimeoutFn = clearTimeoutFn;
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
    if (this.restarting) return;
    this.pauseAdmission();
    if (this.upstreamRequests.size === 0) {
      this._restart();
      return;
    }

    this.pending = true;
    const queuedOrIdle = Math.max(0, this.activeRequests.size - this.upstreamRequests.size);
    this.log(`[Maxpool] Restart pending; admission paused while ${this.upstreamRequests.size} upstream request(s) finish (up to ${Math.round(this.drainTimeoutMs / 1000)}s). ${queuedOrIdle} queued/idle request(s) will reconnect after restart.`);
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
    this.restartNow();
  }
}
