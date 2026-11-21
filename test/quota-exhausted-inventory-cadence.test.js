import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober, GRANTS_EVERY_MS, EXHAUSTED_NO_GRANTS_MS } from '../src/prober.js';

const minute = 60_000, hour = 60 * minute, day = 24 * hour;
const account = name => ({ name, type: 'oauth', accessToken: name, refreshToken: name + '-refresh',
  expiresAt: Date.now() + 30 * day });
const emptyListing = { grants: [], nextGrantId: null, cooldownUntil: null, eligible: true };

// Every account has a full week; `reset` is the natural refill. Listing and usage
// reads are counted separately because they are separate requests.
function harness(t, { names = ['full'], reset = Date.now() + 10 * day, listing = () => emptyListing } = {}) {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const am = new AccountManager(names.map(account));
  am.quotaProbeIntervalMs = minute;
  am.ensureTokenFresh = async () => true;
  const usage = [], lists = [];
  const state = { usageFails: false };
  const probeFn = async name => { usage.push(name); if (state.usageFails) return { error: 'HTTP 500', status: 500 }; return now >= reset ? { sevenDay: { utilization: 0.1, resetAt: now + 7 * day } } : { sevenDay: { utilization: 1, resetAt: reset } }; };
  const grantsFn = async name => { lists.push(name); return listing(name); };
  const make = target => new Prober(target, { intervalMs: minute, now: () => now, usageGapMs: 0, log: () => {}, probeFn, grantsFn });
  return { am, usage, lists, state, make, prober: make(am), advance: ms => { now += ms; }, now: () => now };
}
const sweepsFor = async (h, ms, step = 30 * minute) => {
  for (let spent = 0; spent < ms; spent += step) { h.advance(step); await h.prober.probeAll(); }
};

test('the empty-inventory interval is one day', () => {
  assert.equal(EXHAUSTED_NO_GRANTS_MS, day);
});

test('confirmed empty inventory on a full week is not read again until the daily check, which lists and reads usage once', async t => {
  const h = harness(t);
  await h.prober.probeAll();
  assert.deepEqual([h.lists.length, h.usage.length], [1, 1]);
  assert.equal(h.am.accounts[0].quota.probeNextCheckAt, h.now() + day);
  await sweepsFor(h, day - hour);
  assert.deepEqual([h.lists.length, h.usage.length], [1, 1], 'no routine check in the first 23 hours');
  await sweepsFor(h, 2 * hour);
  assert.deepEqual([h.lists.length, h.usage.length], [2, 2], 'one daily check');
});

test('natural reset wakes an empty-inventory week early', async t => {
  const h = harness(t, { reset: Date.now() + 3 * hour });
  await h.prober.probeAll();
  assert.equal(h.am.accounts[0].quota.probeNextCheckAt, h.am.accounts[0].quota.unified7dReset);
  await sweepsFor(h, 2.5 * hour);
  assert.equal(h.usage.length, 1);
  await sweepsFor(h, 30 * minute);
  assert.equal(h.usage.length, 2, 'read exactly at the natural reset');
});

test('listing cooldown expiry wakes an empty-inventory week early', async t => {
  const h = harness(t, { listing: () => ({ ...emptyListing, cooldownUntil: Date.now() + 5 * hour }) });
  await h.prober.probeAll();
  assert.equal(h.am.accounts[0].quota.probeNextCheckAt, h.now() + 5 * hour);
  await sweepsFor(h, 4 * hour);
  assert.equal(h.usage.length, 1);
  await sweepsFor(h, 2 * hour);
  assert.equal(h.usage.length, 2);
});

test('an observed claim and a manual check both bypass the daily wait', async t => {
  const h = harness(t, { names: ['claimed', 'manual'] });
  await h.prober.probeAll();
  h.advance(minute);
  h.am.accounts[0].lastClaimAt = h.now();
  assert.equal(h.prober.requestUsageRecheck(h.am.accounts[1]).startsWith('Quota check queued'), true);
  await h.prober.probeAll();
  assert.deepEqual(h.usage.slice(2).sort(), ['claimed', 'manual']);
});

test('a provider-imposed wait outranks the daily check', async t => {
  const h = harness(t);
  await h.prober.probeAll();
  await sweepsFor(h, day);
  assert.equal(h.usage.length, 2);
  h.am.accounts[0].quota.probeRetryAt = h.now() + 2 * hour;
  h.am.accounts[0].resetGrants = { ...h.am.accounts[0].resetGrants, checkedAt: h.now() - 2 * day };
  await sweepsFor(h, hour);
  assert.equal(h.usage.length, 2, 'still waiting for the provider');
  await sweepsFor(h, 2 * hour);
  assert.equal(h.usage.length, 3);
});

test('unknown, pending and failed inventory keep the current grant cadence', async t => {
  for (const listing of [() => null, () => ({ ...emptyListing, nextGrantId: 'g-next' }), () => ({ error: 'HTTP 500' })]) {
    const h = harness(t, { listing });
    await h.prober.probeAll();
    assert.equal(h.am.accounts[0].quota.probeNextCheckAt, h.now() + GRANTS_EVERY_MS, String(listing));
  }
});

test('a restart keeps a confirmed-empty week on its daily schedule instead of re-reading every account', async t => {
  const h = harness(t, { names: ['a', 'b', 'c'] });
  await h.prober.probeAll();
  const saved = h.am.exportQuotaState();
  h.advance(2 * hour);
  const restored = new AccountManager(['a', 'b', 'c'].map(account));
  restored.quotaProbeIntervalMs = minute;
  restored.ensureTokenFresh = async () => true;
  restored.restoreQuotaState(saved);
  const reborn = h.make(restored);
  const [lists, usage] = [h.lists.length, h.usage.length];
  await reborn.probeAll();
  assert.deepEqual([h.lists.length, h.usage.length], [lists, usage], 'no read after restart');
  assert.equal(restored.accounts[0].quota.probeNextCheckAt, saved[0].resetGrants.checkedAt + day);
});

test('after long downtime overdue daily checks drain one account per sweep', async t => {
  const h = harness(t, { names: ['a', 'b', 'c', 'd'] });
  await h.prober.probeAll();
  const saved = h.am.exportQuotaState();
  h.advance(3 * day);
  const restored = new AccountManager(['a', 'b', 'c', 'd'].map(account));
  restored.quotaProbeIntervalMs = minute;
  restored.ensureTokenFresh = async () => true;
  restored.restoreQuotaState(saved);
  const reborn = h.make(restored);
  const base = h.usage.length;
  for (let sweep = 1; sweep <= 4; sweep++) {
    await reborn.probeAll();
    assert.equal(h.usage.length - base, sweep, `sweep ${sweep}`);
    h.advance(minute);
  }
});

test('a failed usage read right after a good empty listing is retried on the next sweep, not a day later', async t => {
  const h = harness(t);
  await h.prober.probeAll();
  await sweepsFor(h, day - 30 * minute);
  assert.deepEqual([h.lists.length, h.usage.length], [1, 1]);
  h.state.usageFails = true;
  h.advance(30 * minute);
  await h.prober.probeAll();                     // the daily check: listing ok, usage read fails
  assert.deepEqual([h.lists.length, h.usage.length], [2, 2]);
  h.state.usageFails = false;
  h.advance(30 * minute);
  await h.prober.probeAll();
  assert.equal(h.usage.length, 3, 'the failed read is retried on the next sweep');
});

test('a disabled exhausted account with an empty listing is read once a day, not on every sweep', async t => {
  const h = harness(t, { names: ['off', 'on'] });
  await h.prober.probeAll();
  h.am.accounts[0].enabled = false;              // listing is skipped for it from now on
  const listsBefore = h.lists.length;
  await sweepsFor(h, 50 * hour);
  const reads = h.usage.filter(name => name === 'off').length;
  assert.equal(reads, 3, 'first read plus one per day');
  assert.equal(h.lists.filter(name => name === 'off').length, 1, 'never listed again');
  assert.ok(h.lists.length > listsBefore, 'the enabled account still gets its daily listing');
});

test('a restored empty listing whose daily listing then fails goes back to the regular sweep cadence', async t => {
  let fail = false;
  const h = harness(t, { listing: () => (fail ? { error: 'HTTP 500' } : emptyListing) });
  await h.prober.probeAll();
  const saved = h.am.exportQuotaState();
  h.advance(day + hour);
  fail = true;
  const restored = new AccountManager([account('full')]);
  restored.quotaProbeIntervalMs = minute;
  restored.ensureTokenFresh = async () => true;
  restored.restoreQuotaState(saved);
  const reborn = h.make(restored);
  await reborn.probeAll();
  assert.equal(h.usage.length, 2, 'the overdue daily check ran');
  assert.equal(restored.accounts[0].resetGrants.lastError, 'HTTP 500');
  assert.equal(restored.accounts[0].quota.probeNextCheckAt, h.now() + minute, 'next regular sweep, not another day');
  h.advance(minute);
  await reborn.probeAll();
  assert.equal(h.usage.length, 3, 'read again on the next sweep');
});
