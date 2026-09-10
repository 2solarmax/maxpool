// The stall watchdog must not page on system sleep.
//
// Driver 2026-09-10: the gate reported "event loop blocked ~1106465ms" (18 min) with
// ZERO log lines in the window — the Mac was asleep after maxpool released its
// caffeinate assertion. macOS pauses process.hrtime across sleep while Date.now keeps
// running, so comparing the two separates a suspend from a real block. Awake, they
// agree to within 1ms (measured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLoopGap } from '../tools/rc-gate/loop-gap.js';

test('a real event-loop block is still reported', () => {
  // Both clocks saw the same elapsed time — the process was starved, not suspended.
  const v = classifyLoopGap(670, 1170, 1170);
  assert.equal(v.kind, 'stall');
  assert.equal(v.driftMs, 670);
});

test('the 2026-09-07 starvation stalls stay stalls', () => {
  for (const d of [274, 289, 353, 470, 672, 1781, 2780]) {
    const v = classifyLoopGap(d, d + 500, d + 500);
    assert.equal(v.kind, 'stall', `${d}ms should report as a stall`);
  }
});

test('system sleep is classified as a suspend, not a stall', () => {
  // The real 2026-09-10 event: 18 minutes of wall clock, none of it seen by hrtime.
  const v = classifyLoopGap(1_106_465, 1_106_965, 12);
  assert.equal(v.kind, 'suspend');
  assert.equal(v.seconds, 1107);
});

test('the shorter sleep artifacts that day are also suspends', () => {
  for (const [drift, mono] of [[121_537, 30], [55_261, 18], [70_669, 25], [213_233, 40]]) {
    assert.equal(classifyLoopGap(drift, drift + 500, mono).kind, 'suspend', `${drift}ms should be a suspend`);
  }
});

test('quiet below the reporting threshold', () => {
  for (const d of [0, 12, 250]) assert.equal(classifyLoopGap(d, d + 500, d + 500).kind, 'ok');
});

test('normal jitter never reads as a suspend', () => {
  // Awake, the clocks agree within ~1ms; that must never cross the suspend slack.
  const v = classifyLoopGap(300, 800, 799);
  assert.equal(v.kind, 'stall');
});
