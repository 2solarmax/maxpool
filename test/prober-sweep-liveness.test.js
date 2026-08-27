// The accounts page answers "what happens next?" on a stale quota reading —
// "quota 12m old · refreshing in 45s" / "· refreshing now". Owner, 2026-08-27:
// a bare "stale" named an internal mechanism and left the user with nothing to do.
//
// That text is only honest if the PROBER actually publishes its liveness. These
// pin the producer side: without them the UI reads two fields nothing writes, the
// countdown silently degrades to the generic fallback forever, and the tests over
// in tui-quota-render (which set the fields by hand) still pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

function harness({ intervalMs = 60_000 } = {}) {
  const am = new AccountManager([{
    name: 'a1', type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
  }], 0.90);
  am.setWriterLease(true);
  am.ensureTokenFresh = async () => {};
  const seen = [];
  const probeFn = async () => {
    // Sampled DURING the sweep — this is the whole point of the flag.
    seen.push(am.quotaProbeSweeping);
    return { ok: true, status: 200, data: {} };
  };
  const prober = new Prober(am, {
    intervalMs, probeFn, providerProbeFn: async () => null,
    log: () => {}, usageGapMs: 0,
  });
  return { am, prober, seen };
}

test('the prober flags a sweep as in flight, and clears it when done', async () => {
  const { am, prober, seen } = harness();
  assert.equal(am.quotaProbeSweeping, undefined, 'nothing claimed before the first sweep');
  await prober.probeAll();
  assert.deepEqual(seen, [true], 'the flag was TRUE while the probe was actually running');
  assert.equal(am.quotaProbeSweeping, false, 'and false the moment the sweep finished');
});

test('the prober publishes when the NEXT sweep lands, within the configured interval', async () => {
  const { am, prober } = harness({ intervalMs: 60_000 });
  const before = Date.now();
  await prober.probeAll();
  const at = am.quotaProbeNextSweepAt;
  assert.ok(Number.isFinite(at), 'a concrete timestamp, not null');
  // The value must be the real interval ahead — a mutant that publishes `Date.now()`
  // (or a hardcoded constant) renders "refreshing now" forever on a quiet prober.
  assert.ok(at - before >= 59_000 && at - before <= 61_500,
    `~one interval out, got ${(at - before) / 1000}s`);
});

test('a manual/off prober publishes NO next-sweep time rather than a fictional one', async () => {
  // intervalMs 0 = probe driven by hand (tests, one-shot). Publishing "now + 0"
  // would render "refreshing now" permanently, which is a lie the UI cannot detect.
  const { am, prober } = harness({ intervalMs: 0 });
  await prober.probeAll();
  assert.equal(am.quotaProbeNextSweepAt, null, 'no schedule → no promise');
  assert.equal(am.quotaProbeSweeping, false);
});

test('the flag clears even when the sweep throws', async () => {
  // A stuck `true` would render "refreshing now" forever while nothing refreshes —
  // exactly the invisible-failure shape this whole cell exists to prevent.
  const { am, prober } = harness();
  prober.probeOne = async () => { throw new Error('boom'); };
  await prober.probeAll().catch(() => {});
  assert.equal(am.quotaProbeSweeping, false, 'finally-block, not a happy-path clear');
});
