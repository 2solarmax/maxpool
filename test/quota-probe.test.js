import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { normalizeUsageBucket } from '../src/oauth.js';

function manager(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}
const WEEK_OUT = () => Date.now() + 3 * 24 * 3600_000;

test('probeAll applies usage to every oauth account', async () => {
  const am = manager(2);
  const probeFn = async () => ({
    fiveHour: { utilization: 0.30, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.50, resetAt: WEEK_OUT() },
  });
  const prober = new Prober(am, { probeFn, log: () => {} });
  await prober.probeAll();

  assert.equal(am.accounts[0].quota.unified5h, 0.30);
  assert.equal(am.accounts[0].quota.unified7d, 0.50);
  assert.equal(am.accounts[1].quota.unified7d, 0.50);
});

test('a DISABLED account is still probed — quota stays visible while benched', async () => {
  const am = manager(2);
  am.setAccountEnabled(1, false);   // user disables a2 because it looked exhausted
  assert.equal(am.accounts[1].enabled, false);
  const probeFn = async () => ({
    fiveHour: { utilization: 0.20, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.40, resetAt: WEEK_OUT() },
  });
  const prober = new Prober(am, { probeFn, log: () => {} });
  await prober.probeAll();
  // The disabled account's quota still refreshes, so the user sees it recover.
  assert.equal(am.accounts[1].quota.unified7d, 0.40, 'disabled account quota is still refreshed');
  assert.equal(am.accounts[1].enabled, false, 'probing does not re-enable it');
});

test('overlapping probe cycles are skipped', async () => {
  const am = manager(2);
  let calls = 0;
  const probeFn = () => new Promise(r => {
    calls++;
    setTimeout(() => r({ sevenDay: { utilization: 0.1, resetAt: WEEK_OUT() } }), 20);
  });
  const prober = new Prober(am, { probeFn, log: () => {} });
  const p1 = prober.probeAll();
  const p2 = prober.probeAll(); // running -> skipped
  await Promise.all([p1, p2]);
  assert.equal(calls, am.accounts.length); // one cycle, not two
});

test('a transient probe error leaves quota untouched', async () => {
  const am = manager(1);
  const prober = new Prober(am, { probeFn: async () => ({ error: 'HTTP 500', status: 500 }), log: () => {} });
  await prober.probeOne(am.accounts[0]);
  assert.equal(am.accounts[0].quota.unified7d, null);
});

test('probeAll de-bursts oauth probes (paced, one at a time)', async () => {
  const am = manager(3);
  const starts = [];
  let concurrent = 0, maxConcurrent = 0;
  const probeFn = async () => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    starts.push(Date.now());
    await new Promise(r => setTimeout(r, 5));
    concurrent--;
    return { sevenDay: { utilization: 0.4, resetAt: WEEK_OUT() } };
  };
  // The old Promise.all fired all three at once → the shared usage endpoint 429'd
  // all but one. Paced, at most one is ever in flight and they're spread by the gap.
  const prober = new Prober(am, { probeFn, usageGapMs: 40, log: () => {} });
  await prober.probeAll();

  assert.equal(starts.length, 3, 'all three probed');
  assert.equal(maxConcurrent, 1, 'never two usage probes in flight at once');
  assert.ok(starts[1] - starts[0] >= 30, `2nd probe paced after 1st (${starts[1] - starts[0]}ms)`);
  assert.ok(starts[2] - starts[1] >= 30, `3rd probe paced after 2nd (${starts[2] - starts[1]}ms)`);
});

test('a 429 is recorded (not swallowed) and backs off the usage gap', async () => {
  const am = manager(1);
  const prober = new Prober(am, { probeFn: async () => ({ error: 'HTTP 429', status: 429 }), usageGapMs: 20, log: () => {} });
  await prober.probeAll();

  assert.equal(am.accounts[0].quota.unified7d, null, 'quota untouched on 429');
  assert.equal(am.accounts[0].quota.lastProbeErrorStatus, 429, 'error surfaced, not swallowed');
  assert.ok(prober._usageGapMs > 20, `gap widened after 429 (${prober._usageGapMs}ms)`);
});

test('_baseUsageGap derives the probe spacing from the interval (interval/6, clamped 6-20s)', () => {
  const g = im => new Prober(manager(1), { intervalMs: im, log: () => {} })._baseUsageGap();
  assert.equal(g(60_000), 10_000, '60s interval → 10s spacing');
  assert.equal(g(6_000), 6_000, 'tiny interval clamps up to the 6s floor');
  assert.equal(g(600_000), 20_000, 'huge interval clamps down to the 20s cap');
  assert.equal(g(0), 0, 'probe off → no pacing');
  // An explicit gap overrides the derivation (the test knob).
  assert.equal(new Prober(manager(1), { intervalMs: 60_000, usageGapMs: 123, log: () => {} })._baseUsageGap(), 123);
});

test('stop() aborts an in-flight pacing wait quickly', async () => {
  const am = manager(3);
  const prober = new Prober(am, {
    probeFn: async () => ({ sevenDay: { utilization: 0.4, resetAt: WEEK_OUT() } }),
    usageGapMs: 5000, // long gap so the sweep is mid-pace when we stop it
    log: () => {},
  });
  const cycle = prober.probeAll();
  const t0 = Date.now();
  await prober.stop(); // must not block for the full 5s pacing gap
  await cycle;
  assert.ok(Date.now() - t0 < 1000, `stop() returned promptly (${Date.now() - t0}ms), not after the 5s gap`);
});

test('a 401 forces a token refresh and retries once', async () => {
  const am = manager(1);
  let forced = false;
  am.ensureTokenFresh = async (_idx, force) => { if (force) forced = true; return true; };
  let n = 0;
  const probeFn = async () => (++n === 1
    ? { status: 401, error: 'HTTP 401' }
    : { sevenDay: { utilization: 0.20, resetAt: WEEK_OUT() } });
  const prober = new Prober(am, { probeFn, log: () => {} });
  await prober.probeOne(am.accounts[0]);

  assert.equal(forced, true);
  assert.equal(am.accounts[0].quota.unified7d, 0.20);
});

test('applyUsageData clears probing when the weekly window is learned', () => {
  const am = manager(1);
  am.accounts[0].probing = true;
  am.applyUsageData(0, { sevenDay: { utilization: 0.60, resetAt: WEEK_OUT() } });
  assert.equal(am.accounts[0].quota.unified7d, 0.60);
  assert.equal(am.accounts[0].probing, false);
  assert.equal(am.accounts[0].requalify, true);
});

test('normalizeUsageBucket tolerates percentage and epoch/iso reset formats', () => {
  assert.deepEqual(
    normalizeUsageBucket({ used_percentage: 42, resets_at: 1_700_000_000 }), // epoch seconds
    { utilization: 0.42, resetAt: 1_700_000_000_000 },
  );
  assert.deepEqual(
    normalizeUsageBucket({ utilization: 0.3, resetAt: 1_700_000_000_000 }), // already-fraction + ms
    { utilization: 0.3, resetAt: 1_700_000_000_000 },
  );
  assert.equal(normalizeUsageBucket(null), null);
  assert.equal(normalizeUsageBucket({}).utilization, null);
});
