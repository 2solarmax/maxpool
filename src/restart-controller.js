const NON_UPSTREAM_ROUTES = new Set(['(queued)', '(none available)']);

export class RestartController {
  constructor({ pauseAdmission, restartNow, log = console.log }) {
    this.pauseAdmission = pauseAdmission;
    this.restartNow = restartNow;
    this.log = log;
    this.activeRequests = new Set();
    this.upstreamRequests = new Set();
    this.pending = false;
    this.restarting = false;
  }

  requestStarted(id) {
    if (this.pending || this.restarting) return false;
    this.activeRequests.add(id);
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
    this.log(`[TeamClaude] Restart pending; admission paused while ${this.upstreamRequests.size} upstream request(s) finish. ${queuedOrIdle} queued/idle request(s) will reconnect after restart.`);
  }

  _maybeRestart() {
    if (!this.pending || this.restarting || this.upstreamRequests.size > 0) return;
    this._restart();
  }

  _restart() {
    if (this.restarting) return;
    this.restarting = true;
    this.pending = false;
    this.restartNow();
  }
}
