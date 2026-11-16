// R7 reset-hold: "how many OTHER accounts in this pool have room?" Owner, 2026-11-15:
// "how does this make any sense … I have plenty of accounts in the cloud" — the count
// skipped every cloud MIRROR row, so a laptop whose own rows were at their caps
// concluded "no room" and spent reset credits the cloud's spare accounts made
// unnecessary. A fresh, roomy mirror is a peer; a stale/unknown/exhausted one is not.
//
// Mirrors are built through the REAL syncRemoteMirrors from a cloud-status fixture, so
// the freshness field is whatever actually arrives (quota.lastProbeOkAt, the cloud's
// own probe stamp, copied with the rest of the exported quota).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const DAY = 86400_000;
const H = 3600_000;

function localPool(now) {
  const am = new AccountManager([
    { name: 'self', type: 'oauth', accessToken: 't0', refreshToken: 'r0', expiresAt: now + 3600_000 },
  ], 0.9);
  const self = am.accounts[0];
  self.accountUuid = 'u-self';
  self.quota.unified7d = 0.995; self.quota.unified7dReset = now + 18 * H;
  self.quota.unified5h = 0.2; self.quota.lastProbeOkAt = now;
  return am;
}

function cloudRow(name, uuid, now, over = {}) {
  return {
    name, type: 'oauth', provider: 'anthropic', enabled: true, status: 'active',
    accountUuid: uuid, organizationUuid: null,
    quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.2, unified5hReset: now + 3 * H, lastProbeOkAt: now },
    ...over,
  };
}

function link(rows, now) {
  return { name: 'cloud', url: 'http://cloud.invalid', key: 'k', lastOkAt: now, lastError: null, status: { accounts: rows } };
}

function withMirrors(rows, now, { localExtra } = {}) {
  const am = localPool(now);
  if (localExtra) localExtra(am);
  am.syncRemoteMirrors(link(rows, now));
  return am;
}
const count = (am, now) => am.countPeersWithRoom(am.accounts[0], now);

test('(a) a fresh, roomy cloud mirror is a peer — with ZERO roomy local rows', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now)], now);
  assert.equal(am.accounts.filter(a => a.remote).length, 1, 'precondition: the mirror exists');
  assert.equal(count(am, now), 1);
});

test('(a2) two distinct fresh roomy mirrors count as two', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now), cloudRow('cloud-2', 'u-c2', now)], now);
  assert.equal(count(am, now), 2);
});

test('(b) a benched local copy and its cloud mirror are ONE peer (a mirror twin too)', () => {
  const now = Date.now();
  const am = withMirrors([
    cloudRow('cloud-1', 'u-dup', now),
    cloudRow('cloud-1-orgless-twin', 'u-dup', now, { organizationUuid: 'org-1' }),
  ], now, {
    localExtra: (m) => {
      m.addAccount({ name: 'dup-local', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: now + 3600_000 });
      const d = m.accounts[m.accounts.length - 1];
      d.accountUuid = 'u-dup'; d.poolBenchedBy = 'cloud-1';
      d.quota.unified7d = 0.1; d.quota.unified5h = 0.1; d.quota.unified7dReset = now + 3 * DAY; d.quota.lastProbeOkAt = now;
    },
  });
  assert.equal(count(am, now), 1, 'one identity, however many rows carry it');
});

test('(c) a stale mirror (cloud probe older than the freshness window) is not counted', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now, {
    quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.2, lastProbeOkAt: now - 6 * 60_000 } })], now);
  assert.equal(count(am, now), 0);
});

test('(c2) a mirror whose cloud sent NO freshness stamp is not counted (old cloud = today)', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now, {
    quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.2 } })], now);
  assert.equal(count(am, now), 0);
});

test('(c3) a mirror probed exactly 5 min ago still counts (same boundary as local peers)', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now, {
    quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.2, lastProbeOkAt: now - 5 * 60_000 } })], now);
  assert.equal(count(am, now), 1);
});

test('(d) an exhausted / throttled / errored / cooled-down / too-full mirror is not counted', () => {
  const now = Date.now();
  const cases = {
    'cloud says exhausted': { status: 'exhausted' },
    'cloud says throttled': { status: 'throttled' },
    'cloud says error': { status: 'error' },
    'cloud refresh dead': { refreshDead: true },
    'cloud cooldown ahead': { cooldownUntil: new Date(now + 60_000).toISOString() },
    'weekly 0.655 (room < 0.35)': { quota: { unified7d: 0.655, unified7dReset: now + 3 * DAY, unified5h: 0.2, lastProbeOkAt: now } },
    '5h 0.7 (room to bench < 0.25)': { quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.7, lastProbeOkAt: now } },
    'a model bucket full': { quota: { unified7d: 0.3, unified7dReset: now + 3 * DAY, unified5h: 0.2, lastProbeOkAt: now,
      scopedWeekly: { fable: { utilization: 0.9, isActive: true } } } },
    'cloud usage cap 0.5 at 0.3': { capUtilization: 0.5 },
  };
  for (const [name, over] of Object.entries(cases)) {
    const am = withMirrors([cloudRow('cloud-1', 'u-c1', now, over)], now);
    assert.equal(count(am, now), 0, name);
  }
});

test('(d2) a mirror disabled by a down link (or locally) is not counted', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-1', 'u-c1', now)], now);
  assert.equal(count(am, now), 1, 'control: counts while the link is up');
  am.syncRemoteMirrors({ ...link([], now), lastError: 'down' });
  assert.equal(count(am, now), 0, 'link down → mirror disabled → not counted');
});

test('(e) a benched local copy alone (no mirror yet) still does not count', () => {
  const now = Date.now();
  const am = withMirrors([], now, {
    localExtra: (m) => {
      m.addAccount({ name: 'dup-local', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: now + 3600_000 });
      const d = m.accounts[m.accounts.length - 1];
      d.accountUuid = 'u-dup'; d.poolBenchedBy = 'cloud-1';
      d.quota.unified7d = 0.1; d.quota.unified5h = 0.1; d.quota.unified7dReset = now + 3 * DAY; d.quota.lastProbeOkAt = now;
    },
  });
  assert.equal(count(am, now), 0);
});

// Review 2026-11-16, cluster 6: counting shared cloud mirrors as peers while counting
// only THIS pool's holders let two pools budget the same spare cloud accounts — the
// cloud holding C1 against C2+C3, and the Mac holding its own wall against the same two.
// The cloud now exports which of its rows hold a wall; the Mac counts those holds.
test('(h) a cloud row that is holding its own wall counts as a holder on the Mac', () => {
  const now = Date.now();
  const holding = cloudRow('cloud-held', 'u-ch', now, {
    wallHolding: true,
    quota: { unified7d: 0.995, unified7dReset: now + 10 * H, unified5h: 0.2, lastProbeOkAt: now },
  });
  const am = withMirrors([holding, cloudRow('cloud-2', 'u-c2', now), cloudRow('cloud-3', 'u-c3', now)], now);
  assert.equal(count(am, now), 2, 'the two roomy cloud rows are peers');
  assert.equal(am.countHoldingWalls(am.accounts[0], now), 2,
    'self + the cloud\'s own hold share those peers');
});

test('(h2) an older cloud that exports no wallHolding counts no cloud holders', () => {
  const now = Date.now();
  const am = withMirrors([cloudRow('cloud-2', 'u-c2', now)], now);
  assert.equal(am.countHoldingWalls(am.accounts[0], now), 1);
});

test('(h3) the status export says whether a local row is holding its wall', () => {
  const now = Date.now();
  const am = localPool(now);
  const self = am.accounts[0];
  am.noteWallHold(self, now);
  const row = am.getStatus().accounts.find(r => r.name === 'self');
  assert.equal(row.wallHolding, am.isHoldingWall(self, now));
});
