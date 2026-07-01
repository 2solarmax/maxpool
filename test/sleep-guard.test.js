import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SleepGuard } from '../src/sleep-guard.js';

// A fake `caffeinate` child so tests never spawn a real process / touch power state.
function fakeSpawner() {
  const spawned = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.cmd = cmd; child.args = args; child.killed = false;
    child.kill = () => { child.killed = true; child.emit('exit', 0, 'SIGTERM'); return true; };
    spawned.push(child);
    return child;
  };
  return { spawn, spawned, live: () => spawned.filter(c => !c.killed) };
}
const tick = () => new Promise(r => setTimeout(r, 25)); // let short timers fire

test('engages caffeinate -s -w while work is pending, on start', async () => {
  const f = fakeSpawner();
  let pending = true;
  const g = new SleepGuard({ enabled: true, spawn: f.spawn, getWorkPending: () => pending, pollMs: 5, graceMs: 20 });
  g.start();
  await tick();
  assert.equal(f.live().length, 1, 'one caffeinate child while work is pending');
  assert.deepEqual(f.spawned[0].args, ['-s', '-w', String(process.pid)], 'system-sleep-only, tied to worker pid');
  g.stop();
});

test('does NOT engage while idle; engages once work appears', async () => {
  const f = fakeSpawner();
  let pending = false;
  const g = new SleepGuard({ enabled: true, spawn: f.spawn, getWorkPending: () => pending, pollMs: 5, graceMs: 20 });
  g.start();
  await tick();
  assert.equal(f.spawned.length, 0, 'idle → no caffeinate');
  pending = true;
  await tick();
  assert.equal(f.live().length, 1, 'engages when a request starts');
  g.stop();
});

test('releases (kills child) only AFTER the grace period once idle — never mid-request', async () => {
  const f = fakeSpawner();
  let pending = true;
  const g = new SleepGuard({ enabled: true, spawn: f.spawn, getWorkPending: () => pending, pollMs: 5, graceMs: 60 });
  g.start();
  await tick();
  assert.equal(f.live().length, 1);
  pending = false;                 // request ended
  await new Promise(r => setTimeout(r, 20)); // < grace: still awake (bridges gaps)
  assert.equal(f.live().length, 1, 'stays awake during the grace window');
  await new Promise(r => setTimeout(r, 70)); // > grace
  assert.equal(f.live().length, 0, 'released after the grace period');
  g.stop();
});

test('work returning during the grace window CANCELS the release (keeps the same child)', async () => {
  const f = fakeSpawner();
  let pending = true;
  const g = new SleepGuard({ enabled: true, spawn: f.spawn, getWorkPending: () => pending, pollMs: 5, graceMs: 40 });
  g.start();
  await tick();
  pending = false;                 // idle → grace timer starts
  await new Promise(r => setTimeout(r, 15));
  pending = true;                  // new request before grace elapses
  await new Promise(r => setTimeout(r, 40));
  assert.equal(f.live().length, 1, 'never dropped the wake');
  assert.equal(f.spawned.length, 1, 'reused the SAME caffeinate child (no churn)');
  g.stop();
});

test('disabled (non-macOS / test env) → complete no-op, never spawns', async () => {
  const f = fakeSpawner();
  const g = new SleepGuard({ enabled: false, spawn: f.spawn, getWorkPending: () => true, pollMs: 5, graceMs: 20 });
  g.start();
  await tick();
  assert.equal(f.spawned.length, 0, 'no caffeinate when disabled');
  g.stop();
});

test('stop() kills the child and clears timers (no zombie, no dangling interval)', async () => {
  const f = fakeSpawner();
  const g = new SleepGuard({ enabled: true, spawn: f.spawn, getWorkPending: () => true, pollMs: 5, graceMs: 20 });
  g.start();
  await tick();
  assert.equal(f.live().length, 1);
  g.stop();
  assert.equal(f.live().length, 0, 'child killed on stop');
  assert.equal(g.pollTimer, null); assert.equal(g.graceTimer, null);
});

test('a spawn that errors (caffeinate missing) never throws, and STOPS retrying every poll', async () => {
  let spawnCount = 0;
  const spawn = () => { spawnCount++; const c = new EventEmitter(); c.kill = () => {}; setTimeout(() => c.emit('error', new Error('ENOENT')), 0); return c; };
  const g = new SleepGuard({ enabled: true, spawn, getWorkPending: () => true, pollMs: 5, graceMs: 20 });
  assert.doesNotThrow(() => g.start());
  await new Promise(r => setTimeout(r, 40)); // several poll ticks elapse
  assert.equal(g.child, null, 'error handler nulled the ref; no crash');
  assert.equal(spawnCount, 1, 'disabled after the first failure — no busy re-spawn every poll');
  g.stop();
});
