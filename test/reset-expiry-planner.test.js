// ONE expiry rule for every provider (owner, 2026-11-28: "It was stupid to implement it
// only for Codex to start with. We use the same machinery. There probably should be one
// common place that does that."). Covers the shared planner in src/reset-policy.js and
// each provider's use of it: plan ahead in the last day, last resort in the last 30
// minutes from 30% used, the 5-minute retry inside that window, a refusal that spends
// promptly, the 100% routing bench, and the reset outcomes the pool dashboard shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POLICY, EXPIRING_RESET, LAST_RESORT_REASON, RESET_OUTCOME, planExpiringReset, retryAfterFailedReset,
  weeklyUsedWithRefusal, noteResetOutcome, resetOutcomeLabel, decideZai, decideClaudeWithReason, decideCodexWithReason,
} from '../src/reset-policy.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { ResetCreditRedeemer } from '../src/codex-reset-credits.js';
import { resetOutcomesLine } from '../src/tui.js';
import { __serverTest } from '../src/server.js';

const M = 60_000;
const H = 60 * M;
const DAY = 24 * H;
const plain = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

async function quietly(fn) {
  const log = console.log;
  console.log = () => {};
  try { return await fn(); } finally { console.log = log; }
}

// ── the shared planner ───────────────────────────────────────────────────────
test('the planner: steer in the last day, last resort in the last 30 minutes from 30% used', () => {
  const now = 1_800_000_000_000;
  assert.equal(POLICY.dyingWindowMs, DAY);
  assert.equal(POLICY.lastResortMs, 30 * M, 'owner: "Why two hours and not 30 minutes or 10 minutes?"');
  assert.equal(POLICY.dyingMinUtilWeekly, 0.30);
  const plan = (left, util, extra = {}) => planExpiringReset({ expiresAt: now + left, util, now, ...extra });
  assert.equal(plan(DAY + M, 0.5), null, 'more than a day left: nothing to plan');
  assert.equal(plan(20 * H, 0.5), EXPIRING_RESET.STEER);
  assert.equal(plan(31 * M, 0.9), EXPIRING_RESET.STEER, '31 minutes: still steering, not spending');
  assert.equal(plan(30 * M, 0.3), EXPIRING_RESET.LAST_RESORT);
  assert.equal(plan(M, 0.999), EXPIRING_RESET.LAST_RESORT);
  assert.equal(plan(10 * M, 0.29), EXPIRING_RESET.STEER, 'under 30% used: never a last resort');
  assert.equal(plan(20 * M, 0.9, { refillAt: now + 10 * M }), EXPIRING_RESET.STEER, 'a free refill first: kept');
  assert.equal(plan(20 * M, 0.9, { refillAt: now + 40 * M }), EXPIRING_RESET.LAST_RESORT, 'a refill after expiry does not save it');
  assert.equal(plan(20 * M, 1), null, 'at 100% the routine claim owns the reset');
  assert.equal(plan(-M, 0.9), null, 'already expired');
  assert.equal(plan(20 * M, null), null, 'unknown usage: never spend');
});

test('the retry pace: about five minutes inside the last-resort window, the usual backoff elsewhere', () => {
  const now = 1_800_000_000_000;
  const wait = (left, extra = {}) => retryAfterFailedReset({ expiresAt: now + left, util: 0.6, now, usualWaitMs: 15 * M, ...extra });
  assert.equal(wait(20 * M), POLICY.lastResortRetryMs);
  assert.equal(POLICY.lastResortRetryMs, 5 * M);
  assert.equal(wait(20 * H), 15 * M, 'outside the window the 15m/30m/1h steps stand');
  assert.equal(wait(20 * M, { providerWaitMs: 8 * M }), 8 * M, "a provider's own Retry-After is never shortened");
  assert.equal(wait(20 * M, { util: 0.1 }), 15 * M, 'not a last resort under 30% used');
});

test('a weekly refusal reads as 100% of its window until the account serves again, a reset is spent, or the window rolls', () => {
  const now = 1_800_000_000_000;
  const refillAt = now + 5 * H;
  const account = { weeklyRefusal: { at: now - M, refillAt } };
  assert.equal(weeklyUsedWithRefusal(account, 0.999, refillAt, now), 1, 'routing stalled at 99.9% before this');
  assert.equal(weeklyUsedWithRefusal({ ...account, lastSuccessAt: now }, 0.999, refillAt, now), 1, 'completion time alone cannot end the refusal');
  assert.equal(weeklyUsedWithRefusal({ ...account, lastGeneralClaimAt: now }, 0.2, refillAt, now), 0.2, 'claimed since');
  assert.equal(weeklyUsedWithRefusal(account, 0.1, now + 7 * DAY, now), 0.1, 'a new window');
  assert.equal(weeklyUsedWithRefusal({}, 0.999, refillAt, now), 0.999, 'no refusal: the reading stands');
  noteResetOutcome(account, RESET_OUTCOME.SPENT, { util: 1, id: 'g1', now });
  assert.equal(account.weeklyRefusal, null, 'a spent weekly reset answers the refusal, so it cannot license a second');
});

// ── each provider decides with the same rule ────────────────────────────────
test('GLM, Claude and Codex all spend an expiring weekly reset as a last resort, and only then', () => {
  const now = 1_800_000_000_000;
  const zai = wk => ({ name: 'g', enabled: true, quota: { providerWk: wk, providerSes: 0.2, providerWkReset: now + 3 * DAY } });
  const card = left => ({ weekly: [{ recordId: 1, expiresAt: now + left }], fiveHour: [] });
  assert.equal(decideZai(zai(0.6), card(20 * M), now)?.reason, LAST_RESORT_REASON);
  assert.equal(decideZai(zai(0.6), card(2 * H), now), null);

  const grants = endsAt => ({ grants: [{ id: 'g', usableNow: true, resetsLeft: 1, endsAt, clears: ['seven_day'], requiresLimit: false }], eligible: true, checkedAt: now });
  const claude = wk => ({ name: 'c', enabled: true, quota: { unified7d: wk, unified7dReset: now + 3 * DAY, lastProbeOkAt: now } });
  assert.equal(decideClaudeWithReason(claude(0.6), grants(now + 20 * M), now).action?.reason, LAST_RESORT_REASON);
  assert.equal(decideClaudeWithReason(claude(0.6), grants(now + 2 * H), now).action, null);
  const atLimitOnly = grants(now + 20 * M);
  atLimitOnly.grants[0].requiresLimit = true;
  assert.equal(decideClaudeWithReason(claude(0.6), atLimitOnly, now).action, null, 'a grant the provider only honours at the limit');

  const codex = wk => ({ name: 'x', provider: 'codex', quota: { unified7d: wk, unified7dReset: now + 3 * DAY, codexWeeklyReadingAt: now } });
  const credit = left => [{ id: 'c', status: 'available', expiresAt: now + left }];
  assert.equal(decideCodexWithReason(codex(0.6), credit(20 * M), now).action?.reason, LAST_RESORT_REASON);
  assert.equal(decideCodexWithReason(codex(0.6), credit(2 * H), now).action, null);
});

test('at 100% the free-refill hold still keeps a reset, unless the reset would expire first', () => {
  const now = 1_800_000_000_000;
  const full = { name: 'g', enabled: true, quota: { providerWk: 1, providerSes: 0.2, providerWkReset: now + 10 * H } };
  const room = { peersWithRoom: () => 2 };
  assert.equal(decideZai(full, { weekly: [{ recordId: 1, expiresAt: now + 5 * DAY }], fiveHour: [] }, now, room), null, 'refill in 10h, two spare accounts: kept');
  assert.equal(decideZai(full, { weekly: [{ recordId: 1, expiresAt: now + 5 * H }], fiveHour: [] }, now, room)?.reason, 'weekly at wall', 'the card dies before the refill: spent');
  assert.equal(decideZai(full, { weekly: [{ recordId: 1, expiresAt: now + 5 * DAY }], fiveHour: [] }, now, { peersWithRoom: () => 1 })?.reason, 'weekly at wall', 'one spare account is not enough');
});

test('a five-hour card is spent only at a full five-hour window, never in place of a weekly reset, never as a last resort', () => {
  const now = 1_800_000_000_000;
  const cards = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: now + 10 * M }] };
  const acct = (wk, ses) => ({ name: 'g', enabled: true, quota: { providerWk: wk, providerSes: ses, providerWkReset: now + 3 * DAY, providerSesReset: now + 2 * H } });
  assert.equal(decideZai(acct(0.5, 0.9), cards, now), null, 'dying, but the session is not full');
  assert.equal(decideZai(acct(1, 1), cards, now), null, 'a full week: the five-hour card would lift nothing');
  assert.equal(decideZai(acct(0.5, 1), cards, now)?.resetType, 'FIVE_HOUR');
});

test('Claude: a failed claim on a grant in its last 30 minutes is retried in 5 minutes; elsewhere the 15-minute step stands', async () => {
  await quietly(() => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'claude-a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: now + H }], 0.9);
    const [claude] = am.accounts;
    Object.assign(claude.quota, { unified7d: 0.6, unified7dReset: now + 3 * DAY, lastProbeOkAt: now });
    am.applyResetGrants(0, { grants: [
      { id: 'soon', usableNow: true, resetsLeft: 1, endsAt: now + 20 * M, clears: ['seven_day'] },
      { id: 'later', usableNow: true, resetsLeft: 1, endsAt: now + 5 * DAY, clears: ['seven_day'] },
    ], eligible: true }, now);
    assert.equal(am.noteClaimFailure(claude, 'soon', now).waitMs, POLICY.lastResortRetryMs);
    assert.equal(am.noteClaimFailure(claude, 'later', now).waitMs, 15 * M);
    assert.equal(am.noteClaimFailure('claude-a', 'soon', now).waitMs, POLICY.lastResortRetryMs, 'the name spelling still resolves the account');
  });
});

// ── routing: the same planner steers every provider ─────────────────────────
test('plan ahead: a GLM card or a Claude grant in its last day steers work to its account; a five-hour card never does', async () => {
  await quietly(() => {
    const now = Date.now();
    const am = new AccountManager([
      { name: 'claude-a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: now + H },
      { name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' },
    ], 0.9);
    const [claude, glm] = am.accounts;
    Object.assign(claude.quota, { unified7d: 0.55, unified7dReset: now + 3 * DAY, lastProbeOkAt: now });
    am.applyResetGrants(0, { grants: [{ id: 'g1', usableNow: true, resetsLeft: 1, endsAt: now + 20 * H, clears: ['seven_day'] }], eligible: true }, now);
    assert.equal(am._steersForExpiringReset(claude, now), true, 'Claude');
    // Both accounts hold full cap lifts, the ordinary production state: changing only
    // expiry must change placement cost without changing session or concurrency cost.
    function verifyScore(account, row, expiryKey) {
      account.loadEvents = [{ at: now, success: true, weight: 1 }];
      const score = () => am._scoreTerms(account, {}, { now, fleetRecentWeight: 2 });
      const near = score();
      row[expiryKey] += 3 * DAY;
      const far = score();
      row[expiryKey] -= 3 * DAY;
      assert.ok(near.spread < far.spread);
      assert.equal(near.utilizationCost, far.utilizationCost);
      assert.equal(near.concurrency, far.concurrency);
      assert.equal(near.capPenalty, far.capPenalty);
    }
    verifyScore(claude, claude.resetGrants.grants[0], 'endsAt');
    am.applyResetGrants(0, { grants: [{ id: 'g2', usableNow: true, resetsLeft: 1, endsAt: now + 3 * DAY, clears: ['seven_day'] }], eligible: true }, now);
    assert.equal(am._steersForExpiringReset(claude, now), false, 'three days left: not dying');

    Object.assign(glm.quota, { providerWk: 0.5, providerWkReset: now + 3 * DAY, providerSes: 0.2, lastProbeOkAt: now });
    am.applyResetCards(1, { weekly: [{ recordId: 7, expiresAt: now + 20 * H }], fiveHour: [] });
    assert.equal(am._steersForExpiringReset(glm, now), true, 'GLM');
    verifyScore(glm, glm.resetCards.weekly[0], 'expiresAt');
    am.applyResetCards(1, { weekly: [], fiveHour: [{ recordId: 8, expiresAt: now + 20 * H }] });
    assert.equal(am._steersForExpiringReset(glm, now), false, 'a five-hour card refills no weekly window');
    glm.quota.lastProbeOkAt = now - 10 * M;
    am.applyResetCards(1, { weekly: [{ recordId: 7, expiresAt: now + 20 * H }], fiveHour: [] });
    assert.equal(am._steersForExpiringReset(glm, now), false, 'a stale reading could hide a full account');
  });
});

test('routing benches at 100%, and a saved 0.999 default reads as the limit', () => {
  assert.equal(new AccountManager([], 0.9).scheduler.weeklyExhaustedThreshold, 1);
  assert.equal(new AccountManager([], 0.9, { weeklyExhaustedThreshold: 0.999 }).scheduler.weeklyExhaustedThreshold, 1,
    'the old default stalled resets at 99.9%');
  assert.equal(new AccountManager([], 0.9, { weeklyExhaustedThreshold: 0.98 }).scheduler.weeklyExhaustedThreshold, 0.98,
    'any other operator value stands');
});

// ── refusals spend promptly ──────────────────────────────────────────────────
test('which 429s are a weekly refusal, for every provider', () => {
  const { weeklyRefusalOf } = __serverTest;
  const claude = { type: 'oauth', provider: 'anthropic' };
  const h = wk => ({ 'anthropic-ratelimit-unified-7d-utilization': String(wk), 'anthropic-ratelimit-unified-status': 'rejected' });
  assert.deepEqual(weeklyRefusalOf(claude, h(0.9995), '', { scope: 'account' }, null), { window: 'weekly', weeklyUtil: 0.9995 });
  assert.equal(weeklyRefusalOf(claude, h(0.9995), '', { scope: 'account', modelScope: 'fable' }, null), null, 'a model sub-limit');
  assert.equal(weeklyRefusalOf(claude, h(0.6), '', { scope: 'account' }, null), null, 'the five-hour limit');
  assert.equal(weeklyRefusalOf(claude, h(1), '', { scope: 'upstream' }, null), null, 'a shared throttle');

  const zai = { type: 'provider', provider: 'zai' };
  const body = code => JSON.stringify({ error: { code, message: 'Weekly Limit Exhausted' } });
  assert.deepEqual(weeklyRefusalOf(zai, {}, body('1310'), { scope: 'account' }, null), { window: 'weekly', weeklyUtil: null });
  assert.equal(weeklyRefusalOf(zai, {}, body('1308'), { scope: 'account' }, null), null, '1308 is the five-hour limit');

  const codex = { type: 'oauth', provider: 'codex' };
  const weekly = pct => ({ 'x-codex-primary-used-percent': String(pct), 'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': '1900000000' });
  assert.deepEqual(weeklyRefusalOf(codex, weekly(100), '', {}, { scope: 'account', modelScope: null }), { window: 'weekly', weeklyUtil: 1 });
  assert.equal(weeklyRefusalOf(codex, weekly(60), '', {}, { scope: 'account', modelScope: null }), null);
});

test('GLM: a weekly refusal at 99.9% redeems the card at once, once per five minutes; the free-refill hold still applies', async () => {
  await quietly(async () => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' }], 0.9);
    const [glm] = am.accounts;
    glm.credential = 'k';
    Object.assign(glm.quota, { providerWk: 0.999, providerWkReset: now + 2 * DAY, providerSes: 0.3, lastProbeOkAt: now });
    let listed = 0;
    const prober = new Prober(am, { log() {}, cardsFn: async () => { listed++; return { weekly: [{ recordId: 3, expiresAt: now + 9 * DAY }], fiveHour: [] }; } });
    const redeemed = [];
    prober._redeemZaiCard = async (_a, act) => { redeemed.push(act); return true; };
    am.providerReactiveReset = (account, t) => prober.redeemWeeklyCardNow(account, t);
    assert.equal(await am.onWeeklyRefusal(glm, { window: 'weekly' }, now), true);
    assert.deepEqual(redeemed.map(a => [a.resetType, a.reason]), [['WEEK', 'weekly at wall']]);
    assert.equal(await am.onWeeklyRefusal(glm, { window: 'weekly' }, now + 1000), false, 'a burst of 429s does not hammer the card route');
    assert.equal(listed, 1);

    const am2 = new AccountManager([{ name: 'glm-b', type: 'provider', provider: 'zai', apiKey: 'k2', upstream: 'https://api.z.ai/api/anthropic' }], 0.9);
    const [b] = am2.accounts;
    b.credential = 'k2';
    Object.assign(b.quota, { providerWk: 1, providerWkReset: now + 6 * H, lastProbeOkAt: now });
    am2.countPeersWithRoom = () => 2;
    const p2 = new Prober(am2, { log() {}, cardsFn: async () => ({ weekly: [{ recordId: 4, expiresAt: now + 9 * DAY }], fiveHour: [] }) });
    const held = [];
    p2._redeemZaiCard = async (_a, act) => { held.push(act); };
    assert.equal(await p2.redeemWeeklyCardNow(b, now), false);
    assert.deepEqual(held, [], 'the free refill lands in 6h and two spare accounts carry the work');
  });
});

test('Claude: a weekly refusal at 99.9% claims the grant even though the probe never reads 100%', () => {
  const now = 1_800_000_000_000;
  const listing = { grants: [{ id: 'g', usableNow: true, resetsLeft: 1, endsAt: now + 9 * DAY, clears: ['seven_day'] }], eligible: true, checkedAt: now };
  const account = { name: 'c', enabled: true, quota: { unified7d: 0.999, unified7dReset: now + 3 * DAY, lastProbeOkAt: now } };
  assert.equal(decideClaudeWithReason(account, listing, now).action, null, 'no refusal: 99.9% is not the limit');
  account.weeklyRefusal = { at: now - M, refillAt: now + 3 * DAY };
  assert.equal(decideClaudeWithReason(account, listing, now).action?.reason, 'weekly at wall', 'the sweep retries after a failed reactive claim');
});

// ── Codex through the real redeemer ─────────────────────────────────────────
function codexRedeemer({ used, expiresIn, code = 'reset', t }) {
  const owner = { name: 'cx', provider: 'codex', codexAuth: 'native', index: 0, codexAccountId: 'w', accountUuid: 'u',
    quota: { unified7d: used, unified7dReset: t + 3 * DAY, codexWeeklyReadingAt: t, codexResetCredits: { available: 1, checkedAt: t } } };
  const am = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: () => true,
    countPeersWithRoom: () => 0, refreshCapLift() {}, observeResetInventory() {} };
  const consumed = [];
  const redeemer = new ResetCreditRedeemer(am, { now: () => t, log() {},
    detailsFn: async () => ({ credits: [{ id: 'c1', status: 'available', supportedByPlan: true, expiresAt: t + expiresIn }] }),
    consumeFn: async (_a, attempt) => { consumed.push(attempt.creditId); return { code, windowsReset: 1 }; },
    usageFn: async () => ({ sevenDay: { utilization: 0.01, resetAt: owner.quota.unified7dReset } }) });
  return { owner, redeemer, consumed };
}

test('Codex: the first sweep inside the last 30 minutes spends the credit and records it as a last resort', async () => {
  const t = 1_800_000_000_000;
  const { owner, redeemer, consumed } = codexRedeemer({ used: 0.6, expiresIn: 20 * M, t });
  const result = await redeemer.maybeRedeemForPool([owner]);
  assert.equal(result.redeemed, true, result.reason);
  assert.deepEqual(consumed, ['c1']);
  assert.deepEqual([owner.resetOutcomes.weekly.kind, owner.resetOutcomes.weekly.util], [RESET_OUTCOME.LAST_RESORT, 0.6]);
  const kept = codexRedeemer({ used: 0.6, expiresIn: 2 * H, t });
  assert.equal((await kept.redeemer.maybeRedeemForPool([kept.owner])).redeemed, false, 'two hours left: kept');
  assert.deepEqual(kept.consumed, []);
});

test('Codex: a declined last-resort attempt is retried five minutes later, not thirty', async () => {
  const t = 1_800_000_000_000;
  const { owner, redeemer } = codexRedeemer({ used: 0.6, expiresIn: 20 * M, code: 'nothing_to_reset', t });
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, false);
  assert.equal(redeemer._stateFor(owner).cooldownUntil - t, POLICY.lastResortRetryMs);
});

test('Codex: a refusal at 99.9% spends promptly through the reactive path', async () => {
  const t = 1_800_000_000_000;
  const { owner, redeemer } = codexRedeemer({ used: 0.999, expiresIn: 9 * DAY, t });
  assert.equal((await redeemer.maybeRedeemForPool([owner], { reactive: true })).redeemed, false, 'no refusal recorded: waits');
  owner.weeklyRefusal = { at: t, refillAt: owner.quota.unified7dReset };
  const result = await redeemer.maybeRedeemForPool([owner], { reactive: true });
  assert.equal(result.redeemed, true, result.reason);
  assert.equal(owner.resetOutcomes.weekly.kind, RESET_OUTCOME.REFUSED);
  assert.equal(owner.weeklyRefusal, null);
});

// ── the dashboard ────────────────────────────────────────────────────────────
test('a reset that left its listing after its own end expired unused; one spent before its end is not reported', async () => {
  await quietly(() => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' }], 0.9);
    const [glm] = am.accounts;
    am.applyResetCards(0, { weekly: [{ recordId: 9, expiresAt: now + 1000 }], fiveHour: [] });
    const realNow = Date.now;
    Date.now = () => now + 5000;
    try { am.applyResetCards(0, { weekly: [{ recordId: 9, expiresAt: now + 1000, expired: true }], fiveHour: [] }); } finally { Date.now = realNow; }
    assert.equal(glm.resetOutcomes?.weekly?.kind, RESET_OUTCOME.EXPIRED);
    glm.resetOutcomes = null;
    am.applyResetCards(0, { weekly: [{ recordId: 10, expiresAt: now + 5 * H }], fiveHour: [] });
    am.applyResetCards(0, { weekly: [], fiveHour: [] });
    assert.equal(glm.resetOutcomes, null, 'gone before its end: spent somewhere, not expired');
  });
});

test('the pool dashboard line names each outcome: spent at 100%, last resort with the share used, expired unused', () => {
  const now = 1_800_000_000_000;
  assert.equal(resetOutcomeLabel({ kind: RESET_OUTCOME.LAST_RESORT, util: 0.64 }), 'spent as last resort (64% used)');
  // The share is rounded DOWN: a spend below the limit never reads as 100% used.
  assert.equal(resetOutcomeLabel({ kind: RESET_OUTCOME.LAST_RESORT, util: 0.999 }), 'spent as last resort (99% used)');
  // A record labelled "spent" whose measured share was below the limit states the share.
  assert.equal(resetOutcomeLabel({ kind: RESET_OUTCOME.SPENT, util: 0.999 }), 'spent (99% used)');
  assert.equal(resetOutcomeLabel({ kind: RESET_OUTCOME.SPENT, util: null }), 'spent (usage unknown)');
  // A session-only card fills its own window: say so, never "spent at 100%" alone.
  assert.equal(resetOutcomeLabel({ kind: RESET_OUTCOME.SPENT, util: 1, window: '5h' }), 'spent at 100%');
  const accounts = [
    { name: 'claude-a', resetOutcomes: { weekly: { kind: RESET_OUTCOME.LAST_RESORT, util: 0.64, at: now - 2 * H } } },
    { name: 'glm-a', resetOutcomes: { weekly: { kind: RESET_OUTCOME.EXPIRED, at: now - 26 * H }, '5h': { kind: RESET_OUTCOME.SPENT, util: 1, at: now - 10 * M } } },
    { name: 'old', resetOutcomes: { weekly: { kind: RESET_OUTCOME.SPENT, util: 1, at: now - 8 * DAY } } },
    { name: 'off', enabled: false, resetOutcomes: { weekly: { kind: RESET_OUTCOME.SPENT, util: 1, at: now - H } } },
    // A per-model grant the pool claimed, and a cloud mirror's own outcome, are shown too.
    { name: 'claude-b', resetOutcomes: { model: { kind: RESET_OUTCOME.SPENT, util: 1, at: now - 30 * M } } },
    { name: 'cloud-a', remote: true, resetOutcomes: { weekly: { kind: RESET_OUTCOME.SPENT, util: 1, at: now - 40 * M } } },
  ];
  assert.equal(plain(resetOutcomesLine(accounts, 260, now)),
    ' Resets  glm-a five-hour card spent at 100%, 10m ago · claude-b model grant spent at 100%, 30m ago · cloud-a spent at 100%, 40m ago · claude-a spent as last resort (64% used), 2h ago · glm-a expired unused, 1d ago');
  const narrow = plain(resetOutcomesLine(accounts, 80, now));
  assert.ok(narrow.length < 80, narrow);
  assert.equal(resetOutcomesLine([{ name: 'none' }], 120, now), null, 'nothing to show: no line');
});

test('an expiry seen late never turns a newer spend into "expired unused", and says when it was seen', async () => {
  await quietly(async () => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' }], 0.9);
    const [glm] = am.accounts;
    const real = Date.now;
    const at = ms => { Date.now = () => ms; };
    try {
      at(now); am.applyResetCards(0, { weekly: [{ recordId: 1, expiresAt: now + 2 * M }], fiveHour: [] });
      // Credit 1 lapsed at now+2m; before the next listing, credit 2 is spent.
      at(now + 3 * M); noteResetOutcome(glm, RESET_OUTCOME.SPENT, { window: 'weekly', util: 1, id: '2', now: now + 3 * M });
      at(now + 5 * M); am.applyResetCards(0, { weekly: [{ recordId: 2, expiresAt: now + 9 * H }], fiveHour: [] });
    } finally { Date.now = real; }
    assert.equal(glm.resetOutcomes.weekly.kind, RESET_OUTCOME.SPENT, 'the newer spend is kept');
    assert.equal(glm.resetOutcomes.weekly.id, '2');
  });
  // A lapse seen hours after its end is worded by when it was SEEN, not "7d ago".
  const seenAt = 1_800_000_000_000;
  const line = plain(resetOutcomesLine([{ name: 'c', resetOutcomes: { weekly: { kind: RESET_OUTCOME.EXPIRED, at: seenAt - 6 * 24 * H, seenAt } } }], 200, seenAt + 2 * M));
  assert.equal(line, ' Resets  c expired unused, 2m ago');
});

// ── review fixes: refusals, retries, outcomes ────────────────────────────────
test('a Claude SESSION refusal never spends a weekly reset; a z.ai monthly 1310 never does either', () => {
  const { weeklyRefusalOf } = __serverTest;
  const claude = { type: 'oauth', provider: 'anthropic' };
  const h = (wk, ses) => ({ 'anthropic-ratelimit-unified-7d-utilization': String(wk), 'anthropic-ratelimit-unified-5h-utilization': String(ses), 'anthropic-ratelimit-unified-status': 'rejected' });
  // The week reads 0.999 with a FULL session window: it is the session that refused.
  assert.equal(weeklyRefusalOf(claude, h(0.999, 1), '', { scope: 'account' }, null), null, 'a session refusal clears for free');
  // The week itself at 100% is a weekly refusal even with a full session window.
  assert.deepEqual(weeklyRefusalOf(claude, h(1, 1), '', { scope: 'account' }, null), { window: 'weekly', weeklyUtil: 1 });
  // No session header at all: the week at the floor decides, as before.
  assert.deepEqual(weeklyRefusalOf(claude, h(0.9995, ''), '', { scope: 'account' }, null), { window: 'weekly', weeklyUtil: 0.9995 });

  const zai = { type: 'provider', provider: 'zai' };
  const body = (code, message) => JSON.stringify({ error: { code, message } });
  assert.equal(weeklyRefusalOf(zai, {}, body(1310, 'Monthly Limit Exhausted'), { scope: 'account' }, null), null, 'a monthly limit is not a weekly card\'s to clear');
  assert.deepEqual(weeklyRefusalOf(zai, {}, body(1310, 'Weekly Limit Exhausted'), { scope: 'account' }, null), { window: 'weekly', weeklyUtil: null });
  assert.deepEqual(weeklyRefusalOf(zai, {}, body('1310', 'Your limit will reset at 2026-11-12 04:28:53'), { scope: 'account' }, null), null, 'ambiguous 1310 cannot authorize a weekly card');
});

test('inside the last 30 minutes a FAILED spend is retried in 5 minutes at 100% too', () => {
  const now = 1_800_000_000_000;
  const wait = (util, left = 20 * M) => retryAfterFailedReset({ expiresAt: now + left, util, now, usualWaitMs: 15 * M });
  assert.equal(wait(1), POLICY.lastResortRetryMs, 'plan-ahead usually has the account at 100% by then');
  assert.equal(wait(1, 2 * H), 15 * M, 'outside the window the usual step stands at 100%');
  assert.equal(wait(0.1), 15 * M, 'under 30% used an expiring reset is not worth retrying');
});

test('a stream that was already running when the refusal came does not end it; a request started after it does', () => {
  const now = 1_800_000_000_000;
  const refillAt = now + 5 * H;
  const account = { weeklyRefusal: { at: now - M, refillAt }, lastSuccessAt: now };
  assert.equal(weeklyUsedWithRefusal(account, 0.9995, refillAt, now), 1, 'a later success stamp alone is not proof the wall is gone');
  assert.equal(weeklyUsedWithRefusal({ ...account, lastGeneralClaimAt: now }, 0.2, refillAt, now), 0.2, 'claimed since');
  // Unknown refill time: trusted for a bounded time, never across a window.
  const unknown = { weeklyRefusal: { at: now - M, refillAt: null } };
  assert.equal(weeklyUsedWithRefusal(unknown, 0.9995, null, now), 1);
  assert.equal(weeklyUsedWithRefusal(unknown, 0.9995, null, now + 6 * M), 0.9995);

  // releaseAccount clears the refusal only on a request that STARTED after it.
  const am = new AccountManager([{ name: 'c', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H }], 0.9);
  const [c] = am.accounts;
  const t = Date.now();
  c.weeklyRefusal = { at: t, refillAt: t + 5 * H };
  am.releaseAccount({ account: c, startedAt: t - 60_000 }, { success: true, status: 200 });
  assert.ok(c.weeklyRefusal, 'started before the refusal: kept');
  am.releaseAccount({ account: c, startedAt: t + 1000 }, { success: true, status: 200 });
  assert.equal(c.weeklyRefusal, null, 'started after it and served: the wall is gone');
});

test('GLM: a refusal-driven card spend is recorded with the share the probe read, not as last resort', async () => {
  await quietly(async () => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', upstream: 'https://api.z.ai/api/anthropic' }], 0.9);
    const [glm] = am.accounts;
    glm.credential = 'k';
    Object.assign(glm.quota, { providerWk: 0.998, providerWkReset: now + 2 * DAY, providerSes: 0.3, lastProbeOkAt: now });
    // The real redeem, with the wire stubbed: this pins the outcome-recording line itself.
    const realFetch = globalThis.fetch;
    const posts = [];
    globalThis.fetch = async (_url, init) => { posts.push(init?.method || 'GET');
      return { status: 200, json: async () => (init?.method === 'POST' ? { code: 200, success: true, data: 1 }
        : { code: 200, success: true, data: { fiveHourResets: [], weekResets: [] } }) }; };
    try {
      const prober = new Prober(am, { log() {}, cardsFn: async () => ({ weekly: [{ recordId: 3, expiresAt: now + 9 * DAY }], fiveHour: [] }),
        providerProbeFn: async () => ({ wk: { utilization: 0.998, resetAt: now + 2 * DAY }, ses: { utilization: 0.3, resetAt: now + H } }) });
      am.providerReactiveReset = (account, t) => prober.redeemWeeklyCardNow(account, t);
      assert.equal(await am.onWeeklyRefusal(glm, { window: 'weekly' }, now), true);
      assert.equal(posts.filter(m => m === 'POST').length, 1, 'one redeem on the wire');
      assert.deepEqual([glm.resetOutcomes.weekly.kind, glm.resetOutcomes.weekly.util], [RESET_OUTCOME.REFUSED, 0.998],
        'not "spent at 100%": the probe read 99.8%');
      assert.equal(resetOutcomeLabel(glm.resetOutcomes.weekly), 'spent after weekly refusal (99% used)');
      assert.equal(glm.weeklyRefusal, null, 'the spend answered the refusal');
    } finally { globalThis.fetch = realFetch; }
  });
});

test('Claude: a model-scoped grant the pool claimed shows on the line; the status export carries outcomes, seenAt and the refusal', async () => {
  await quietly(() => {
    const now = Date.now();
    const am = new AccountManager([{ name: 'claude-a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: now + H }], 0.9);
    const [c] = am.accounts;
    noteResetOutcome(c, RESET_OUTCOME.SPENT, { window: 'model', util: 1, id: 'f1', now });
    c.weeklyRefusal = { at: now, refillAt: now + 5 * H };
    const row = am.getStatus().accounts[0];
    assert.equal(row.resetOutcomes.model.kind, RESET_OUTCOME.SPENT);
    assert.equal(row.weeklyRefused, true);
    assert.match(plain(resetOutcomesLine(am.accounts, 200, now)), /claude-a model grant spent at 100%/);
    const restarted = new AccountManager([{ name: 'claude-a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: now + H }], 0.9);
    restarted.restoreQuotaState(am.exportQuotaState());
    assert.equal(restarted.accounts[0].resetOutcomes.model.kind, RESET_OUTCOME.SPENT);
    assert.equal(Object.hasOwn(row.resetOutcomes.model, 'id'), false);
    // A disabled account exports no resets, outcomes included.
    c.enabled = false;
    assert.equal(am.getStatus().accounts[0].resetOutcomes, null);
    assert.equal(am.getStatus().accounts[0].weeklyRefused, false);
  });
});

test('Codex: a credit that lapsed while the count read 0 is still seen leaving, and reported "expired unused"', async () => {
  const t = 1_800_000_000_000;
  const am = new AccountManager([{ name: 'cx', provider: 'codex', codexAuth: 'native', codexAccountId: 'w', accountUuid: 'u' }], 0.9);
  const [acct] = am.accounts;   // the manager wraps its accounts; use the object it keeps
  Object.assign(acct.quota, { unified7d: 0.5, unified7dReset: t + 3 * DAY, codexWeeklyReadingAt: t, codexResetCredits: { available: 1, checkedAt: t } });
  let clock = t;
  let rows = [{ id: 'c1', status: 'available', supportedByPlan: true, expiresAt: t + 60 * M }];
  let reads = 0;
  // ONE long-lived redeemer, as in production (its row memory is per instance).
  const redeemer = new ResetCreditRedeemer(am, { now: () => clock, log() {},
    detailsFn: async () => { reads++; return { credits: rows }; }, consumeFn: async () => ({ code: 'reset' }) });
  am.codexResetLiftRows = () => [];
  await quietly(() => redeemer.maybeRedeemForPool([acct]));
  assert.deepEqual(acct._resetInventory.map(i => i.id), ['c1'], 'seeded');
  assert.equal(reads, 1);
  // The credit ends; the upstream count flips to 0 and the rows are gone.
  clock = t + 90 * M;
  acct.quota.codexResetCredits = { available: 0, checkedAt: clock };
  acct.quota.codexWeeklyReadingAt = clock;
  rows = [{ ...rows[0], status: 'expired' }];
  await quietly(() => redeemer.maybeRedeemForPool([acct]));
  assert.equal(reads, 2, 'the rows are read once more');
  assert.equal(acct.resetOutcomes?.weekly?.kind, RESET_OUTCOME.EXPIRED);
  // Self-limiting: the empty read leaves nothing live, so no further row reads happen.
  clock = t + 200 * M;
  acct.quota.codexWeeklyReadingAt = clock;
  await quietly(() => redeemer.maybeRedeemForPool([acct]));
  assert.equal(reads, 2, 'one read per lapse, not one per sweep');
});


test('a failed GLM refusal redeem is retried by the quota sweep even at 99.9%', async () => {
  const now = Date.now();
  const am = new AccountManager([{ name: 'glm retry', type: 'provider', provider: 'zai', apiKey: 'test' }]);
  const [a] = am.accounts;
  a._subsCheckedAt = a._outsideCheckedAt = now;
  a.quota.providerWk = 0.999;
  a.quota.providerWkReset = now + DAY;
  const p = new Prober(am, { log() {}, cardsFn: async () => ({ weekly: [{ recordId: 1, expiresAt: now + 2 * DAY }], fiveHour: [] }),
    providerProbeFn: async () => ({ source: 'zai', wk: { utilization: 0.999, resetAt: now + DAY } }) });
  const attempts = [];
  p._redeemZaiCard = async (_account, act) => { attempts.push(act.resetType); return false; };
  am.providerReactiveReset = account => p.redeemWeeklyCardNow(account);
  await am.onWeeklyRefusal(a);
  await p.probeProvider(a);
  assert.deepEqual(attempts, ['WEEK', 'WEEK']);
});

test('Claude: a confirmed expiry and a disappearance after expiry are different outcomes', () => {
  const am = new AccountManager([{ name: 'test', type: 'oauth' }]);
  const now = Date.now();
  const grant = { id: 'g', clears: ['seven_day'], endsAt: now + M, resetsLeft: 1 };
  for (const [rows, expected] of [[[ { ...grant, expired: true } ], RESET_OUTCOME.EXPIRED], [[], RESET_OUTCOME.UNCONFIRMED]]) {
    am.accounts[0].resetOutcomes = null;
    am.applyResetGrants(0, { grants: [grant] }, now);
    am.applyResetGrants(0, { grants: rows }, now + M + 1);
    assert.equal(am.accounts[0].resetOutcomes.weekly.kind, expected);
  }
});
