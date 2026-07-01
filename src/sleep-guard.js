// Conditional sleep guard (macOS): while maxpool has work in flight, prevent the
// SYSTEM from sleeping so long-lived streaming requests survive overnight
// Maintenance Sleep (which powers down the network stack and kills the
// connection → "terminated"). When idle, it releases so the Mac sleeps normally.
//
// Uses the built-in `caffeinate -s` (prevent SYSTEM sleep only — the DISPLAY still
// sleeps, so the screen stays dark) with `-w <pid>` so caffeinate auto-exits if the
// worker dies (never a zombie keeping the Mac awake forever). `-s` is AC-power only
// by design. Complete no-op off macOS or when disabled (e.g. the test suite).

import { spawn as realSpawn } from 'node:child_process';

const POLL_MS = 5_000;      // re-check the in-flight signal (idle-sleep timers are minutes)
const GRACE_MS = 60_000;    // stay awake this long after the last request, to bridge gaps

export class SleepGuard {
  constructor({ getWorkPending, log = () => {}, spawn = realSpawn, enabled, pollMs = POLL_MS, graceMs = GRACE_MS } = {}) {
    this.getWorkPending = getWorkPending;   // () => boolean: true while there's active/queued work
    this.log = log;
    this._spawn = spawn;
    this.enabled = enabled ?? (process.platform === 'darwin' && process.env.MAXPOOL_DISABLE_SLEEP_GUARD !== '1');
    this.pollMs = pollMs;
    this.graceMs = graceMs;
    this.child = null;
    this.pollTimer = null;
    this.graceTimer = null;
  }

  start() {
    if (!this.enabled || this.pollTimer) return;
    this.pollTimer = setInterval(() => this._tick(), this.pollMs);
    this.pollTimer.unref?.();
    this._tick(); // engage immediately if there's already work
  }

  _tick() {
    let pending = false;
    try { pending = Boolean(this.getWorkPending?.()); } catch { pending = false; }
    if (pending) {
      if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
      this._ensureAwake();
    } else if (this.child && !this.graceTimer) {
      // Idle: hold the wake for a grace period, then release (bridges brief gaps
      // between back-to-back requests so we never drop it mid-conversation).
      this.graceTimer = setTimeout(() => { this.graceTimer = null; this._allowSleep(); }, this.graceMs);
      this.graceTimer.unref?.();
    }
  }

  _ensureAwake() {
    if (!this.enabled || this.child) return;
    try {
      const c = this._spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' });
      this.child = c;
      // Only clear the ref if it's still THIS child (a stale exit can't null a newer one).
      // caffeinate missing/unspawnable → disable so we don't re-spawn every poll forever.
      c.once('error', () => { if (this.child === c) this.child = null; this.enabled = false; });
      c.once('exit', () => { if (this.child === c) this.child = null; });
      // Honest: -s keeps the SYSTEM awake ON AC ONLY (a no-op on battery); the display
      // still sleeps so the screen stays dark.
      this.log('Keeping the system awake while busy (caffeinate -s; AC power only, display still sleeps)');
    } catch { this.child = null; this.enabled = false; }
  }

  _allowSleep() {
    if (!this.child) return;
    try { this.child.kill('SIGTERM'); } catch { /* already gone */ }
    this.child = null;
    this.log('Idle — allowing normal system sleep again');
  }

  stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.graceTimer) { clearTimeout(this.graceTimer); this.graceTimer = null; }
    this._allowSleep();
  }
}
