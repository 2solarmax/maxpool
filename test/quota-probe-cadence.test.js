import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober, GRANTS_EVERY_MS } from '../src/prober.js';
import { fetchUsage } from '../src/oauth.js';
import { listResetGrants } from '../src/claude-reset-grants.js';
import { TUI, __tuiTest } from '../src/tui.js';

const minute = 60_000;
const account = name => ({ name, type: 'oauth', accessToken: name, refreshToken: name + '-refresh',
  expiresAt: Date.now() + 86400_000 });
function harness(t, { usage, grants = async () => null }) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const am = new AccountManager([account('full'), account('available')]);
  am.quotaProbeIntervalMs = minute;
  am.ensureTokenFresh = async () => true;
  const calls = [];
  const prober = new Prober(am, { intervalMs: minute, now: () => now, usageGapMs: 0, log: () => {},
    probeFn: async name => { calls.push(name); return usage(name, now); }, grantsFn: grants });
  return { am, calls, prober, advance: ms => { now += ms; } };
}

test('a fully exhausted week is sampled every grant interval and an external redemption returns it to the normal cohort', async t => {
  const reset = Date.now() + 4 * 86400_000;
  let externalRedemption = false;
  const { am, calls, prober, advance } = harness(t, { usage: name => ({
    sevenDay: { utilization: name === 'full' && !externalRedemption ? 1 : 0.25, resetAt: reset },
  }) });
  await prober.probeAll();
  assert.equal(am.getStatus().accounts[0].quota.probeNextCheckAt, Date.now() + GRANTS_EVERY_MS);
  externalRedemption = true;
  for (let i = 0; i < 4; i++) { advance(minute); await prober.probeAll(); }
  assert.deepEqual(calls.filter(name => name === 'full'), ['full']);
  assert.equal(calls.filter(name => name === 'available').length, 5);
  advance(minute); await prober.probeAll();
  assert.equal(am.accounts[0].quota.unified7d, 0.25);
  assert.equal(am.accounts[0].quota.unified7dReset, reset);
  advance(minute); await prober.probeAll();
  assert.equal(calls.filter(name => name === 'full').length, 3);
});

test('natural refill and a locally observed claim both bring the next weekly check forward', async t => {
  const reset = Date.now() + 2 * minute;
  const { am, calls, prober, advance } = harness(t, { usage: () => ({ sevenDay: { utilization: 1, resetAt: reset } }) });
  await prober.probeAll();
  assert.equal(am.accounts[0].quota.probeNextCheckAt, reset);
  advance(minute);
  am.accounts[1].lastClaimAt = Date.now();
  await prober.probeAll();
  assert.deepEqual(calls, ['full', 'available', 'available']);
  advance(minute); await prober.probeAll();
  assert.deepEqual(calls.slice(3).sort(), ['available', 'full']);
});

test('explicit Retry-After from either usage endpoint is respected per row through a restart', async t => {
  let grantsBlocked = false, usageBlocked = true;
  const { am, calls, prober, advance } = harness(t, {
    usage: (name, now) => name === 'full' && usageBlocked
      ? { status: 429, error: 'limited', retryAt: now + 8 * minute } : { fiveHour: { utilization: 0.1 } },
    grants: async name => name === 'available' && grantsBlocked
      ? { status: 429, error: 'limited', retryAt: Date.now() + 9 * minute } : null,
  });
  await prober.probeAll();
  usageBlocked = false;
  const restored = new AccountManager([account('full'), account('available')]);
  restored.restoreQuotaState(am.exportQuotaState());
  assert.equal(restored.accounts[0].quota.probeRetryAt, Date.now() + 8 * minute);
  const headless = new AccountManager([account('full'), account('available')]);
  headless.restoreProbeRetryDeadlines(am.exportQuotaState());
  assert.equal(headless.accounts[0].quota.probeRetryAt, Date.now() + 8 * minute);
  const reloaded = new Prober(restored, { now: Date.now, probeFn: async () => assert.fail('early usage retry'),
    grantsFn: async () => assert.fail('early grants retry') });
  assert.equal((await reloaded.probeOne(restored.accounts[0])).skipped, 'retry-after');
  grantsBlocked = true;
  advance(minute); await prober.probeAll();
  assert.equal(am.accounts[1].quota.probeNextCheckAt, Date.now() + 9 * minute);
  assert.equal(calls.length, 2, 'both usage requests stayed suppressed on the second sweep');
  advance(7 * minute); await prober.probeAll();
  assert.equal(calls.at(-1), 'full');
  assert.equal(am.accounts[0].quota.probeRetryAt, null);
  assert.equal(calls.filter(n => n === 'available').length, 1);
});

test('usage and grant reads capture delta seconds and HTTP dates, and leave absent or malformed Retry-After unset', async t => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  t.mock.method(Date, 'now', () => now);
  let header;
  const upstream = async () => new globalThis.Response('{}', { status: 429, headers: header == null ? {} : { 'retry-after': header } });
  t.mock.method(globalThis, 'fetch', upstream);
  for (const [value, due] of [['87', now + 87000], [new Date(now + 94000).toUTCString(), now + 94000],
    [null, undefined], ['8 seconds??', undefined]]) {
    header = value;
    assert.equal((await fetchUsage('synthetic')).retryAt, due);
    assert.equal((await listResetGrants('synthetic', { fetchImpl: upstream })).retryAt, due);
  }
});

test('a mirror reports its owner’s next check, and a newer success clears an old throttle label', t => {
  const am = new AccountManager([]);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  am.quotaProbeIntervalMs = minute;
  am.quotaProbeSweeping = true;
  const tui = new TUI({ accountManager: am });
  const row = { type: 'oauth', remote: { linkName: 'team' }, quota: {
    unified7d: 1, unified7dReset: now + 86400_000, lastProbeOkAt: now - 4 * minute,
    lastProbeErrorStatus: 429, lastProbeErrorAt: now - 7 * minute, probeNextCheckAt: now + 45000,
  } };
  const note = () => __tuiTest.strip(tui._probeHealthNote(row));
  assert.match(note(), /quota 4m old · next check due in 45s/);
  row.quota.lastProbeErrorAt = now - minute;
  assert.match(note(), /rate-limited, next check due in 45s/);
  delete row.quota.probeNextCheckAt;
  assert.match(note(), /cloud check time unavailable/);
  assert.doesNotMatch(note(), /retrying now/);
});

test('a benched twin uses a sparse cloud snapshot without inheriting a local 429, deadline or sweep', t => {
  const am = new AccountManager([account('bench')]);
  const now = Date.now(), local = am.accounts[0];
  t.mock.method(Date, 'now', () => now);
  local.poolBenchedBy = 'team';
  Object.assign(local.quota, { lastProbeErrorStatus: 429, lastProbeErrorAt: now, probeRetryAt: now + 5 * minute,
    probeChecking: true });
  const cloud = { name: 'source', type: 'oauth', enabled: true, quota: { unified7d: 1,
    lastProbeOkAt: now - 4 * minute, unified7dReset: now + 86400_000 } };
  am.quotaProbeSweeping = true;
  am.quotaProbeIntervalMs = minute;
  am.remoteRowFor = () => ({ row: cloud });
  const tui = new TUI({ accountManager: am });
  const render = () => __tuiTest.strip(tui._renderAcct(0, 11, true));
  assert.match(render(), /cloud check time unavailable/);
  assert.doesNotMatch(render(), /rate-limited|refreshing now/);
  cloud.quota.probeNextCheckAt = now + minute;
  assert.match(render(), /next check due in 1m/);
  am.syncRemoteMirrors({ name: 'team', lastOkAt: now, status: { accounts: [cloud] } });
  assert.equal(am.accounts[1].quota.probeNextCheckAt, cloud.quota.probeNextCheckAt);
  am.remoteRowFor = () => null;
  assert.match(render(), /cloud quota unavailable/);
  assert.doesNotMatch(render(), /rate-limited|refreshing now/);
});

test('a held reset or stale grant listing still gets the normal decision cadence until it resolves', async t => {
  const reset = Date.now() + 4 * 86400_000;
  const { am, calls, prober, advance } = harness(t, { usage: () => ({ sevenDay: { utilization: 1, resetAt: reset } }) });
  await prober.probeAll();
  am.isHoldingWall = row => row.name === 'full';
  am.accounts[1].resetGrants = { stale: true, grants: [] };
  advance(minute);
  await prober.probeAll();
  assert.equal(calls.filter(n => n === 'full').length, 2);
  assert.equal(calls.filter(n => n === 'available').length, 2);
  am.isHoldingWall = () => false;
  am.accounts[1].resetGrants.stale = false;
  advance(minute);
  await prober.probeAll();
  assert.equal(calls.length, 4);
});
