// Release B (batch 2) B11: instrument the update window.
//
// Release A showed one 7.8s Mac pause during the v1.24.91 cutover with an unverified cause.
// The next self-update is measured with the sampler running across it, so the log must say
// WHEN the old worker exited and HOW LONG the new worker took to take the terminal back.
// Unit level: the terminal is faked exactly like test/tty-reassert-on-reload.test.js does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { reclaimRawModeLogged } from '../src/tui.js';
import { describeOldWorkerExit } from '../src/reload-protocol.js';

function rawStdin() {
  const calls = [];
  return { calls, isTTY: true, _isRaw: true, setRawMode(v) { this._isRaw = v; calls.push(v); }, resume() { calls.push('resume'); } };
}

test('B11: a drained terminal logs "terminal reclaimed in Nms"', async () => {
  const stdin = rawStdin();
  const logs = [];
  let t = 1000;
  const done = await reclaimRawModeLogged({
    stdin, stdout: new EventEmitter(), flush: async () => { t += 42; return true; },
    log: m => logs.push(m), now: () => t,
  });
  assert.equal(done, true);
  assert.deepEqual(stdin.calls, [false, true, 'resume'], 'raw mode actually reclaimed');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /terminal reclaimed in 42ms/);
});

test('B11: a terminal that is behind logs "terminal reclaim deferred to drain" and does not touch the mode yet', async () => {
  const stdin = rawStdin();
  const logs = [];
  const done = await reclaimRawModeLogged({ stdin, stdout: new EventEmitter(), flush: async () => false, log: m => logs.push(m), now: () => 5 });
  assert.equal(done, false);
  assert.deepEqual(stdin.calls, []);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /terminal reclaim deferred to drain/);
});

test('B11: the deferred reclaim logs again when the drain finally lets it through', async () => {
  const stdin = rawStdin();
  const stdout = new EventEmitter();
  const logs = [];
  let t = 0;
  await reclaimRawModeLogged({ stdin, stdout, flush: async () => false, log: m => logs.push(m), now: () => t });
  t = 7800;
  stdout.emit('drain');
  assert.deepEqual(stdin.calls, [false, true, 'resume']);
  assert.match(logs[1], /terminal reclaimed after drain in 7800ms/);
});

test('B11: the old worker exit line carries the exit time and how it ended', () => {
  const swappedAt = Date.parse('2026-11-13T20:09:21.000Z');
  const clean = describeOldWorkerExit({ swappedAt, exitedAt: swappedAt + 8000, killed: false });
  assert.match(clean, /old worker exited at 2026-11-13T20:09:29\.000Z/);
  assert.match(clean, /8\.0s after swap/);
  assert.match(clean, /clean/);
  const killed = describeOldWorkerExit({ swappedAt, exitedAt: swappedAt + 90_000, killed: true });
  assert.match(killed, /SIGKILL/);
});

test('B11 WIRING: reapOldWorker logs the exit; the MSG_TTY_REASSERT handler uses the logged reclaim', () => {
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const reap = src.match(/function reapOldWorker[\s\S]*?\n\}\n/);
  assert.ok(reap, 'reapOldWorker found');
  assert.match(reap[0], /describeOldWorkerExit\(/, 'the reap/exit path logs the old worker exit time');
  const handler = src.match(/msg\?\.type\s*===\s*MSG_TTY_REASSERT[\s\S]{0,900}/);
  assert.ok(handler, 'handler found');
  assert.match(handler[0], /await reclaimRawModeLogged\(/, 'the handler measures and logs the reclaim');
});
