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
