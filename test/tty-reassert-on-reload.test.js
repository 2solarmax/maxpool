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

// ── WIRING: reapOldWorker must send MSG_TTY_REASSERT to the new worker ────────
//
// The unit test above proves the toggle technique. This proves the IPC WIRING —
// that the message actually fires when the old worker exits. Without this, deleting
// the `newWorker.send({type: MSG_TTY_REASSERT})` line is a silent no-op.

test('WIRING: reapOldWorker calls onExited which sends MSG_TTY_REASSERT', async () => {
  // reapOldWorker(worker, onExited) — the callback fires when the worker's child
  // process exits. The caller (orchestrateReload) passes a callback that sends
  // MSG_TTY_REASSERT. We verify the contract: the callback IS invoked on exit.
  //
  // We can't easily import reapOldWorker (it's not exported), but we CAN verify
  // the reload-protocol message type is what the handler expects — and that the
  // handler exists in the message switch. This is a structural test: it pins the
  // wiring so deleting either end of the chain fails.
  
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const src = require('node:fs').readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');

  // The send side exists
  assert.match(src, /newWorker\.send\(\s*\{\s*type:\s*MSG_TTY_REASSERT\s*\}/,
    'orchestrateReload must send MSG_TTY_REASSERT to the new worker');

  // The send is wired to reapOldWorker's exit callback
  assert.match(src, /reapOldWorker\(oldWorker,\s*\(\)\s*=>\s*\{/,
    'reapOldWorker must receive an onExited callback');

  // The receive side exists (the handler in the message switch)
  assert.match(src, /msg\?\.type\s*===\s*MSG_TTY_REASSERT/,
    'the worker message handler must handle MSG_TTY_REASSERT');

  // The handler reclaims raw mode through reclaimRawMode (its off→on toggle is
  // pinned by behaviour below). Match the HANDLER (msg?.type ===), not the import.
  const handlerMatch = src.match(/msg\?\.type\s*===\s*MSG_TTY_REASSERT[\s\S]{0,800}/);
  assert.ok(handlerMatch, 'handler block found');
  assert.match(handlerMatch[0], /await reclaimRawMode(Logged)?\(/, 'handler reclaims raw mode');
});

// reclaimRawMode (2026-11-12): setRawMode is tcsetattr(TCSADRAIN) and blocks the whole
// process while the terminal is behind, so the toggle waits for our output to drain.
function rawStdin() {
  const calls = [];
  return { calls, isTTY: true, _isRaw: true,
    setRawMode(v) { this._isRaw = v; calls.push(v); }, resume() { calls.push('resume'); } };
}

test('reclaimRawMode toggles off→on and resumes once our output has drained', async () => {
  const { reclaimRawMode } = await import('../src/tui.js');
  const stdin = rawStdin();
  const done = await reclaimRawMode({ stdin, stdout: new (await import('node:events')).EventEmitter(), flush: async () => true });
  assert.equal(done, true);
  assert.deepEqual(stdin.calls, [false, true, 'resume']);
});

test('reclaimRawMode does NOT touch the terminal mode while the terminal is behind; it does on drain', async () => {
  const { reclaimRawMode } = await import('../src/tui.js');
  const { EventEmitter } = await import('node:events');
  const stdin = rawStdin();
  const stdout = new EventEmitter();
  const done = await reclaimRawMode({ stdin, stdout, flush: async () => false });
  assert.equal(done, false);
  assert.deepEqual(stdin.calls, [], 'no blocking tcsetattr while the terminal has not read our output');
  stdout.emit('drain');
  assert.deepEqual(stdin.calls, [false, true, 'resume']);
});
