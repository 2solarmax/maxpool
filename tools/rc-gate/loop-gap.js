// Sleep is not a stall — and hrtime cannot tell you which one happened.
//
// 2026-09-10, TWICE. The watchdog reported "blocked ~1106465ms" (18 min) while the Mac
// was simply asleep. The first fix compared Date.now() against process.hrtime on the
// theory that macOS pauses the monotonic clock across sleep. It does NOT on this
// machine: after that fix shipped, a 225877ms gap at 17:17:32Z was still classified a
// stall and `[suspend]` never once fired. Node's hrtime is continuous across sleep
// here, so both clocks advance together and the discriminator was inert. It passed its
// tests only because they hand-fed it the monotonic value the theory predicted.
//
// The signal that actually works is the kernel's own: `sysctl -n kern.waketime` is the
// timestamp of the last wake. If it falls inside the window the loop went quiet, the
// machine woke during the gap — that is a suspend, not starvation. Verified against the
// real event: waketime 17:18:30Z lands inside the 17:18:16Z gap.
//
// Its own file so a test can import it without booting the gate's listeners.
import { execFileSync } from 'node:child_process';

/** Epoch ms of the last system wake, or null when the platform cannot say.
 *  Only called on a LARGE gap, so the subprocess cost is paid a few times a day. */
export function readLastWakeMs({ exec = execFileSync } = {}) {
  try {
    // Absolute path first: under launchd the gate's PATH is the bare system set, and a
    // detector that silently cannot find its own tool is the failure mode this whole
    // file exists to stop happening a third time.
    let out;
    try { out = String(exec('/usr/sbin/sysctl', ['-n', 'kern.waketime'], { timeout: 2000 })); }
    catch { out = String(exec('sysctl', ['-n', 'kern.waketime'], { timeout: 2000 })); }
    const m = /sec\s*=\s*(\d+)/.exec(out);
    return m ? Number(m[1]) * 1000 : null;
  } catch { return null; }
}

export function classifyLoopGap(driftMs, {
  reportOverMs = 250,
  probeWakeOverMs = 5_000,   // below this a suspend is implausible; never pay the probe
  nowMs = Date.now(),
  lastWakeMs = null,
} = {}) {
  if (driftMs <= reportOverMs) return { kind: 'ok' };
  if (driftMs >= probeWakeOverMs && lastWakeMs != null) {
    // The loop went quiet at roughly nowMs - driftMs. A wake inside that window (with a
    // little slack for the wake-to-first-tick delay) means the gap was sleep.
    const gapStart = nowMs - driftMs - 2_000;
    if (lastWakeMs >= gapStart && lastWakeMs <= nowMs + 2_000) {
      return { kind: 'suspend', seconds: Math.round(driftMs / 1000) };
    }
  }
  return { kind: 'stall', driftMs };
}
