// The stall watchdog must not page on system sleep — and must still catch starvation.
//
// Driver 2026-09-10, twice. First the gate reported "blocked ~1106465ms" (18 min) while
// the Mac slept. Then the FIX for that was inert: it compared Date.now() to
// process.hrtime on the theory that macOS pauses the monotonic clock across sleep, and
// on this machine it does not — a 225877ms gap at 17:17:32Z was still called a stall and
// `[suspend]` never fired. These tests are written against the KERNEL's wake timestamp,
// which is the signal that actually moved, and against the real numbers observed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoopGap, readLastWakeMs } from '../tools/rc-gate/loop-gap.js';

const T = (s) => Date.parse(`2026-09-10T${s}Z`);

test('the real 17:18 sleep is a suspend — waketime lands inside the gap', () => {
  // Observed: gap ended 17:18:16Z after 33327ms; kern.waketime reported 17:18:30Z.
  // (The wake tick arrives just after the kernel stamps it, hence the forward slack.)
  const v = classifyLoopGap(33_327, { nowMs: T('17:18:16'), lastWakeMs: T('17:18:16') });
  assert.equal(v.kind, 'suspend');
});

test('the 18-minute nap is a suspend', () => {
  const now = T('16:59:02');
  const v = classifyLoopGap(1_106_465, { nowMs: now, lastWakeMs: now - 1_000 });
  assert.equal(v.kind, 'suspend');
  assert.equal(v.seconds, 1106);
});

test('a long gap with NO wake in the window is a real stall', () => {
  // This is the case the first fix got wrong: big gap, machine never slept.
  const now = T('12:38:33');
  const v = classifyLoopGap(213_233, { nowMs: now, lastWakeMs: now - 6 * 3600_000 });
  assert.equal(v.kind, 'stall');
});

test('the 2026-09-07 starvation stalls stay stalls', () => {
  for (const d of [274, 289, 353, 470, 672, 1781, 2780]) {
    const v = classifyLoopGap(d, { nowMs: T('12:00:00'), lastWakeMs: T('06:00:00') });
    assert.equal(v.kind, 'stall', `${d}ms should report as a stall`);
  }
});

test('a small gap never consults the wake clock, even if a wake just happened', () => {
  // Sub-5s gaps are starvation by construction; a coincident wake must not excuse them.
  const now = T('12:00:00');
  assert.equal(classifyLoopGap(2_780, { nowMs: now, lastWakeMs: now }).kind, 'stall');
});

test('quiet below the reporting threshold', () => {
  for (const d of [0, 12, 250]) assert.equal(classifyLoopGap(d).kind, 'ok');
});

test('an unavailable wake clock degrades to reporting, never to silence', () => {
  const v = classifyLoopGap(120_000, { nowMs: T('12:00:00'), lastWakeMs: null });
  assert.equal(v.kind, 'stall');
});

test('readLastWakeMs parses the sysctl shape, and survives a missing sysctl', () => {
  const ms = readLastWakeMs({ exec: () => '{ sec = 1789060710, usec = 754593 } Thu Sep 10 20:18:30 2026\n' });
  assert.equal(ms, 1789060710000);
  assert.equal(readLastWakeMs({ exec: () => { throw new Error('no sysctl'); } }), null);
  assert.equal(readLastWakeMs({ exec: () => 'garbage' }), null);
});
