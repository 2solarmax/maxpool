// TEST PLAN 5, 6, 28, 29 (success criteria 4, 1, 2, 10, 8): cloud mirrors display
// their resets (old-cloud rows without `eligible` too), the benched-twin overlay
// keeps the count through a failed link poll, mirrors honour the exported capLift,
// and disabled accounts export null resets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, normalizeRemoteResets } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';
import { PoolLink } from '../src/pool-link.js';

const DAY = 86400_000;
const strip = __tuiTest.strip;

function cloudAm() {
  return new AccountManager([{ name: 'reports@gomokka.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
}
function macAm() {
  return new AccountManager([{ name: 'local', type: 'apikey', apiKey: 'k' }], 0.9);
}
const GOOD = () => ({ grants: [
  { id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1, endsAt: Date.now() + 119 * DAY,
    clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null },
], nextGrantId: 'g1', cooldownUntil: null, eligible: true });

function linkWith(row) {
  const link = new PoolLink({ name: 'team', url: 'http://127.0.0.1:1', key: 'mp-x' });
  link.lastError = null; link.lastOkAt = Date.now(); link.status = { accounts: [row] };
  return link;
}

// ── TEST 5: an old cloud's row (no `eligible`) still displays its count ──────
test('SC4: an old-cloud mirror row (grants present, no eligible) shows the count', () => {
  const cloud = cloudAm();
  cloud.applyResetGrants(0, GOOD());
  const row = cloud.getStatus().accounts[0];
  // Simulate an OLD cloud: strip the new fields the old export never carried.
  const oldRow = { ...row, resetGrants: { grants: row.resetGrants.grants, cooldownUntil: null, checkedAt: row.resetGrants.checkedAt } };
  assert.equal(oldRow.resetGrants.eligible, undefined, 'fixture: no eligible key');
  const mac = macAm();
  mac.syncRemoteMirrors(linkWith(oldRow));
  const mirror = mac.accounts.find(a => a.remote);
  assert.ok(mirror, 'mirror row exists');
  assert.equal(mirror.resetGrants.eligible, true, 'missing eligible defaults from grants.length>0');
  const tui = new TUI({ accountManager: mac });
  const line = strip(tui._renderAcct(mirror.index, 11, true));
  assert.match(line, /1~119d/, 'the mirror row SHOWS the count (RED on 276f7d0)');
});

test('normalizeRemoteResets: eligible absent → grants.length>0; present false stays false', () => {
  const rr = normalizeRemoteResets({ resetGrants: { grants: [{ id: 'g' }], checkedAt: 1 } });
  assert.equal(rr.resetGrants.eligible, true);
  const rr2 = normalizeRemoteResets({ resetGrants: { grants: [{ id: 'g' }], eligible: false, checkedAt: 1 } });
  assert.equal(rr2.resetGrants.eligible, false);
  const rr3 = normalizeRemoteResets({ resetGrants: { grants: [], checkedAt: 1 } });
  assert.equal(rr3.resetGrants.eligible, false, 'no grants + no eligible → not eligible');
});

// ── TEST 6: the benched twin keeps the count through a failed link poll ───────
test('SC2: overlay keeps the twin resets when one link status omits them (marked ?)', () => {
  const cloud = cloudAm();
  cloud.applyResetGrants(0, GOOD());
  const row = cloud.getStatus().accounts[0];

  // A LOCAL row benched by the duplicate guard with a cloud twin.
  const mac = new AccountManager([{ name: 'reports@gomokka.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  mac.accounts[0].poolBenchedBy = 'reports@gomokka.com';
  const linkOk = linkWith(row);
  mac.poolLinks = [linkOk];
  const tui = new TUI({ accountManager: mac });
  const frame1 = strip(tui._renderAcct(0, 11, true));
  assert.match(frame1, /1~119d/, 'frame 1 (link healthy) shows the twin count');

  // Frame 2: the link's status arrives WITHOUT reset fields (a failed poll).
  const linkStale = linkWith({ name: 'reports@gomokka.com', type: 'oauth', quota: {} });
  linkStale.status.accounts[0] = { ...row, resetGrants: undefined, resetCards: undefined, capLift: undefined };
  mac.poolLinks = [linkStale];
  const tui2 = new TUI({ accountManager: mac });
  const frame2 = strip(tui2._renderAcct(0, 11, true));
  assert.match(frame2, /1\?/, 'frame 2 KEEPS the count with ? — never 0');
  assert.doesNotMatch(frame2, / 0 /, 'never drops to 0');
});

test('SC2: mirror row and benched twin show the same count', () => {
  const cloud = cloudAm();
  cloud.applyResetGrants(0, { grants: GOOD().grants.concat([{ ...GOOD().grants[0], id: 'g2', clears: ['seven_day_overage_included'] }]), nextGrantId: null, cooldownUntil: null, eligible: true });
  const row = cloud.getStatus().accounts[0];

  const mac = new AccountManager([{ name: 'reports@gomokka.com', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const link = linkWith(row);
  mac.poolLinks = [link];
  mac.syncRemoteMirrors(link);
  mac.accounts[0].poolBenchedBy = 'reports@gomokka.com';
  const mirror = mac.accounts.find(a => a.remote);
  const tui = new TUI({ accountManager: mac });
  const twinLine = strip(tui._renderAcct(0, 11, true));
  const mirrorLine = strip(tui._renderAcct(mirror.index, 11, true));
  const countOf = (l) => (/\d+\+?\d*F?~/.exec(l) || [null])[0];
  assert.equal(countOf(twinLine), countOf(mirrorLine), 'both rows carry the same resets cell');
});

// ── TEST 28: the mirror honours the exported capLift, never recomputes ────────
test('SC10: mirror _weeklyRawState follows the exported capLift; missing = no lift', () => {
  const cloud = cloudAm();
  cloud.accounts[0].capUtilization = 0.75;
  cloud.accounts[0].capMode = 'fixed';
  cloud.accounts[0].quota.unified7d = 0.80;
  cloud.accounts[0].quota.unified7dReset = Date.now() + 3 * DAY;
  cloud.applyResetGrants(0, GOOD());   // seven_day grant → holder lift active
  assert.equal(cloud._weeklyRawState(cloud.accounts[0]), 'normal', 'control: holder is lifted → normal');

  const row = cloud.getStatus().accounts[0];
  assert.equal(row.capLift.active, true, 'the export carries capLift');
  const mac = macAm();
  mac.syncRemoteMirrors(linkWith(row));
  const mirror = mac.accounts.find(a => a.remote);
  mirror.quota.unified7d = 0.80; mirror.quota.unified7dReset = Date.now() + 3 * DAY;
  assert.equal(mac._weeklyRawState(mirror), 'normal', 'the mirror HONOURS the exported lift (no own recompute)');

  // The other way round: cloud exports NO lift (capLift.active false); the mirror
  // must NOT recompute a lift from the listing copy it carries.
  const rowNoLift = { ...row, capLift: { active: false } };
  const mac2 = macAm();
  mac2.syncRemoteMirrors(linkWith(rowNoLift));
  const mirror2 = mac2.accounts.find(a => a.remote);
  mirror2.quota.unified7d = 0.80; mirror2.quota.unified7dReset = Date.now() + 3 * DAY;
  assert.notEqual(mac2._weeklyRawState(mirror2), 'normal', 'missing/false export → the mirror recomputes nothing');
});

// ── TEST 29: disabled accounts export null resets ────────────────────────────
test('SC8: getStatus exports null resets for an enabled===false account', () => {
  const am = cloudAm();
  am.applyResetGrants(0, GOOD());
  am.applyResetCards(0, { fiveHour: [], weekly: [{ recordId: 9, expiresAt: Date.now() + 2 * DAY, expired: false }] });
  am.accounts[0].enabled = false;
  const row = am.getStatus().accounts[0];
  assert.equal(row.resetGrants, null, 'API reports no grants for a disabled account');
  assert.equal(row.resetCards, null, 'API reports no cards for a disabled account');
  // An enabled sibling still reports.
  const on = cloudAm();
  on.applyResetGrants(0, GOOD());
  assert.ok(on.getStatus().accounts[0].resetGrants);
});
