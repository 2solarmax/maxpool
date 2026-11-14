// Switch the terminal's raw mode WITHOUT stalling the thread that serves requests.
//
// Node switches it with tcsetattr(TCSADRAIN), which waits until the terminal has read
// everything already queued for it — up to the pty's ~1 KB kernel queue, which no Node
// API can see. A worker that has just taken over the pool cannot know whether its
// terminal is reading (red-team 2026-11-13: a dashboard frame under 1 KB, or a terminal
// that reads in bursts, stalled the new sole acceptor for ~1.7s inside setRawMode).
// So that switch runs in a helper PROCESS with its own handle on the terminal (our
// stdin, else /dev/tty): the helper waits for the terminal, the pool keeps serving.
// termios belongs to the terminal device, so a mode set from the helper is the mode
// every reader of the terminal sees (verified on a real pty, 2026-11-13).
//
// A process, not a worker thread (red-team round 2, 2026-11-13): process.exit JOINS
// worker threads, a thread inside tcsetattr cannot be interrupted (Worker.terminate()
// included — libuv retries the call on EINTR), so a worker with a switch pending lived
// until the terminal read: on the abrupt-restart path it kept the port. A child process
// is never joined, and SIGKILL ends it mid-wait without applying the pending mode.
// The helper only ever dies by SIGKILL: a normal exit would run Node's terminal reset
// and put the terminal back in the mode it found before its first switch.
import { spawn } from 'node:child_process';

const HELPER_SRC = `
const fs = require('node:fs');
const tty = require('node:tty');
const die = () => process.kill(process.pid, 'SIGKILL');
process.on('disconnect', die);          // our parent is gone: never apply a stale mode
process.on('uncaughtException', die);
let term = null;
// fd 3 is the parent's stdin (the terminal the dashboard takes keys from — it need not
// be the controlling terminal), else the controlling terminal.
function openTerminal() {
  if (tty.isatty(3)) return new tty.ReadStream(3);
  let fd = null;
  try {
    fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY);
    if (tty.isatty(fd)) return new tty.ReadStream(fd);
  } catch (err) {
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
    throw err;
  }
  try { fs.closeSync(fd); } catch {}
  throw Object.assign(new Error('/dev/tty is not a terminal'), { code: 'ENOTTY' });
}
process.on('message', ({ id, raw, toggle }) => {
  try {
    // Never read from it (no resume): the parent owns the keyboard.
    if (!term) term = openTerminal();
    // libuv skips a switch to the mode it believes is already set; another process
    // may have changed the terminal since, so 'toggle' goes through the other mode.
    if (toggle) term.setRawMode(!raw);
    term.setRawMode(raw);
    process.send({ id, ok: true });
  } catch (err) {
    process.send({ id, ok: false, error: err.code || err.message });
  }
});
`;

const spawnHelper = () => spawn(process.execPath, ['-e', HELPER_SRC], {
  // fd 3 = our stdin; nothing on 0-2, so the helper's own exit never touches them.
  stdio: ['ignore', 'ignore', 'ignore', 0, 'ipc'],
  env: { PATH: process.env.PATH || '' },
});

/**
 * `setRaw(raw, { toggle })` resolves {ok, error?, ms} once the terminal is in that mode
 * — which may be long after the call while the terminal is not reading; the caller's
 * thread is never blocked. ok:false (no terminal, helper failed) means the caller must
 * fall back to its own switch. The helper starts on demand and is killed once it has
 * nothing pending; close() kills it at once — a pending switch then never lands — and
 * so does this process's exit. `makeHelper` is injectable for tests.
 */
export function createTerminalModeSwitcher({ makeHelper = spawnHelper, now = Date.now } = {}) {
  let helper = null;
  let seq = 0;
  const pending = new Map();
  const failAll = error => {
    for (const done of pending.values()) done({ ok: false, error });
    pending.clear();
  };
  const kill = h => { try { h?.kill?.('SIGKILL'); } catch { /* already gone */ } };
  const onProcessExit = () => kill(helper);
  let exitHooked = false;
  const ensure = () => {
    if (helper) return helper;
    const h = makeHelper();
    h.unref?.();            // never keeps this process alive
    h.channel?.unref?.();
    h.on('message', ({ id, ok, error }) => {
      const done = pending.get(id);
      if (!done) return;
      pending.delete(id);
      done({ ok, error });
      // Idle: nothing left for it to switch. No helper process lingers between switches.
      if (!pending.size && helper === h) { helper = null; kill(h); }
    });
    h.on('error', err => { if (helper === h) { helper = null; failAll(err.message); } kill(h); });
    h.on('exit', () => { if (helper === h) { helper = null; failAll('terminal helper exited'); } });
    if (!exitHooked) { process.on('exit', onProcessExit); exitHooked = true; }
    helper = h;
    return h;
  };
  return {
    setRaw(raw, { toggle = false } = {}) {
      const t0 = now();
      return new Promise(resolve => {
        const done = r => resolve({ ...r, ms: now() - t0 });
        let h;
        try { h = ensure(); } catch (err) { done({ ok: false, error: err.message }); return; }
        const id = ++seq;
        pending.set(id, done);
        try { h.send({ id, raw: Boolean(raw), toggle: Boolean(toggle) }); } catch (err) { pending.delete(id); done({ ok: false, error: err.message }); }
      });
    },
    /** Kill the helper NOW (exit paths call this first): a pending switch never lands. */
    close() {
      const h = helper;
      helper = null;
      failAll('closed');
      kill(h);
      if (exitHooked) { process.removeListener('exit', onProcessExit); exitHooked = false; }
    },
  };
}
