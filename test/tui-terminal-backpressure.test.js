// The pool must never block on its own terminal (2026-11-12, proven live: the Mac pool's
// main thread sat 100% in a synchronous TTY write() for up to 60s; every account's
// requests stalled at once and their 120s timers fired together). A TUI in this process
// redrew the WHOLE screen for every log line — 4.9 GB to the terminal in 12h49m.
// The real-terminal half of this lives in tui-terminal-pty.test.js; this file pins the
// frame accounting with a stand-in stdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

// A stand-in terminal: counts frames written; `writableNeedDrain` = the terminal stopped reading.
function fakeStdout() {
  const out = new EventEmitter();
  Object.assign(out, { columns: 120, rows: 40, writes: 0, bytes: 0, writableNeedDrain: false, writableLength: 0, isTTY: true });
  out.write = (s) => { out.writes++; out.bytes += String(s).length; return !out.writableNeedDrain; };
  return out;
}

// Swap process.stdout for the whole async body, so a render that fires on a timer
// later still lands on the fake (never on the test runner's own stdout).
async function withStdout(fake, fn) {
  const desc = Object.getOwnPropertyDescriptor(process, 'stdout');
  Object.defineProperty(process, 'stdout', { value: fake, configurable: true, writable: true });
  let tui;
  try {
    tui = new TUI({ accountManager: new AccountManager([], 0.9), config: {}, saveConfig() {}, syncAccounts() {}, onQuit() {}, onRestart() {} });
    tui.running = true;   // as after start(), without taking over the real terminal
    tui._nb = true;       // as start() records on a real TTY (non-blocking output)
    await fn(tui);
  } finally {
    if (tui) tui.running = false;
    await sleep(150);     // let any scheduled render fire (and no-op) while the fake is still in place
    Object.defineProperty(process, 'stdout', desc);
  }
}

test('50 log lines in one tick write one frame, not 50', async () => {
  const out = fakeStdout();
  await withStdout(out, async (tui) => {
    for (let i = 0; i < 50; i++) tui._addLog(`[Maxpool] line ${i}`);
    assert.ok(out.writes <= 1, `wrote ${out.writes} frames synchronously for 50 log lines`);
    await sleep(250);
    assert.equal(out.writes, 1, `50 log lines in one tick → exactly one frame (got ${out.writes})`);
  });
});

test('a terminal that stopped reading gets no new frames until it drains', async () => {
  const out = fakeStdout();
  await withStdout(out, async (tui) => {
    out.writableNeedDrain = true;
    const before = out.writes;
    for (let i = 0; i < 20; i++) tui._addLog(`[Maxpool] stalled ${i}`);
    tui.render();
    await sleep(300);
    assert.equal(out.writes, before, `wrote ${out.writes - before} frames into a terminal that is not reading`);
    out.writableNeedDrain = false;
    out.emit('drain');
    await sleep(300);
    assert.ok(out.writes > before, 'the owed frame is written once the terminal drains');
    assert.ok(out.writes - before <= 2, `drain caught up with ${out.writes - before} frames, not a backlog`);
    assert.ok(out.listenerCount('drain') <= 1, `drain listeners pile up: ${out.listenerCount('drain')}`);
  });
});

test('an unchanged frame is not re-sent; forceRender and the 5s repaint always write', async () => {
  const out = fakeStdout();
  await withStdout(out, async (tui) => {
    tui.render();
    const first = out.writes;
    assert.equal(first, 1, 'the first frame is written');
    tui.render();
    assert.equal(out.writes, first, 'an identical frame is skipped');
    tui.forceRender();
    assert.equal(out.writes, first + 1, 'forceRender writes even an identical frame (keystroke / resize / takeover)');
    tui._lastFullWriteAt = Date.now() - 6000;   // the last full write was over 5s ago
    tui.render();
    assert.equal(out.writes, first + 2, 'an identical frame is repainted once 5s have passed');
  });
});

test('a request start schedules a render; it does not draw synchronously', async () => {
  const out = fakeStdout();
  await withStdout(out, async (tui) => {
    for (let i = 0; i < 20; i++) tui.onRequestStart(`r${i}`, { method: 'POST', path: '/v1/messages' });
    assert.equal(out.writes, 0, `request starts drew ${out.writes} frames synchronously`);
    await sleep(250);
    assert.equal(out.writes, 1, `20 request starts in one tick → one frame (got ${out.writes})`);
  });
});

test('flushOutput resolves once the terminal has taken everything, or at its timeout', async () => {
  const out = fakeStdout();
  await withStdout(out, async (tui) => {
    out.writableLength = 0;
    assert.equal(await tui.flushOutput({ timeoutMs: 1000 }), true, 'nothing queued → resolves at once');
    out.writableLength = 5000;
    const t0 = Date.now();
    const p = tui.flushOutput({ timeoutMs: 1000 });
    setTimeout(() => { out.writableLength = 0; out.emit('drain'); }, 100);
    assert.equal(await p, true, 'resolves on drain');
    assert.ok(Date.now() - t0 < 900, 'did not wait for the timeout');
    out.writableLength = 5000;
    const t1 = Date.now();
    assert.equal(await tui.flushOutput({ timeoutMs: 300 }), false, 'a terminal that never drains → resolves false at the timeout');
    assert.ok(Date.now() - t1 >= 280, 'waited the full timeout');
    assert.equal(out.listenerCount('drain'), 0, 'flushOutput leaves no drain listener behind');
  });
});
