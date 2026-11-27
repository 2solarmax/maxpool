// Early claim of a banked Codex reset (owner, 2026-11-27): a confirmed full credit is
// spent while the account still has room, not only after it is exhausted. These tests pin
// the rule's inputs (cap, load, free refill, spare accounts, confirmed rows), its
// default-on enrolment and the sanitized expiry the account table shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, normalizeCodexResetExpiry } from '../src/account-manager.js';
import {
  HOLD_CAPACITY_RETURNS, HOLD_POOL_HAS_ROOM, POLICY,
  codexAutoResetOn, decideCodexWithReason, earlyClaimVerdict, sustainedWeeklyBurn,
} from '../src/reset-policy.js';
import { __tuiTest } from '../src/tui.js';

const minute = 60_000;
const hour = 3600_000;
const now = 1_800_000_000_000;
const WEEK_MS = 7 * 24 * hour;

const credit = (extra = {}) => ({ id: 'credit-a', status: 'available', supportedByPlan: true,
  expiresAt: now + 90 * hour, ...extra });
const owner = quota => ({ name: 'owner', provider: 'codex', codexAuth: 'native', index: 0,
  quota: { unified7d: 0.5, unified7dReset: now + 5 * hour, codexWeeklyReadingAt: now, lastProbeOkAt: now, ...quota } });
const early = (extra = {}) => ({ early: { weeklyCap: null, peerReturnAt: null, ...extra } });
const decide = (account, credits, opts = {}) => decideCodexWithReason(account, credits, now, { listingCheckedAt: now, ...opts });
const spare = count => ({ peersWithRoom: () => count, holdersInPool: () => 1 });

test('a confirmed credit is spent before the account is exhausted, with a margin left', () => {
  const near = owner({ unified7d: 0.97 });
  const result = decide(near, [credit()], early());
  assert.equal(result.action.reason, 'weekly nearing limit');
  assert.equal(result.action.grant.id, 'credit-a');
  // Far from the ceiling there is nothing to recover yet.
  assert.equal(decide(owner({ unified7d: 0.5 }), [credit()], early()).action, null);
  // Without the early inputs the decision is the old one: wait for the wall.
  assert.equal(decide(near, [credit()]).action, null);
  assert.equal(decide(owner({ unified7d: 0.99 }), [credit()], early()).action.reason, 'weekly at wall');
});

test('the usage cap is the ceiling the margin is measured to', () => {
  const capped = early({ weeklyCap: 0.7 });
  assert.equal(decide(owner({ unified7d: 0.68 }), [credit()], capped).action.reason, 'weekly nearing limit');
  assert.equal(decide(owner({ unified7d: 0.68 }), [credit()], early()).action, null,
    'the same reading without a cap is nowhere near its ceiling');
  assert.equal(decide(owner({ unified7d: 0.6 }), [credit()], capped).action, null, 'room left to the cap is not exhaustion');
  // A cap above the wall never moves the ceiling past the wall.
  assert.equal(decide(owner({ unified7d: 0.97 }), [credit()], early({ weeklyCap: 1 })).action.reason, 'weekly nearing limit');
});

test('only fresh, confirmed credit rows start an early claim', () => {
  const near = owner({ unified7d: 0.97 });
  assert.equal(decide(near, [credit()], { ...early(), listingCheckedAt: now - 6 * minute }).action, null,
    'rows older than a claim may rely on cannot start one');
  assert.equal(decide(near, [credit()], { ...early(), listingCheckedAt: now - 5 * minute }).action?.reason, 'weekly nearing limit');
  assert.equal(decide(near, [credit()], { ...early(), listingCheckedAt: undefined }).action, null);
  // The upstream count is not a credit: no rows, no claim.
  assert.equal(decide(near, [], early()).reason, 'no grant held');
  assert.equal(decide(near, [credit({ supportedByPlan: false }), credit({ id: 'b', expiresAt: now - 1 }),
    credit({ id: 'c', status: 'redeemed' })], early()).action, null);
});

test('the reset fires a fixed margin (3%) before the ceiling, never at exhaustion', () => {
  assert.equal(POLICY.earlyMargin, 0.03);
  const at = used => decide(owner({ unified7d: used, unified7dReset: now + 3 * 24 * hour }), [credit()], early());
  assert.equal(at(0.95).action, null, '4% of room left to the 0.99 wall');
  assert.equal(at(0.96).action.reason, 'weekly nearing limit', '3% left: spend now');
  assert.equal(at(0.975).action.reason, 'weekly nearing limit');
});

test('a burst never spends a reset: the wait test reads the week\'s average pace, not the last minutes', () => {
  // 97% used with 3 days left is an average of ~1%/h; 2% of room then outlasts a 30-minute
  // wait for a compatible account with 1% to spare. A burst in the last minutes does not
  // enter the decision: only the week's average pace does.
  const pace = sustainedWeeklyBurn(0.97, now + 3 * 24 * hour, now) * hour;
  assert.ok(Math.abs(pace - 0.97 / 96) < 1e-9, `average pace ${pace}`);
  const v = earlyClaimVerdict({ util: 0.97, ceiling: 0.99, refillAt: now + 3 * 24 * hour, returnAt: now + 30 * minute, now });
  assert.equal(v.kind, 'hold');
  assert.equal(v.reason, HOLD_CAPACITY_RETURNS);
  // The first hour of a window has no readable pace: never a reason to wait.
  assert.equal(earlyClaimVerdict({ util: 0.98, ceiling: 0.99, refillAt: now + WEEK_MS - 30 * minute, returnAt: now + 10 * minute, now }).kind, 'due');
});

test('"soon" means a few hours: a compatible account freeing up within 3h is waited for while room lasts', () => {
  assert.equal(POLICY.soonReturnMs, 3 * hour, 'owner: "I will define soon within a few hours"');
  const near = owner({ unified7d: 0.975, unified7dReset: now + 40 * hour });   // 1.5% left; pace ~0.76%/h
  const held = decide(near, [credit()], early({ peerReturnAt: now + 30 * minute }));
  assert.equal(held.action, null);
  assert.equal(held.reason, HOLD_CAPACITY_RETURNS);
  // Beyond "soon" a reset is worth more than the wait.
  assert.equal(decide(near, [credit()], early({ peerReturnAt: now + 4 * hour })).action.reason, 'weekly nearing limit');
  // Help just past 3h is not waited for even when the room would last that long: an
  // account held at a 50% cap, 48% used with 8h of its week left (pace 0.3%/h), has 2%
  // of room that outlasts a 3h12m wait with 1% to spare — and still spends.
  const slow = owner({ unified7d: 0.48, unified7dReset: now + 8 * hour });
  assert.equal(decide(slow, [credit()], early({ weeklyCap: 0.5, peerReturnAt: now + 192 * minute })).action.reason,
    'weekly nearing limit', '3h12m is past "a few hours"');
  assert.equal(decide(slow, [credit()], early({ weeklyCap: 0.5, peerReturnAt: now + 170 * minute })).reason,
    HOLD_CAPACITY_RETURNS, '2h50m is within it');
  // A peer refill no sooner than the account's own changes nothing.
  assert.equal(decide(near, [credit()], early({ peerReturnAt: now + 41 * hour })).action.reason, 'weekly nearing limit');
});

test('room that runs out before help arrives is spent now', () => {
  // 1.5% left at ~0.76%/h: help in 90 min would leave under the 1% that must remain.
  const tight = owner({ unified7d: 0.975, unified7dReset: now + 40 * hour });
  assert.equal(decide(tight, [credit()], early({ peerReturnAt: now + 90 * minute })).action.reason, 'weekly nearing limit');
  // The same account with help in 30 minutes waits.
  assert.equal(decide(tight, [credit()], early({ peerReturnAt: now + 30 * minute })).reason, HOLD_CAPACITY_RETURNS);
  // With almost nothing left, even help in 20 minutes is too late.
  assert.equal(decide(owner({ unified7d: 0.985, unified7dReset: now + 40 * hour }), [credit()],
    early({ peerReturnAt: now + 20 * minute })).action.reason, 'weekly nearing limit');
});

test('a capped account: the confirmed credit lifts the cap, and the margin is measured to the lifted ceiling', () => {
  // Before the lift the account is held at 75%; with a confirmed credit the pool may run it to the wall.
  assert.equal(decide(owner({ unified7d: 0.745 }), [credit()], early()).action, null, 'nothing near the wall yet');
  const capped = owner({ unified7d: 0.745, unified7dReset: now + 60 * hour });
  assert.equal(decide(capped, [credit()], early({ weeklyCap: 0.75 })).action.reason, 'weekly nearing limit',
    'the cap still binding (rows not confirmed) spends to keep the reservation');
});

test('the early hold still needs other accounts with room, and is counted in the pool budget before the wall', () => {
  const near = owner({ unified7d: 0.975, unified7dReset: now + 40 * hour });
  const held = decide(near, [credit()], { ...early(), ...spare(2) });
  assert.equal(held.action, null);
  assert.equal(held.reason, HOLD_POOL_HAS_ROOM);
  assert.equal(held.heldScope, 'general');
  assert.equal(held.heldEarly, true);
  assert.equal(decide(near, [credit()], { ...early(), ...spare(1) }).action.reason, 'weekly nearing limit',
    'one roomy peer is not enough cover');
  assert.equal(decide(near, [credit({ expiresAt: now + 5 * hour + 2 * hour })], { ...early(), ...spare(5) }).action.reason,
    'dying value', 'a credit that dies first is spent, spare accounts or not');
  const wall = decide(owner({ unified7d: 0.995, unified7dReset: now + 5 * hour }), [credit()], { ...early(), ...spare(2) });
  assert.equal(wall.heldEarly, false, 'a wall hold is not an early one');
});

test('a dying credit is spent even when the free refill is minutes away', () => {
  const account = owner({ unified7d: 0.97, unified7dReset: now + 6 * minute });
  assert.equal(decide(account, [credit({ expiresAt: now + 2 * hour })], early()).action.reason, 'dying value');
});

test('earlyClaimVerdict decides nothing without a usable reading or a future refill', () => {
  const base = { util: 0.97, ceiling: 0.99, refillAt: now + 6 * 24 * hour, returnAt: now + 6 * 24 * hour, now };
  assert.deepEqual(earlyClaimVerdict({ ...base, util: null }), { kind: 'none' });
  assert.deepEqual(earlyClaimVerdict({ ...base, ceiling: undefined }), { kind: 'none' });
  assert.deepEqual(earlyClaimVerdict({ ...base, refillAt: now }), { kind: 'none' });
  assert.deepEqual(earlyClaimVerdict(base), { kind: 'due' });
});

test('automatic resets are on unless the owner turned them off, and never for accounts the pool cannot use', () => {
  const native = extra => ({ provider: 'codex', codexAuth: 'native', ...extra });
  assert.equal(codexAutoResetOn(native()), true, 'unset = on');
  assert.equal(codexAutoResetOn(native({ autoRedeemReset: null })), true);
  assert.equal(codexAutoResetOn(native({ autoRedeemReset: true })), true);
  assert.equal(codexAutoResetOn(native({ autoRedeemReset: false })), false, 'an explicit off wins');
  assert.equal(codexAutoResetOn(native({ enabled: false })), false);
  assert.equal(codexAutoResetOn(native({ poolBenchedBy: 'cloud' })), false);
  assert.equal(codexAutoResetOn(native({ remote: { linkName: 'team' } })), false);
  assert.equal(codexAutoResetOn(native({ refreshDead: true })), false);
  assert.equal(codexAutoResetOn(native({ subscriptionGone: true })), false);
  assert.equal(codexAutoResetOn({ provider: 'codex', autoRedeemReset: true }), false, 'only a native login can spend a credit');
  assert.equal(codexAutoResetOn({ provider: 'zai', codexAuth: 'native' }), false);
  assert.equal(codexAutoResetOn(null), false);
});

const config = name => ({ name, type: 'oauth', provider: 'codex', codexAuth: 'native',
  codexAccountId: 'workspace-' + name, accountUuid: 'user-' + name, accessToken: 'fixture-' + name,
  codexModels: [{ slug: 'gpt-6.2-sol', efforts: ['high'] }] });
const manager = () => new AccountManager([config('one'), config('two'), config('three')], 0.98, { routingMode: 'balance' });

test('the early inputs carry the live cap and the soonest compatible refill, and only for Codex', () => {
  const am = manager();
  const [account, peer, other] = am.accounts;
  const t = Date.now();
  assert.deepEqual(am.codexResetEarlyInputs(account, t), { weeklyCap: null, peerReturnAt: null });
  account.capUtilization = 0.7;
  assert.equal(am.codexResetEarlyInputs(account, t).weeklyCap, 0.7);
  account.capUtilization = 0.5;
  assert.equal(am.codexResetEarlyInputs(account, t).weeklyCap, 0.5, 'read live: a changed cap applies to the next decision');
  // A compatible peer with a current reading names its refill; the soonest wins.
  for (const [p, inH] of [[peer, 2], [other, 5]]) { p.quota.codexWeeklyReadingAt = t; p.quota.unified7dReset = t + inH * hour; }
  assert.equal(am.codexResetEarlyInputs(account, t).peerReturnAt, t + 2 * hour);
  // A stale reading, a disabled account or one missing a model this account serves never counts.
  peer.quota.codexWeeklyReadingAt = t - 20 * minute;
  assert.equal(am.codexSoonestPeerReturn(account, t), t + 5 * hour, 'stale reading ignored');
  other.enabled = false;
  assert.equal(am.codexSoonestPeerReturn(account, t), null);
  other.enabled = true;
  other.codexModels = [{ slug: 'some-other-model', efforts: ['high'] }];
  if (other.quota) other.quota.codexModels = other.codexModels;
  assert.equal(am.codexSoonestPeerReturn(account, t), null, 'a peer that cannot serve this account\'s models is not capacity');
  other.codexModels = [{ slug: 'gpt-6.2-sol', efforts: ['high'] }];
  if (other.quota) other.quota.codexModels = other.codexModels;
  peer.quota.codexWeeklyReadingAt = t;
  assert.equal(am.codexSoonestPeerReturn(account, t), t + 2 * hour, 'control: a healthy peer counts');
  peer.status = 'throttled';
  assert.equal(am.codexSoonestPeerReturn(account, t), t + 5 * hour, 'a throttled peer is skipped; the healthy one remains');
  other.status = 'throttled';
  assert.equal(am.codexSoonestPeerReturn(account, t), null, 'no healthy peer: nothing is returning soon');
  peer.status = 'active'; other.status = 'active';
  peer.cooldownUntil = t + 5 * minute; other.cooldownUntil = t + 5 * minute;
  assert.equal(am.codexSoonestPeerReturn(account, t), null, 'nor peers cooling down');
  peer.cooldownUntil = null; other.cooldownUntil = null;
  assert.equal(am.codexSoonestPeerReturn(account, t), t + 2 * hour, 'control: recovered peers count again');
  assert.equal(am.codexResetEarlyInputs({ provider: 'anthropic' }, t), null);
});

test('a confirmed, spendable credit lifts the cap; no rows, automatic resets off or a redeem backoff do not', () => {
  const am = manager();
  const account = am.accounts[0];
  const t = Date.now();
  account.capUtilization = 0.75;
  account.capMode = 'fixed';
  account.quota.unified7d = 0.8;
  account.quota.unified7dReset = t + 4 * 24 * hour;
  let rows = null;
  am.codexResetLiftRows = () => rows;
  am.refreshCapLift(0, t);
  assert.equal(am.capLiftActive(account, t), false, 'no confirmed credit: the cap holds');
  assert.equal(am._effectiveCap(account, 'wk', t), 0.75);
  rows = [{ id: 'c', status: 'available', supportedByPlan: true, expiresAt: t + 20 * 24 * hour }];
  am.refreshCapLift(0, t);
  assert.equal(am.capLiftActive(account, t), true, 'a confirmed credit lifts the cap');
  assert.equal(am._effectiveCap(account, 'wk', t), null);
  account.autoRedeemReset = false;
  am.refreshCapLift(0, t);
  assert.equal(am.capLiftActive(account, t), false, 'with automatic resets off nobody spends it, so the reservation stays');
  account.autoRedeemReset = undefined;
  account.quota.unified7dReset = t + 10 * hour;
  am.refreshCapLift(0, t);
  assert.equal(am.capLiftActive(account, t), false, 'within a day of the free refill the cap returns (as for Claude and z.ai)');
});

test('an early hold is counted in the pool budget before the account reaches the wall', () => {
  const am = manager();
  const [holder, other] = am.accounts;
  holder.quota.unified7d = 0.97;
  holder.quota.unified7dReset = Date.now() + 5 * hour;
  am.noteWallHold(holder, Date.now());
  assert.equal(am.isHoldingWall(holder), false, 'a wall hold needs the wall');
  am.noteWallHold(holder, Date.now(), { early: true });
  assert.equal(am.isHoldingWall(holder), true);
  assert.equal(am.countHoldingWalls(other, Date.now()), 2, 'the other account budgets for the early hold too');
  holder.lastFullGeneralClaimAt = Date.now() + 1;
  assert.equal(am.isHoldingWall(holder), false, 'a claim retires it');
});

test('status reports the effective automatic-reset setting and a sanitized expiry, and a cloud row keeps only that', () => {
  const t = Math.floor(Date.now() / 1000) * 1000;
  const source = manager();
  source.codexResetExpiry = () => ({ checkedAt: t, count: 2, earliestExpiresAt: t + 4 * hour,
    id: 'credit-secret', title: 'private title' });
  const rows = () => source.getStatus().accounts;
  assert.equal(rows()[0].autoRedeemReset, true, 'unset is on');
  source.accounts[0].autoRedeemReset = false;
  assert.equal(rows()[0].autoRedeemReset, false);
  source.accounts[1].enabled = false;
  assert.equal(rows()[1].autoRedeemReset, false, 'a disabled owner is off whatever the setting says');

  const edge = new AccountManager([]);
  edge.syncRemoteMirrors({ name: 'test', url: 'http://example.invalid', lastOkAt: t, status: source.getStatus() });
  const mirror = edge.accounts[0];
  assert.deepEqual(mirror.remoteCodexResetExpiry, { checkedAt: t, count: 2, earliestExpiresAt: t + 4 * hour },
    'nothing but counts and times crosses from the cloud');
  assert.equal(JSON.stringify(mirror.remoteCodexResetExpiry).includes('secret'), false);
  assert.deepEqual(edge.codexResetExpiryFor(mirror, t), mirror.remoteCodexResetExpiry);
  assert.equal(edge.codexResetExpiryFor(mirror, t + 20 * minute), null, 'an old cloud reading is unknown, not current');
  assert.equal(edge.getStatus().accounts[0].codexResetExpiry, null, 'a mirror does not re-export the cloud\'s rows');

  assert.equal(normalizeCodexResetExpiry({ checkedAt: t, count: 1, earliestExpiresAt: null }).earliestExpiresAt, null);
  for (const bad of [null, 'x', {}, { checkedAt: 'x', count: 1 }, { checkedAt: t, count: -1 },
    { checkedAt: t, count: 1.5 }, { checkedAt: t, count: 1, earliestExpiresAt: 'soon' }]) {
    assert.equal(normalizeCodexResetExpiry(bad), null);
  }
});

test('the account table says when a reset expires, and unknown never looks like non-expiring', () => {
  const { codexResetCells, codexExpirySuffix, strip } = __tuiTest;
  const t = Date.now();
  const account = { provider: 'codex', quota: { codexResetCredits: { available: 2, checkedAt: t } } };
  const cell = expiry => strip(codexResetCells(account, t, expiry)).slice(-7).trimEnd();
  assert.equal(cell(null), '2', 'unknown: the count alone');
  assert.equal(cell({ checkedAt: t, count: 2, earliestExpiresAt: t + 11 * hour + minute }), '2~11h');
  assert.equal(cell({ checkedAt: t, count: 2, earliestExpiresAt: t + 3 * 86400_000 + hour }), '2~3d');
  assert.equal(cell({ checkedAt: t, count: 2, earliestExpiresAt: null }), '2~never', 'confirmed non-expiring');
  assert.equal(cell({ checkedAt: t, count: 0, earliestExpiresAt: null }), '2', 'rows that show nothing redeemable say nothing');
  assert.equal(cell({ checkedAt: t, count: 2, earliestExpiresAt: t - 1 }), '2', 'an expiry already passed is not shown');
  assert.equal(codexExpirySuffix({ checkedAt: t, count: 1, earliestExpiresAt: t + 40 * minute }, t), '~1h');
  const none = { provider: 'codex', quota: { codexResetCredits: { available: 0, checkedAt: t } } };
  assert.equal(strip(codexResetCells(none, t, { checkedAt: t, count: 1, earliestExpiresAt: null })).slice(-7).trimEnd(), '0');
  const stale = { provider: 'codex', quota: { codexResetCredits: { available: 2, checkedAt: t - hour } } };
  assert.equal(strip(codexResetCells(stale, t, { checkedAt: t, count: 2, earliestExpiresAt: t + 5 * hour })).slice(-7).trimEnd(), '2~5h?');
  const cloud = { provider: 'codex', remote: { linkName: 'team' }, quota: { codexResetCredits: { available: 1, checkedAt: t } } };
  assert.equal(strip(codexResetCells(cloud, t, { checkedAt: t, count: 1, earliestExpiresAt: t + 2 * 86400_000 + hour })).slice(-7).trimEnd(), '1~2d');
});

// ── Through the REAL wiring: account manager + redeemer + real selection ───────────
// (review 2026-11-27: the early hold and the cap lift were only ever exercised with a
// stubbed manager, so a green suite did not show they work end to end.)
const { ResetCreditRedeemer } = await import('../src/codex-reset-credits.js');

function realPool({ holder = 0.5, peers = [0.2, 0.2] } = {}) {
  const am = manager();
  const t = Date.now();
  const resetAt = t + 40 * hour;
  [holder, ...peers].forEach((used, i) => am.applyCodexUsageData(i, { sevenDay: { utilization: used, resetAt } }, { sentAt: t }));
  const consumed = [];
  const redeemer = new ResetCreditRedeemer(am, {
    detailsFn: async () => ({ credits: [{ id: 'credit-a', status: 'available', supportedByPlan: true, expiresAt: t + 90 * hour }] }),
    consumeFn: async (_account, attempt) => { consumed.push(attempt.creditId); return { code: 'reset', windowsReset: 1 }; },
    usageFn: async () => ({ sevenDay: { utilization: 0.05, resetAt } }),
    log() {},
  });
  am.codexResetEarlyInputs = (account, now) => ({
    weeklyCap: am._effectiveCap(account, 'wk', now),
    peerReturnAt: am.codexSoonestPeerReturn(account, now),
  });
  am.codexResetLiftRows = (account, now) => redeemer.liftRows(account, now);
  am.codexResetSpendableExpiry = (account, now) => redeemer.spendableExpiry(account, now);
  return { am, t, consumed, redeemer };
}

test('REAL WIRING: an early claim is held while two real peers have room, and spent on the sweep after one loses it', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.975 });
  const holder = am.accounts[0];
  const run = () => redeemer.maybeRedeemForPool([holder]);
  const held = await run();
  assert.equal(held.redeemed, false);
  assert.equal(held.reason, HOLD_POOL_HAS_ROOM, 'two real peers with 35% weekly headroom carry the load');
  assert.deepEqual(consumed, []);
  assert.equal(am.isHoldingWall(holder, t), true, 'the early hold is registered on the real account');
  assert.equal(am.countHoldingWalls(am.accounts[1], t), 2, 'and budgeted by the real peer (itself plus the early holder)');
  // One peer fills up: room is gone, the very next sweep spends.
  am.applyCodexUsageData(2, { sevenDay: { utilization: 0.95, resetAt: t + 40 * hour } }, { sentAt: t + 60_000 });
  const spent = await run();
  assert.equal(spent.redeemed, true, spent.reason);
  assert.deepEqual(consumed, ['credit-a']);
});

test('REAL WIRING: the confirmed credit lifts the cap through the redeemer read, and the early claim is measured to it', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.70 });
  const holder = am.accounts[0];
  holder.capUtilization = 0.75;
  holder.capMode = 'fixed';
  assert.equal(am.capLiftActive(holder, t), false, 'no rows read yet: the cap holds');
  await redeemer.readDetails(holder);
  assert.equal(am.capLiftActive(holder, Date.now()), true, 'a real credit read lifts the cap');
  assert.equal(am._effectiveCap(holder, 'wk', Date.now()), null);
  // With the cap lifted the account is nowhere near its ceiling: nothing to spend.
  assert.equal((await redeemer.maybeRedeemForPool([holder])).redeemed, false);
  assert.deepEqual(consumed, []);
});

test('REAL SCORING: a soon-expiring spendable credit makes the pool fill its account; a distant one changes nothing', async () => {
  const { am, t } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  const req = { profile: 'all', codexCompatible: true, model: 'gpt-6.2-sol', weight: 1 };
  const scores = () => Object.fromEntries(am.accounts.map(a => [a.name, am._scoreAccount(a, req)]));
  // CONTROL: no spendable credit known — the fuller account is the dearest of the three.
  const base = scores();
  assert.ok(base.one > base.two, `baseline ${JSON.stringify(base)}`);
  // A credit far from expiring is not worth filling the account for: unchanged.
  am.codexResetSpendableExpiry = () => t + 60 * 24 * hour;
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), false);
  assert.deepEqual(scores(), base, 'a distant credit does not steer');
  // One expiring in 3 days: the weekly cost is dropped and the account ties with the
  // emptiest siblings, so the real selection gives it a full share instead of starving it.
  am.codexResetSpendableExpiry = () => t + 3 * 24 * hour;
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), true);
  const steered = scores();
  assert.ok(steered.one < base.one && steered.one <= steered.two, `steered ${JSON.stringify(steered)}`);
  // Each weekly term is dropped on its own: the pace term (_accountScarcity) and the raw
  // weekly utilization inside the score terms.
  assert.equal(am._accountScarcity(holder, Date.now()), 0, 'the weekly pace term no longer prices this account');
  const ctx = am._scoringContext();
  const termsOn = am._scoreTerms(holder, req, ctx);
  am.codexResetSpendableExpiry = () => t + 60 * 24 * hour;
  const termsOff = am._scoreTerms(holder, req, ctx);
  assert.equal(termsOn.utilizationCost < termsOff.utilizationCost, true,
    `raw weekly utilization no longer prices it (${termsOn.utilizationCost} vs ${termsOff.utilizationCost})`);
  am.codexResetSpendableExpiry = () => t + 3 * 24 * hour;
  const picks = [];
  for (let i = 0; i < 9; i++) {
    const lease = am.acquireAccount({ ...req });
    assert.ok(lease, 'the pool routes');
    picks.push(lease.account.name);
    am.releaseAccount(lease.account, { ...req });
  }
  assert.equal(picks.filter(n => n === 'one').length, 3, `an equal share: ${picks.join(',')}`);
  // At or past the spend point the early claim takes over: nothing left to fill for.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.97, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), false, '3% of room left is the early claim\'s to spend');
});

test('REAL WIRING, full sequence: steering fills the account, the credit is kept while others have room, then spent before it expires', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  const expiring = { id: 'credit-soon', status: 'available', supportedByPlan: true, expiresAt: t + 3 * 24 * hour };
  redeemer.detailsFn = async () => ({ credits: [expiring] });
  await redeemer.readDetails(holder);
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), true, 'the pool fills this account first');
  // Steering has done its work: the account is now near its ceiling.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.975, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  // 1. Two real peers have room: the credit is kept, on a full account.
  const kept = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(kept.redeemed, false);
  assert.equal(kept.reason, HOLD_POOL_HAS_ROOM);
  assert.deepEqual(consumed, []);
  // 2. A peer fills up: room is gone, the very next sweep spends.
  am.applyCodexUsageData(2, { sevenDay: { utilization: 0.95, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  const spent = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(spent.redeemed, true, spent.reason);
  assert.deepEqual(consumed, ['credit-soon']);
});

test('REAL WIRING: a credit close to expiry is spent on the full account it was steered onto, spare accounts or not', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  const expiring = { id: 'credit-soon', status: 'available', supportedByPlan: true, expiresAt: t + 20 * hour };
  redeemer.detailsFn = async () => ({ credits: [expiring] });
  await redeemer.readDetails(holder);
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.80, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  // The account's own refill is 40h away: the credit dies first, so it is not held for it.
  const result = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(result.redeemed, true, result.reason);
  assert.equal(result.reason, 'dying value');
  assert.deepEqual(consumed, ['credit-soon']);
});
