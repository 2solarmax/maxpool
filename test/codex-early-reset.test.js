// EXACT LIMIT for a banked Codex reset (owner, 2026-11-27, superseding the near-full
// decisions): "It should fire once the limit is reached!" A credit is spent when the
// weekly limit is REACHED — never at a routine 96/99/90%, and never because the
// operator's usage cap binds (a cap is a reservation, not provider exhaustion; a full
// reset LIFTS the cap instead). The ONE spend below the limit is the final precaution for
// a credit that is genuinely dying before the free refill. These tests pin the limit,
// the precaution, the capacity hold, default-on enrolment, and the sanitized expiry the
// account table shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, normalizeCodexResetExpiry } from '../src/account-manager.js';
import { HOLD_POOL_HAS_ROOM, POLICY, CLAUDE_WALL_WEEKLY, codexAutoResetOn, decideCodexWithReason,
  weeklyLimitReached } from '../src/reset-policy.js';
import { __tuiTest } from '../src/tui.js';

const minute = 60_000;
const hour = 3600_000;
const now = 1_800_000_000_000;

const credit = (extra = {}) => ({ id: 'credit-a', status: 'available', supportedByPlan: true,
  expiresAt: now + 90 * hour, ...extra });
const owner = quota => ({ name: 'owner', provider: 'codex', codexAuth: 'native', index: 0,
  quota: { unified7d: 0.5, unified7dReset: now + 5 * hour, codexWeeklyReadingAt: now, lastProbeOkAt: now, ...quota } });
// The removed early claim's inputs are still ACCEPTED by the decision (so no caller has
// to change); these tests pass them to prove they no longer spend anything.
const early = (extra = {}) => ({ early: { weeklyCap: null, peerReturnAt: null, ...extra } });
const decide = (account, credits, opts = {}) => decideCodexWithReason(account, credits, now, { listingCheckedAt: now, ...opts });
const spare = count => ({ peersWithRoom: () => count, holdersInPool: () => 1 });

// ── EXACT LIMIT ────────────────────────────────────────────────────────────────
test('the limit IS the router\'s bench: one constant, so a claim and the bench never disagree', () => {
  assert.equal(POLICY.limitReached, 0.999);
  assert.equal(CLAUDE_WALL_WEEKLY, POLICY.limitReached, 'the claim wall is the limit');
  assert.equal(weeklyLimitReached(0.998), false, 'just under the limit is NOT reached');
  assert.equal(weeklyLimitReached(0.999), true, 'the limit itself');
  assert.equal(weeklyLimitReached(1), true);
  assert.equal(weeklyLimitReached(null), false, 'no reading is no limit');
  assert.equal(weeklyLimitReached(NaN), false);
});

test('a credit is spent when the limit is reached, and NOT before', () => {
  const at = used => decide(owner({ unified7d: used, unified7dReset: now + 3 * 24 * hour }), [credit()], spare(0));
  // Routine near-full readings spend nothing. Each of these used to spend (0.96/0.97 via
  // the early claim; 0.99 was the old wall).
  for (const used of [0.90, 0.95, 0.96, 0.97, 0.975, 0.98, 0.99, 0.995, 0.998]) {
    assert.equal(at(used).action, null, `${used} is below the limit: nothing is spent`);
  }
  assert.equal(at(0.999).action?.reason, 'weekly at wall', 'the limit is reached');
  assert.equal(at(1).action?.reason, 'weekly at wall');
});

test('the removed early claim is inert: passing its inputs spends nothing below the limit', () => {
  const near = owner({ unified7d: 0.97, unified7dReset: now + 3 * 24 * hour });
  // These are the exact shapes that spent a credit on the old rule.
  assert.equal(decide(near, [credit()], early()).action, null, 'early inputs, no spare accounts');
  assert.equal(decide(near, [credit()], { ...early(), ...spare(0) }).action, null);
  assert.equal(decide(near, [credit()], { ...early({ peerReturnAt: now + 30 * minute }) }).action, null);
  assert.equal(decide(near, [credit()], { ...early({ peerReturnAt: now + 4 * hour }) }).action, null);
  // Only confirmed, plan-supported, unexpired rows are a credit at all (unchanged).
  assert.equal(decide(owner({ unified7d: 1 }), [], spare(0)).reason, 'no grant held');
  assert.equal(decide(owner({ unified7d: 1 }), [credit({ supportedByPlan: false }), credit({ id: 'b', expiresAt: now - 1 }),
    credit({ id: 'c', status: 'redeemed' })], spare(0)).action, null);
});

test('an OPERATOR cap is not provider exhaustion: a cap that binds never spends a credit', () => {
  // 70% of a week used, held at a 75% cap. The cap is the owner's reservation; a full
  // credit LIFTS it (see the cap-lift tests) rather than being spent because of it.
  const capped = owner({ unified7d: 0.70, unified7dReset: now + 60 * hour });
  assert.equal(decide(capped, [credit()], early({ weeklyCap: 0.75 })).action, null, 'at its cap, under the limit');
  const atCap = owner({ unified7d: 0.75, unified7dReset: now + 60 * hour });
  assert.equal(decide(atCap, [credit()], early({ weeklyCap: 0.75 })).action, null, 'exactly at the cap is still not the limit');
  const overCap = owner({ unified7d: 0.74, unified7dReset: now + 60 * hour });
  assert.equal(decide(overCap, [credit()], early({ weeklyCap: 0.70 })).action, null, 'past its cap, still under the limit');
  // A cap ABOVE the limit never hides the limit.
  assert.equal(decide(owner({ unified7d: 0.999, unified7dReset: now + 60 * hour }), [credit()],
    early({ weeklyCap: 1 })).action?.reason, 'weekly at wall');
});

test('THE FINAL PRECAUTION: a genuinely dying credit is still spent below the limit', () => {
  // The credit dies in 2h; the free refill is 5h away — waiting loses it. This is the
  // one spend before the limit, and it is kept on purpose (owner, 2026-11-27).
  const account = owner({ unified7d: 0.45, unified7dReset: now + 5 * hour });
  assert.equal(decide(account, [credit({ expiresAt: now + 2 * hour })], spare(5)).action?.reason, 'dying value',
    'spare accounts or not: a dying credit is spent');
  // It still needs the week far enough along that the refill buys real capacity.
  assert.equal(decide(owner({ unified7d: 0.29 }), [credit({ expiresAt: now + 2 * hour })], spare(0)).action, null);
  // It is not "dying" with a day or more to live: then it waits for the limit.
  assert.equal(decide(account, [credit({ expiresAt: now + 24 * hour })], spare(0)).action, null);
  // ...and a dying credit that would OUTLIVE the free refill waits for the free refill.
  const refillSoon = owner({ unified7d: 0.45, unified7dReset: now + 2 * hour });
  assert.equal(decide(refillSoon, [credit({ expiresAt: now + 20 * hour })], spare(0)).action, null, 'free refill <24h away');
});

test('the capacity hold still applies AT the limit: other accounts with room keep the credit', () => {
  const limit = owner({ unified7d: 0.999, unified7dReset: now + 40 * hour });
  const held = decide(limit, [credit()], spare(2));
  assert.equal(held.action, null);
  assert.equal(held.reason, HOLD_POOL_HAS_ROOM);
  assert.equal(held.heldScope, 'general');
  assert.equal(held.heldEarly, undefined, 'there is no early hold any more');
  assert.equal(decide(limit, [credit()], spare(1)).action?.reason, 'weekly at wall', 'one roomy peer is not enough cover');
  // A dying credit outranks the hold: it is spent before it is lost.
  assert.equal(decide(limit, [credit({ expiresAt: now + 5 * hour })], spare(5)).action?.reason, 'dying value');
});

test('a weekly credit is never spent for a session limit alone', () => {
  // Session at 100%, weekly nearly empty: the week has room, so a WEEKLY credit buys
  // nothing the account lacks. Owner 2026-10-30, unchanged by EXACT LIMIT.
  const sessionFull = owner({ unified7d: 0.20, unified5h: 1, unified7dReset: now + 40 * hour });
  assert.equal(decide(sessionFull, [credit()], spare(0)).action, null);
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

test('a hold is counted in the pool budget only AT the limit — there is no hold from below it', () => {
  const am = manager();
  const [holder, other] = am.accounts;
  // Below the limit a stamped hold is no hold: nothing is being kept, so nothing may
  // draw on the spare accounts. (The removed early hold counted from the stamp.)
  holder.quota.unified7d = 0.97;
  holder.quota.unified7dReset = Date.now() + 5 * hour;
  am.noteWallHold(holder, Date.now());
  assert.equal(am.isHoldingWall(holder), false, 'under the limit: not a wall holder');
  assert.equal(am.countHoldingWalls(other, Date.now()), 1, 'the other account budgets for itself only');
  // At the limit the same stamp is live, and is retired by a claim.
  holder.quota.unified7d = 0.999;
  assert.equal(am.isHoldingWall(holder), true);
  assert.equal(am.countHoldingWalls(other, Date.now()), 2, 'the other account budgets for the holder too');
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
  // The REAL wiring hooks production sets in index.js. (The early-claim inputs are gone:
  // the decision no longer takes them.)
  am.codexResetLiftRows = (account, now) => redeemer.liftRows(account, now);
  am.codexResetSpendableExpiry = (account, now) => redeemer.spendableExpiry(account, now);
  return { am, t, consumed, redeemer };
}

test('REAL WIRING: nothing is spent below the limit on the sweep, spare accounts or not', async () => {
  // The old rule spent here (0.975 used, two roomy peers: an early hold, then a spend once
  // one peer filled). Under EXACT LIMIT the sweep decides there is nothing to spend.
  const { am, consumed, redeemer } = realPool({ holder: 0.975 });
  const holder = am.accounts[0];
  const result = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(result.redeemed, false);
  assert.deepEqual(consumed, []);
  assert.equal(am.isHoldingWall(holder, Date.now()), false, 'no hold is registered from below the limit');
  // One peer fills up: still below the limit, still nothing.
  am.applyCodexUsageData(2, { sevenDay: { utilization: 0.95, resetAt: Date.now() + 40 * hour } }, { sentAt: Date.now() });
  assert.equal((await redeemer.maybeRedeemForPool([holder])).redeemed, false);
  assert.deepEqual(consumed, []);
  // The limit is reached with no spare account: the real sweep spends.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.999, resetAt: Date.now() + 40 * hour } }, { sentAt: Date.now() });
  const spent = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(spent.redeemed, true, spent.reason);
  assert.deepEqual(consumed, ['credit-a']);
});

test('REAL WIRING: at the limit the credit is held while two real peers have room', async () => {
  const { am, consumed, redeemer } = realPool({ holder: 0.999 });
  const holder = am.accounts[0];
  const held = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(held.redeemed, false);
  assert.equal(held.reason, HOLD_POOL_HAS_ROOM, 'two real peers with 35% weekly headroom carry the load');
  assert.deepEqual(consumed, []);
  assert.equal(am.isHoldingWall(holder, Date.now()), true, 'the hold is registered on the real account');
  assert.equal(am.countHoldingWalls(am.accounts[1], Date.now()), 2, 'and budgeted by the real peer');
});

test('REAL WIRING: the confirmed credit lifts the cap through the redeemer read — a cap is lifted, not spent for', async () => {
  const { am, consumed, redeemer } = realPool({ holder: 0.70 });
  const holder = am.accounts[0];
  holder.capUtilization = 0.75;
  holder.capMode = 'fixed';
  assert.equal(am.capLiftActive(holder, Date.now()), false, 'no rows read yet: the cap holds');
  await redeemer.readDetails(holder);
  assert.equal(am.capLiftActive(holder, Date.now()), true, 'a real credit read lifts the cap');
  assert.equal(am._effectiveCap(holder, 'wk', Date.now()), null);
  // The account is at its OPERATOR cap but under the limit: the cap being lifted is the
  // whole remedy. No credit is spent for it.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.75, resetAt: Date.now() + 40 * hour } }, { sentAt: Date.now() });
  assert.equal((await redeemer.maybeRedeemForPool([holder])).redeemed, false);
  assert.deepEqual(consumed, []);
});

test('REAL SCORING: only a DYING credit steers, and steering never removes SESSION scarcity', async () => {
  const { am, t } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  const req = { profile: 'all', codexCompatible: true, model: 'gpt-6.2-sol', weight: 1 };
  const scores = () => Object.fromEntries(am.accounts.map(a => [a.name, am._scoreAccount(a, req)]));
  // CONTROL: no spendable credit known — the fuller account is the dearest of the three.
  const base = scores();
  assert.ok(base.one > base.two, `baseline ${JSON.stringify(base)}`);
  // A credit with 60 days to live is NOT dying: it does not steer (the old rule steered
  // from 7 days out, filling accounts that were nowhere near their limit).
  am.codexResetSpendableExpiry = () => t + 60 * 24 * hour;
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), false);
  assert.deepEqual(scores(), base, 'a distant credit does not steer');
  am.codexResetSpendableExpiry = () => t + 3 * 24 * hour;
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), false, '3 days is not dying');
  // One dying in 20 hours: the WEEKLY cost is dropped so the account gets its share...
  am.codexResetSpendableExpiry = () => t + 20 * hour;
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), true);
  const steered = scores();
  assert.ok(steered.one < base.one && steered.one <= steered.two, `steered ${JSON.stringify(steered)}`);
  assert.equal(am._accountScarcity(holder, Date.now()), 0, 'the weekly pace term no longer prices this account');
  const ctx = am._scoringContext();
  const termsOn = am._scoreTerms(holder, req, ctx);
  am.codexResetSpendableExpiry = () => t + 60 * 24 * hour;
  const termsOff = am._scoreTerms(holder, req, ctx);
  assert.equal(termsOn.utilizationCost < termsOff.utilizationCost, true,
    `raw weekly utilization no longer prices it (${termsOn.utilizationCost} vs ${termsOff.utilizationCost})`);
  // ...but the SESSION window is untouched. REVIEW 2026-11-27: the old steering zeroed
  // the whole scarcity maximum, which is taken over the 5h term too — a steered account
  // with a nearly-full session lost its session cost and was routed to as if empty.
  const sessionBusy = { ...holder, quota: { ...holder.quota, unified5h: 0.90, unified5hReset: Date.now() + 2 * hour } };
  am.codexResetSpendableExpiry = () => t + 20 * hour;
  const sessionTerm = am._windowScarcity(0.90, Date.now() + 2 * hour, 5 * hour, Date.now());
  assert.ok(sessionTerm > 0, `precondition: a 90% session has a real pace cost (${sessionTerm})`);
  const steeredScarcity = am._accountScarcity(sessionBusy, Date.now());
  assert.equal(steeredScarcity, sessionTerm, 'steering keeps the SESSION cost exactly');
  // Same account, session empty: steering drops the weekly term to zero.
  const sessionIdle = { ...holder, quota: { ...holder.quota, unified5h: 0.02, unified5hReset: Date.now() + 2 * hour } };
  assert.equal(am._accountScarcity(sessionIdle, Date.now()), am._windowScarcity(0.02, Date.now() + 2 * hour, 5 * hour, Date.now()));
  // At the limit the claim takes over and nothing is steered.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.999, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  assert.equal(am._steersForExpiringCredit(holder, Date.now()), false, 'the limit is the claim\'s');
});

test('REAL WIRING, full sequence: a DYING credit on a full-enough account is spent before it expires, spare accounts or not', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  const expiring = { id: 'credit-soon', status: 'available', supportedByPlan: true, expiresAt: t + 20 * hour };
  redeemer.detailsFn = async () => ({ credits: [expiring] });
  await redeemer.readDetails(holder);
  // 45% of the week used, credit dying in 20h, own refill 40h away: the final precaution.
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.45, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  const result = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(result.redeemed, true, result.reason);
  assert.equal(result.reason, 'dying value');
  assert.deepEqual(consumed, ['credit-soon']);
});

test('REAL WIRING: a credit that is NOT dying waits for the limit even on a busy account', async () => {
  const { am, t, consumed, redeemer } = realPool({ holder: 0.55, peers: [0.10, 0.10] });
  const holder = am.accounts[0];
  redeemer.detailsFn = async () => ({ credits: [{ id: 'credit-later', status: 'available', supportedByPlan: true, expiresAt: t + 5 * 24 * hour }] });
  await redeemer.readDetails(holder);
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.80, resetAt: t + 40 * hour } }, { sentAt: Date.now() });
  const result = await redeemer.maybeRedeemForPool([holder]);
  assert.equal(result.redeemed, false, '5 days to live and under the limit: wait');
  assert.deepEqual(consumed, []);
});
