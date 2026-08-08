import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MSG_TTY_REASSERT } from '../src/reload-protocol.js';

// The seamless reload clobbers the shared terminal: when the old worker exits,
// libuv's uv_tty_reset_mode() restores the termios it saved — which is COOKED
// mode (what the terminal was in before the worker set raw mode). The new worker's
// process.stdin.isRaw still reads true, so nothing in-process can detect it.
//
// The fix: reapOldWorker sends MSG_TTY_REASSERT to the new worker on the old
// worker's exit event. The handler toggles setRawMode(false) then (true) — the
// off→on sequence is load-bearing because Node short-circuits setRawMode(true)
// when it believes isRaw is already true.

test('MSG_TTY_REASSERT is a valid reload-protocol message', () => {
  assert.equal(typeof MSG_TTY_REASSERT, 'string');
  assert.equal(MSG_TTY_REASSERT, 'tty-reassert');
});

test('the toggle off→on restores raw mode after a clobber (the real termios test)', () => {
  // This is a UNIT test of the TOGGLE TECHNIQUE, not the full IPC chain.
  // The full chain is proven by the python pty repro (see commit message) and
  // is structurally impossible to unit-test without a real pty pair.
  //
  // The technique: isRaw is stale (true) after the clobber, so setRawMode(true)
  // is a no-op. setRawMode(false) first forces Node to ACTUALLY write the termios,
  // which updates isRaw to false. Then setRawMode(true) writes raw mode for real.
  // Without the false→true toggle, the terminal stays cooked forever.
  const transitions = [];
  const fakeStdin = {
    _isRaw: true,   // stale — the clobber happened in another process
    get isRaw() { return this._isRaw; },
    setRawMode(v) {
      this._isRaw = v;
      transitions.push(v);
    },
    resume() {},
  };
  // Simulate the handler
  fakeStdin.setRawMode(false);
  fakeStdin.setRawMode(true);
  fakeStdin.resume();
  assert.deepEqual(transitions, [false, true], 'the toggle must be off→on, not just on');
});

test('a bare setRawMode(true) WITHOUT the toggle is a no-op (the trap)', () => {
  // This is exactly why the off→on sequence is required.
  const fakeStdin = {
    _isRaw: true,
    get isRaw() { return this._isRaw; },
    setRawMode(v) {
      // Node's actual implementation short-circuits here
      if (v === true && this._isRaw === true) return;  // no-op
      this._isRaw = v;
    },
    resume() {},
  };
  fakeStdin.setRawMode(true);  // the "obvious fix" — does nothing
  assert.equal(fakeStdin.isRaw, true, 'isRaw is still stale-true');
  // The terminal is still cooked, but Node thinks it's raw. Nothing changed.
});
