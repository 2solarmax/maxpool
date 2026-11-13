// Switch the terminal's raw mode WITHOUT stalling the thread that serves requests.
//
// Node switches it with tcsetattr(TCSADRAIN), which waits until the terminal has read
// everything already queued for it — up to the pty's ~1 KB kernel queue, which no Node
// API can see. A worker that has just taken over the pool cannot know whether its
// terminal is reading (red-team 2026-11-13: a dashboard frame under 1 KB, or a terminal
// that reads in bursts, stalled the new sole acceptor for ~1.7s inside setRawMode).
// So that switch runs on a helper THREAD with its own handle on the terminal (our stdin,
// else /dev/tty): the helper waits for the terminal, the pool keeps serving.
// termios belongs to the terminal device, so a mode set from the helper is the mode
// every reader of the terminal sees (verified on a real pty, 2026-11-13).
import { Worker } from 'node:worker_threads';

const HELPER_SRC = `
const { parentPort } = require('node:worker_threads');
const fs = require('node:fs');
const tty = require('node:tty');
let term = null;
// The terminal on our stdin first (the one the dashboard takes keys from — it need
// not be the controlling terminal), else the controlling terminal.
function openTerminal() {
  let lastErr = null;
  for (const path of ['/dev/fd/0', '/dev/tty']) {
    let fd = null;
    try {
      fd = fs.openSync(path, fs.constants.O_RDWR | fs.constants.O_NOCTTY);
      if (tty.isatty(fd)) return new tty.ReadStream(fd);
      lastErr = Object.assign(new Error(path + ' is not a terminal'), { code: 'ENOTTY' });
    } catch (err) { lastErr = err; }
    if (fd != null) { try { fs.closeSync(fd); } catch {} }
  }
  throw lastErr;
}
parentPort.on('message', ({ id, raw, toggle }) => {
  try {
    // Never read from it (no resume): the main thread owns the keyboard.
    if (!term) term = openTerminal();
    // libuv skips a switch to the mode it believes is already set; another process
    // may have changed the terminal since, so 'toggle' goes through the other mode.
    if (toggle) term.setRawMode(!raw);
    term.setRawMode(raw);
    parentPort.postMessage({ id, ok: true });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: err.code || err.message });
  }
});
`;

/**
 * `setRaw(raw, { toggle })` resolves {ok, error?, ms} once the terminal is in that mode
 * — which may be long after the call while the terminal is not reading; the caller's
 * thread is never blocked. ok:false (no controlling terminal, helper failed) means the
 * caller must fall back to its own switch. `makeWorker` is injectable for tests.
 */
export function createTerminalModeSwitcher({ makeWorker = () => new Worker(HELPER_SRC, { eval: true }), now = Date.now } = {}) {
  let worker = null;
  let seq = 0;
  const pending = new Map();
  const failAll = error => {
    for (const done of pending.values()) done({ ok: false, error });
    pending.clear();
  };
  const ensure = () => {
    if (worker) return worker;
    const w = makeWorker();
    w.unref?.();   // never keeps the process alive
    w.on('message', ({ id, ok, error }) => {
      const done = pending.get(id);
      if (done) { pending.delete(id); done({ ok, error }); }
    });
    w.on('error', err => { if (worker === w) worker = null; failAll(err.message); });
    w.on('exit', () => { if (worker === w) worker = null; failAll('terminal helper exited'); });
    worker = w;
    return w;
  };
  return {
    setRaw(raw, { toggle = false } = {}) {
      const t0 = now();
      return new Promise(resolve => {
        const done = r => resolve({ ...r, ms: now() - t0 });
        let w;
        try { w = ensure(); } catch (err) { done({ ok: false, error: err.message }); return; }
        const id = ++seq;
        pending.set(id, done);
        try { w.postMessage({ id, raw: Boolean(raw), toggle: Boolean(toggle) }); } catch (err) { pending.delete(id); done({ ok: false, error: err.message }); }
      });
    },
    close() {
      const w = worker;
      worker = null;
      failAll('closed');
      w?.terminate?.();
    },
  };
}
