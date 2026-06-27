// TTY single-owner + terminal-restore invariants for the reload.
//
// The reload hands the terminal between workers exactly once: the releasing
// worker MUST exit raw mode + the alt-screen (restore the terminal) before the
// incoming worker enters it, so at most one worker drives the terminal and the
// shell is never left in raw mode on any exit path.
//
// We drive the TUI directly with a fake TTY, asserting the precise enter/exit
// escape sequences and raw-mode toggles. The alt-screen pair is `ESC?1049h` /
// `ESC?1049l` and the cursor pair is `ESC?25l` / `ESC?25h`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// A fake stdin/stdout pair that records raw-mode transitions and written bytes
// without touching the real terminal.
function fakeTTY() {
  const writes = [];
  const rawCalls = [];
  const listeners = {};
  const stdin = {
    isTTY: true,
    setRawMode(v) { rawCalls.push(v); return this; },
    resume() {}, pause() {}, setEncoding() {},
    on(ev, fn) { (listeners[ev] ||= []).push(fn); },
    removeListener(ev, fn) { listeners[ev] = (listeners[ev] || []).filter(f => f !== fn); },
  };
  const stdout = {
    isTTY: true, columns: 100, rows: 40,
    write(s) { writes.push(s); return true; },
    on() {}, removeListener() {},
  };
  return { stdin, stdout, writes, rawCalls, joined: () => writes.join('') };
}

function withFakeTTY(fn) {
  const fake = fakeTTY();
  const realIn = { isTTY: process.stdin.isTTY, setRawMode: process.stdin.setRawMode, resume: process.stdin.resume, pause: process.stdin.pause, setEncoding: process.stdin.setEncoding, on: process.stdin.on, removeListener: process.stdin.removeListener };
  const realOut = { isTTY: process.stdout.isTTY, write: process.stdout.write, on: process.stdout.on, removeListener: process.stdout.removeListener, columns: process.stdout.columns, rows: process.stdout.rows };
  Object.assign(process.stdin, fake.stdin);
  Object.assign(process.stdout, fake.stdout);
  try { return fn(fake); }
  finally {
    Object.assign(process.stdin, realIn);
    Object.assign(process.stdout, realOut);
  }
}

function tuiFor() {
  const am = new AccountManager(
    [{ name: 'a1', type: 'apikey', apiKey: 'sk-x' }], 0.90, {},
  );
  return new TUI({ accountManager: am, config: {} });
}

test('TUI.start enters raw mode + alt-screen; TUI.stop restores both (terminal restored)', () => {
  withFakeTTY(fake => {
    const tui = tuiFor();
    assert.equal(tui.start(), true);
    assert.equal(tui.running, true);
    assert.deepEqual(fake.rawCalls.slice(0, 1), [true], 'raw mode ON at start');
    assert.match(fake.joined(), /\[\?1049h/, 'entered alt-screen');

    tui.stop();
    assert.equal(tui.running, false);
    assert.equal(fake.rawCalls.at(-1), false, 'raw mode OFF at stop (terminal restored)');
    assert.match(fake.joined(), /\[\?1049l/, 'exited alt-screen at stop');
    assert.match(fake.joined(), /\[\?25h/, 'cursor restored at stop');
  });
});

test('single-owner: the releasing TUI exits the alt-screen BEFORE the next enters', () => {
  withFakeTTY(fake => {
    // Worker A holds the terminal.
    const a = tuiFor();
    a.start();
    // Baton release: A restores the terminal.
    a.stop();
    const afterAStop = fake.writes.length;

    // Worker B takes the terminal only now.
    const b = tuiFor();
    b.start();

    // The alt-screen EXIT (A) must appear before the alt-screen ENTER (B): the
    // terminal was returned to normal between owners (never two alt-screens).
    const joined = fake.joined();
    const lastExit = joined.lastIndexOf('[?1049l');
    const enterAfterB = joined.indexOf('[?1049h', fake.writes.slice(0, afterAStop).join('').length);
    assert.ok(lastExit >= 0, 'A exited alt-screen');
    assert.ok(enterAfterB > lastExit, 'B enters alt-screen only after A exited it');

    b.stop();
    assert.equal(fake.rawCalls.at(-1), false, 'terminal restored after B too');
    // Never two simultaneous raw-on without an intervening raw-off.
    let depth = 0, maxDepth = 0;
    for (const v of fake.rawCalls) { depth += v ? 1 : -1; maxDepth = Math.max(maxDepth, depth); }
    assert.ok(maxDepth <= 1, 'at most one TUI in raw mode at a time');
  });
});
