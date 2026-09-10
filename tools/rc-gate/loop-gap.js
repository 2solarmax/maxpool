// Sleep is not a stall.
//
// macOS pauses `mach_absolute_time` — what `process.hrtime` reads — while the machine
// is asleep, but the wall clock keeps running. A timer that does not fire for 18
// minutes therefore looks identical to an 18-minute event-loop block unless the two
// clocks are compared. Measured 2026-09-10: an "~1106465ms blocked" report with ZERO
// gate log lines in the window, right after maxpool released its caffeinate assertion
// — the Mac had simply gone to sleep, and the watchdog paged on every sleep/wake.
// Verified awake, the two clocks agree to within 1ms, so the divergence is clean.
//
// Its own file so a test can import it without booting the gate's listeners.
export function classifyLoopGap(driftMs, wallGapMs, monoGapMs, {
  reportOverMs = 250, suspendSlackMs = 1000,
} = {}) {
  if (driftMs <= reportOverMs) return { kind: 'ok' };
  if (wallGapMs - monoGapMs > suspendSlackMs) return { kind: 'suspend', seconds: Math.round(wallGapMs / 1000) };
  return { kind: 'stall', driftMs };
}
