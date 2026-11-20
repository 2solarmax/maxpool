import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCapacityDrain, readCapacityDrains, acknowledgeCapacityDrains } from '../src/config.js';
import { AccountManager } from '../src/account-manager.js';
import { CapacityLedger } from '../src/capacity-ledger.js';
import { cacheHistoryFromHours, cacheWindows, readCacheSnapshot } from '../src/account-cache.js';

const now = Date.UTC(2026, 10, 20, 12, 30);
const hour = 3600_000;
const minute = 60_000;
const account = (name, provider = 'anthropic') => ({ name, provider, type: 'oauth', accountUuid: name });

test('cache windows retain input, reads, writes and output independently across rolling boundaries, restart and eviction', () => {
  let time = now - 9 * 24 * hour;
  const ledger = new CapacityLedger({ now: () => time });
  function book(age, input, cacheRead, cacheCreation, output) {
    time = now - age;
    ledger.accrue('a', { input, cacheRead, cacheCreation, output });
  }
  book(9 * 24 * hour, 1000, 100, 0, 6);
  book(6 * 24 * hour, 6, 0, 0, 3);
  book(23 * hour, 23, 0, 0, 2);
  book(2 * hour, 2, 0, 0, 1);
  book(50 * minute, 5, 0, 0, 0);
  book(0, 2, 80, 18, 300);
  const check = l => {
    const { windows: w, since } = l.cacheWindows('a', now);
    assert.equal(since, now - 9 * 24 * hour);
    assert.equal(w['1h'].input, 7);
    assert.equal(w['3h'].input, 9);
    assert.equal(w['24h'].input, 32);
    assert.equal(w['7d'].input, 38);
    assert.deepEqual(w.all, { input: 1038, cacheRead: 180, cacheWrite: 18, output: 312, hit: 180 / 1236, partial: false });
    assert.equal(w['1h'].hit, 80 / 105);
    assert.equal(w['1h'].partial, false);
    assert.equal(l.cacheWindows('a', now + 61 * minute).windows['1h'].hit, null);
    assert.equal(l.cacheWindows('a', now + 61 * minute).windows.all.hit, w.all.hit);
  };
  check(ledger);
  const restored = CapacityLedger.fromSerialized(JSON.parse(JSON.stringify(ledger.serialize())), { now: () => now });
  check(restored);
  restored.accrue('a', { input: 10, output: 0 }, now);
  assert.equal(restored.cacheWindows('a', now).windows['1h'].input, 17, 'current-minute booking visible on subsequent repaint');
});

test('legacy offline hourly counts seed measured history only; a straddling legacy hour stays partial and old history never fabricates a cache hit', () => {
  const hist = cacheHistoryFromHours({
    '2026-11-20T09': { in: 40, cr: 60, cc: 0, out: 20 },
    '2026-11-20T10': { in: 1, cr: 99, cc: 0, out: 1 },
    '2026-11-20T12': { in: 0, cr: 0, cc: 5, out: 0 },
    '2026-11-15T09': { in: 900, cr: 900, cc: 0, out: 0 },
  }, now);
  const snap = cacheWindows(hist, now);
  assert.equal(snap.windows['3h'].hit, 99 / 105);
  assert.equal(snap.windows['3h'].partial, true);
  assert.equal(snap.windows.all.hit, 159 / 205);
  assert.equal(cacheWindows(cacheHistoryFromHours({}, now), now).windows['7d'].hit, null);
  assert.equal(readCacheSnapshot({ ...snap, windows: { all: snap.windows.all } }), null);
});

test('serving owners export the only measured token counts; linked accounts, including Codex, never double count forwarded requests', () => {
  const local = new AccountManager([account('local', 'codex')]);
  const cloud = new AccountManager([account('shared', 'codex')]);
  cloud.accrueCapacity(0, { input: 70, cacheRead: 30, output: 25 });
  const link = { name: 'team', url: 'http://fixture.invalid', lastOkAt: Date.now(), status: cloud.getStatus() };
  local.syncRemoteMirrors(link);
  const mirror = local.accounts.find(a => a.remote);
  local.accrueCapacity(mirror.index, { input: 70, cacheRead: 30, output: 25 });
  local.accrueCapacity(0, { input: 0, cacheRead: 10, output: 5 });
  local.syncRemoteMirrors(link);
  const total = local.providerCacheWindows().codex.windows.all;
  assert.deepEqual(total, { input: 70, cacheRead: 40, cacheWrite: 0, output: 30, hit: 40 / 110, partial: false });
  assert.equal(local.accountCacheWindows(mirror).windows.all.hit, 0.3);
  assert.equal(local.getStatus().accounts.find(a => a.remote).accountCache, null);
  delete link.status.accounts[0].accountCache;
  local.syncRemoteMirrors(link);
  assert.equal(local.accountCacheWindows(mirror), null);
  assert.equal(local.providerCacheWindows().codex.windows.all.partial, true);
});

test('post-handoff usage merges into the new worker without counting pre-handoff usage a second time', () => {
  const worker = new CapacityLedger({ now: () => now });
  worker.accrue('a', { input: 5, cacheRead: 15 });
  const baton = worker.serialize();
  const next = CapacityLedger.fromSerialized(baton, { now: () => now });
  next.accrue('a', { input: 3, cacheCreation: 1 });
  worker.accrue('a', { input: 7, cacheRead: 4 });
  const state = CapacityLedger.mergeDelta(next.serialize(), baton, worker.serialize());
  const view = CapacityLedger.fromSerialized(state, { now: () => now }).cacheWindows('a', now);
  assert.deepEqual(view.windows.all, { input: 15, cacheRead: 19, cacheWrite: 1, output: 0, hit: 19 / 35, partial: false });
  assert.equal(view.windows['3h'].cacheRead, 19);
});

test('account history follows the same identity across a benched local copy and its linked holder; disabled history remains visible', () => {
  const local = new AccountManager([account('same')]);
  const cloud = new AccountManager([account('same')]);
  const t = Date.now();
  local.accrueCapacity(0, { input: 6, cacheRead: 54, output: 8 }, t - 6 * hour);
  cloud.accrueCapacity(0, { input: 20, cacheRead: 0, output: 4 }, t);
  const remoteStatus = cloud.getStatus();
  const link = { name: 'team', url: 'http://fixture.invalid', lastOkAt: t, status: remoteStatus };
  local.syncRemoteMirrors(link);
  local.accounts[0].poolBenchedBy = 'same';
  const mirror = local.accounts.find(a => a.remote);
  assert.equal(local.accountCacheWindows(mirror, t).windows.all.hit, 54 / 80);
  assert.equal(local.accountCacheWindows(mirror, t).windows['3h'].hit, 0);
  assert.equal(local.providerCacheWindows(t).claude.windows.all.output, 12);

  cloud.accounts[0].enabled = false;
  local.accounts[0].enabled = false;
  link.status = cloud.getStatus();
  local.syncRemoteMirrors(link);
  assert.equal(mirror.enabled, false);
  assert.equal(local.providerCacheWindows(t).claude.windows.all.output, 12);
  assert.equal(local.accountCacheWindows(mirror, t).windows['24h'].cacheRead, 54);
  assert.equal(local.accountCacheWindows(mirror, t + hour).windows['1h'].partial, true, 'an old snapshot expires even if the timer never reports a failed poll');
  link.lastError = 'offline';
  local.syncRemoteMirrors(link);
  const partial = local.accountCacheWindows(mirror, t + hour);
  assert.equal(partial.windows.all.output, 12);
  assert.equal(partial.windows.all.partial, true);
  assert.equal(partial.windows['24h'].output, 8, 'stale finite cloud window is not added to the live local interval');
});

test('upgrade imports existing hours once, late native events invalidate past windows, and all-time includes expired minutes', () => {
  const am = new AccountManager([account('primary')]);
  const history = { primary: { '2026-11-20T09': { in: 50, out: 5, cr: 50, cc: 0 } } };
  am.restoreAccountCacheHours(history, now);
  am.restoreAccountCacheHours(history, now);
  am.accrueCapacity(0, { input: 100 }, now);
  assert.equal(am.accountCacheWindows(am.accounts[0], now).windows['1h'].input, 100);
  am.accrueCapacity(0, { input: 20 }, now - 2 * hour);
  am.accrueCapacity(0, { input: 10 }, now - 14 * 24 * hour);
  const view = am.accountCacheWindows(am.accounts[0], now);
  assert.equal(view.windows['3h'].input, 120);
  assert.equal(view.windows['7d'].input, 170);
  assert.equal(view.windows.all.input, 180);
  assert.equal(view.since, now - 14 * 24 * hour);
  assert.ok(Object.keys(Object.values(am.capacity.serialize().ownerCache)[0].minutes).length <= 2);
  const next = new AccountManager([account('primary')]);
  next.restoreCapacityState(am.capacity.serialize());
  next.restoreAccountCacheHours(history, now);
  assert.equal(next.accountCacheWindows(next.accounts[0], now).windows.all.input, 180);
});

test('released worker handoff survives an owner crash before or after saving without duplicating cache or capacity', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-cache-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'primary.state.json');
  const old = new CapacityLedger({ now: () => now });
  old.accrue('a', { input: 5, cacheRead: 12 });
  const before = old.serialize();
  old.accrue('a', { input: 3, cacheRead: 8 });
  await writeCapacityDrain(CapacityLedger.drainDelta(before, old.serialize()), path);
  const boot = state => CapacityLedger.fromSerialized(state, { now: () => now });
  let active = boot(before);
  const ids = await readCapacityDrains(active, path);
  assert.equal(ids.length, 1);
  assert.equal((await stat(join(path + '.drains', ids[0]))).mode & 0o777, 0o600);
  // Crash before the first save. The original file must still be replayable.
  active = boot(before);
  await readCapacityDrains(active, path);
  active.accrue('a', { cacheRead: 2 });
  // Crash after the save but before unlink. The atomically persisted id makes replay harmless.
  const resumed = boot(active.serialize());
  assert.deepEqual(await readCapacityDrains(resumed, path), ids);
  assert.equal(resumed.cacheWindows('a', now).windows.all.cacheRead, 22);
  assert.equal(resumed.openCycle('a', 'ses').tokensSoFar, 30);
  await acknowledgeCapacityDrains(resumed, ids, path);
  assert.deepEqual(await readCapacityDrains(resumed, path), []);
  assert.equal(resumed.serialize().appliedDrains, undefined);
});

test('two links to the same serving ledger contribute one snapshot, including after that worker restarts', () => {
  const edge = new AccountManager([]);
  const cloud = new AccountManager([account('shared', 'codex')]);
  cloud.accrueCapacity(0, { input: 72, cacheRead: 18 });
  const state = cloud.capacity.serialize();
  edge.syncRemoteMirrors({ name: 'first', url: 'http://first.invalid', lastOkAt: Date.now(), status: cloud.getStatus() });
  const restarted = new AccountManager([account('shared', 'codex')]);
  restarted.restoreCapacityState(state);
  restarted.accrueCapacity(0, { cacheRead: 5 });
  const status = restarted.getStatus();
  status.accounts[0].accountCache.asOf += 1;
  edge.syncRemoteMirrors({ name: 'alias', url: 'http://alias.invalid', lastOkAt: Date.now(), status });
  assert.equal(edge.accounts.length, 2);
  assert.equal(edge.providerCacheWindows().codex.windows.all.cacheRead, 23);
  assert.equal(edge.accountCacheWindows(edge.accounts[0]).windows.all.input, 72);
});

test('one display alias used by Claude and Codex keeps different account and provider totals through restart', () => {
  const rows = [account('shared'), account('shared', 'codex')];
  const am = new AccountManager(rows);
  am.restoreAccountCacheHours({ shared: { '2026-11-20T12': { in: 500, cr: 500, cc: 0, out: 0 } } }, now);
  am.accrueCapacity(0, { input: 10 }, now);
  am.accrueCapacity(1, { cacheRead: 90 }, now);
  const restored = new AccountManager(rows);
  restored.restoreCapacityState(am.capacity.serialize());
  for (const manager of [am, restored]) {
    assert.equal(manager.accountCacheWindows(manager.accounts[0], now).windows.all.hit, 0);
    assert.equal(manager.accountCacheWindows(manager.accounts[1], now).windows.all.hit, 1);
    const providers = manager.providerCacheWindows(now);
    assert.equal(providers.claude.windows.all.input, 10);
    assert.equal(providers.codex.windows.all.cacheRead, 90);
    assert.equal(providers.codex.windows.all.input, 0);
  }
});

test('same account alias on different links retains both UUIDs, destination names and provider totals', () => {
  const edge = new AccountManager([]);
  for (const [pool, uuid, fresh] of [['west', 'user-one', 10], ['east', 'user-two', 20]]) {
    const cloud = new AccountManager([{ ...account('shared'), accountUuid: uuid }]);
    cloud.accrueCapacity(0, { input: fresh });
    const link = { name: pool, url: 'http://' + pool + '.invalid', lastOkAt: Date.now(), status: cloud.getStatus() };
    edge.syncRemoteMirrors(link);
    edge.syncRemoteMirrors(link);
  }
  assert.equal(edge.accounts.length, 2);
  assert.equal(new Set(edge.accounts.map(a => a.name)).size, 2, 'internal routing labels remain unambiguous');
  assert.deepEqual(edge.accounts.map(a => [a.remote.linkName, a.remote.remoteName, edge.accountCacheWindows(a).windows.all.input]),
    [['west', 'shared', 10], ['east', 'shared', 20]]);
  assert.equal(edge.providerCacheWindows().claude.windows.all.input, 30);
});

test('different Codex users of one workspace are separately metered and two aliases of one holder seed the observed legacy sum', () => {
  const members = ['u1', 'u2'].map(id => ({
    ...account(id, 'codex'), codexAccountId: 'workspace', codexAuth: 'native', organizationUuid: 'workspace',
  }));
  const am = new AccountManager([...members, { ...members[0], name: 'alias' }]);
  am.restoreAccountCacheHours({
    u1: { '2026-11-20T12': { in: 3, cr: 0, cc: 0, out: 0 } },
    alias: { '2026-11-20T12': { in: 5, cr: 0, cc: 0, out: 0 } },
  }, now);
  am.accrueCapacity(0, { input: 1 }, now);
  am.accrueCapacity(1, { cacheRead: 30 }, now);
  assert.equal(am.accountCacheWindows(am.accounts[0], now).windows.all.input, 9);
  assert.equal(am.accountCacheWindows(am.accounts[1], now).windows.all.hit, 1);
  assert.equal(am.providerCacheWindows(now).codex.windows.all.hit, 30 / 39);
});

test('OAuth org discovery keeps previous observed tokens after restart and a second organization cannot acquire them', () => {
  const am = new AccountManager([account('holder')]);
  am.accrueCapacity(0, { input: 9 }, now);
  am.accounts[0].organizationUuid = 'first';
  assert.equal(am.accountCacheWindows(am.accounts[0], now).windows.all.input, 9);
  am.accrueCapacity(0, { input: 2 }, now);
  am.addAccount({ ...account('other'), accountUuid: 'holder', organizationUuid: 'second' });
  am.accrueCapacity(1, { input: 30 }, now);
  const resumed = new AccountManager(am.accounts);
  resumed.restoreCapacityState(am.capacity.serialize());
  assert.equal(resumed.accountCacheWindows(resumed.accounts[0], now).windows.all.input, 11);
  assert.equal(resumed.accountCacheWindows(resumed.accounts[1], now).windows.all.input, 30);
  assert.equal(resumed.providerCacheWindows(now).claude.windows.all.input, 41);
});

test('previously unassigned user-only history is retained in provider totals when two organizations already exist', () => {
  const old = new AccountManager([account('holder')]);
  old.accrueCapacity(0, { input: 9 }, now);
  const rows = ['first', 'second'].map(organizationUuid => ({ ...account('holder'), organizationUuid }));
  const resumed = new AccountManager(rows);
  resumed.restoreCapacityState(old.capacity.serialize());
  resumed.accrueCapacity(0, { input: 2 }, now);
  resumed.accrueCapacity(1, { input: 30 }, now);
  assert.equal(resumed.accountCacheWindows(resumed.accounts[0], now).windows.all.input, 2);
  assert.equal(resumed.accountCacheWindows(resumed.accounts[1], now).windows.all.input, 30);
  assert.equal(resumed.providerCacheWindows(now).claude.windows.all.input, 41);
});
