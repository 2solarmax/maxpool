import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const H = 3600_000, DAY = 24 * H;
const soon = (ms) => Date.now() + ms;

function makeAm() {
  const mk = (name) => ({ name, type: 'provider', provider: 'zai', enabled: true, profiles: ['all'], apiKey: 'k' });
  const am = new AccountManager([mk('a'), mk('b')], 0.9);
  am.restoreQuotaState([
    { name: 'a', accountUuid: null, quota: { providerSes: 0.20, providerWk: 0.40, providerSesReset: soon(3 * H), providerWkReset: soon(3 * DAY) } },
    { name: 'b', accountUuid: null, quota: { providerSes: 0.20, providerWk: 0.40, providerSesReset: soon(3 * H), providerWkReset: soon(3 * DAY) } },
  ]);
  return am;
}

// ── _holdsUsableReset ─────────────────────────────────────────────────────────
test('holdsUsableReset: live five-hour card counts; weekly card needs a weekly limit', () => {
  const am = makeAm();
  const a = am.accounts[0], b = am.accounts[1];
  am.applyResetCards(0, { fiveHour: [{ recordId: 1, expiresAt: soon(2 * DAY), expired: false }], weekly: [] });
  assert.equal(am._holdsUsableReset(a), true, 'live 5h card');
  assert.equal(am._holdsUsableReset(b), false, 'no cards');

  am.applyResetCards(1, { fiveHour: [], weekly: [{ recordId: 2, expiresAt: soon(2 * DAY), expired: false }] });
  assert.equal(am._holdsUsableReset(b), true, 'weekly card + known weekly limit');
  b.quota.providerWk = null; b.quota.providerWkReset = null;   // legacy: no weekly limit
  assert.equal(am._holdsUsableReset(b), false, 'weekly card lifts nothing without a weekly limit');
});

test('holdsUsableReset: expired card, spent grant, paused grant, disabled account all count as NO reset', () => {
  const am = makeAm();
  const a = am.accounts[0];
  am.applyResetCards(0, { fiveHour: [{ recordId: 1, expiresAt: soon(-H), expired: true }], weekly: [] });
  assert.equal(am._holdsUsableReset(a), false, 'expired card');
  am.applyResetGrants(0, { grants: [{ id: 'g', usableNow: false, resetsLeft: 0 }], eligible: true });
  assert.equal(am._holdsUsableReset(a), false, 'spent grant');
  am.applyResetGrants(0, { grants: [{ id: 'g', usableNow: true, paused: true, resetsLeft: 1, endsAt: soon(DAY), clears: ['seven_day'] }], eligible: true });
  assert.equal(am._holdsUsableReset(a), false, 'paused grant');
  // C4/A1 (2026-11-10): a grant with NO clears is scope-unknown — it can never be
  // spent, so it holds nothing for routing either.
  am.applyResetGrants(0, { grants: [{ id: 'g', usableNow: true, resetsLeft: 1, endsAt: soon(DAY), clears: [] }], eligible: true });
  assert.equal(am._holdsUsableReset(a), false, 'unknown-scope grant holds nothing');
  am.applyResetGrants(0, { grants: [{ id: 'g', usableNow: true, resetsLeft: 1, endsAt: soon(DAY), clears: ['seven_day'] }], eligible: true });
  assert.equal(am._holdsUsableReset(a), true, 'live grant with known scope');
  a.enabled = false;
  assert.equal(am._holdsUsableReset(a), false, 'R0 owner gate: disabled never counts');
});

// ── scoring: bounded preference ───────────────────────────────────────────────
test('scoring: an equal-health account WITH a reset is preferred, but bounded (not dominant)', () => {
  const am = makeAm();
  am.applyResetCards(0, { fiveHour: [{ recordId: 1, expiresAt: soon(2 * DAY), expired: false }], weekly: [] });
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  const withReset = am._scoreAccount(am.accounts[0], {}, ctx);
  const without = am._scoreAccount(am.accounts[1], {}, ctx);
  assert.ok(withReset < without, `reset-holder scores cheaper (${withReset.toFixed(2)} < ${without.toFixed(2)})`);
  // BOUNDED: the discount applies only to the balancing terms, so the gap stays
  // small relative to a real health difference (e.g. a failure penalty).
  am.accounts[1].consecutiveFailures = 3;
  assert.ok(am._scoreAccount(am.accounts[1], {}, ctx) > withReset + 10, 'a failing account is still clearly worse');
});

test('scoring: the reset discount can be turned off (resetBoostDiscount: 0)', () => {
  const am = makeAm();
  am.scheduler.resetBoostDiscount = 0;
  am.applyResetCards(0, { fiveHour: [{ recordId: 1, expiresAt: soon(2 * DAY), expired: false }], weekly: [] });
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  assert.equal(am._scoreAccount(am.accounts[0], {}, ctx), am._scoreAccount(am.accounts[1], {}, ctx),
    'kill-switch restores parity');
});

test('scoring: a reserve-tier reset holder is NOT preferred over a soft-tier sibling', () => {
  const am = makeAm();
  am.applyResetCards(0, { fiveHour: [{ recordId: 1, expiresAt: soon(2 * DAY), expired: false }], weekly: [] });
  am.accounts[0].quota.providerWk = 0.90; am.accounts[0].quota.providerWkReset = soon(5 * DAY);  // reserve
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  assert.ok(am._scoreAccount(am.accounts[0], {}, ctx) > am._scoreAccount(am.accounts[1], {}, ctx),
    'reserve cost dwarfs the reset discount — health gates stay dominant');
});

// ── the false-no-sub latch ────────────────────────────────────────────────────
test('latch: network failures + ONE org-403 never latches subscriptionGone', () => {
  const am = new AccountManager([{ name: 'x', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: soon(H) }], 0.9);
  const a = am.accounts[0];
  am.recordProbeError(0, 'fetch failed', null);
  am.recordProbeError(0, 'probe timed out', null);
  am.recordProbeError(0, 'fetch failed', null);
  am.recordProbeError(0, 'fetch failed', null);
  am.recordProbeError(0, 'fetch failed', null);
  am.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  assert.equal(Boolean(a.subscriptionGone), false, 'a mixed history with one org-403 must NOT latch');
});

test('latch: THREE consecutive org-403s latch; any other failure resets the org streak', () => {
  const am = new AccountManager([{ name: 'x', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: soon(H) }], 0.9);
  const a = am.accounts[0];
  const gone = () => am.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  gone(); gone(); gone();
  assert.equal(a.subscriptionGone, true, 'three real org-403s latch');
  // streak reset: non-org failure between 403s
  const am2 = new AccountManager([{ name: 'x', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: soon(H) }], 0.9);
  am2.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  am2.recordProbeError(0, 'fetch failed', null);
  am2.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  am2.recordProbeError(0, 'fetch failed', null);
  am2.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  assert.equal(Boolean(am2.accounts[0].subscriptionGone), false, 'interleaved network failures break the org streak');
});

test('latch self-clear: a healthy probe un-benches a latched account', () => {
  const am = new AccountManager([{ name: 'x', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: soon(H) }], 0.9);
  const a = am.accounts[0];
  const gone = () => am.recordProbeError(0, 'OAuth authentication is currently not allowed for this organization.', 403);
  gone(); gone(); gone();
  assert.equal(a.subscriptionGone, true);
  am.applyUsageData(0, { limits: [] });   // a passing probe
  assert.equal(a.subscriptionGone, false, 'org accepts OAuth again — un-benched');
});

// ── TEST 27 (C3/C4, 2026-11-10): a LIFTED reset-holder routes at ordinary share ─
test('lifted holder: no C4 discount while lifted (the score equals the discount-off score)', () => {
  const am = makeAm();
  const a = am.accounts[0];
  a.capUtilization = 0.75; a.capMode = 'fixed';
  a.quota.providerWk = 0.80; a.quota.providerWkReset = soon(3 * DAY);
  am.applyResetCards(0, { weekly: [{ recordId: 1, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] });
  assert.equal(am.capLiftActive(a), true, 'control: lifted');
  const ctx = { now: Date.now(), fleetRecentWeight: 0 };
  const liftedScore = am._scoreAccount(a, {}, ctx);
  const noDiscScore = (() => { const saved = am.scheduler.resetBoostDiscount; am.scheduler.resetBoostDiscount = 0;
    const s = am._scoreAccount(a, {}, ctx); am.scheduler.resetBoostDiscount = saved; return s; })();
  assert.ok(Math.abs(liftedScore - noDiscScore) < 1e-9,
    `no discount while lifted: ${liftedScore.toFixed(3)} == discount-off ${noDiscScore.toFixed(3)}`);
  // Control: the SAME account NOT lifted (cap null → no lift) still gets the discount.
  const c = am.accounts[1];
  c.quota.providerWk = 0.30;
  am.applyResetCards(1, { fiveHour: [{ recordId: 2, expiresAt: soon(20 * DAY), expired: false }], weekly: [] });
  const withDisc = am._scoreAccount(c, {}, ctx);
  const noDisc = (() => { const saved = am.scheduler.resetBoostDiscount; am.scheduler.resetBoostDiscount = 0;
    const s = am._scoreAccount(c, {}, ctx); am.scheduler.resetBoostDiscount = saved; return s; })();
  assert.ok(withDisc < noDisc, 'control: the discount applies when NOT lifted');
});

test('lifted holder at 0.96 weekly is routable normal (capped/critical remapped)', () => {
  const am = makeAm();
  const a = am.accounts[0];
  a.quota.providerWk = 0.96; a.quota.providerWkReset = soon(3 * DAY);
  assert.equal(am._weeklyRawState(a), 'critical', 'control: without a cap the tier is critical');
  a.capUtilization = 0.75; a.capMode = 'fixed';
  assert.equal(am._weeklyRawState(a), 'capped', 'control: with the cap the tier is capped');
  am.applyResetCards(0, { weekly: [{ recordId: 1, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] });
  assert.equal(am._weeklyRawState(a), 'normal', 'with the card (lifted) the tier remaps to normal below the wall');
});

// ── judge #7: the routing discount reads the ONE shared scope answer ─────────
test('holdsUsableReset (judge #7): session-only and unmapped-scope grants earn NO discount; weekly-refilling ones do', () => {
  const mk = (name) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + H });
  const am = new AccountManager([mk('c1')], 0.9);
  const a = am.accounts[0];
  const grant = (o) => ({ id: 'g', usableNow: true, paused: false, resetsLeft: 1, endsAt: soon(30 * DAY), givesBackWeekly: false, ...o });
  am.applyResetGrants(0, { grants: [grant({ clears: ['five_hour'] })], eligible: true });
  assert.equal(am._holdsUsableReset(a), false, 'session-only grant: never claimed → no discount');
  am.applyResetGrants(0, { grants: [grant({ clears: ['mystery_limit'] })], eligible: true });
  assert.equal(am._holdsUsableReset(a), false, 'unmapped scope: never claimed → no discount');
  am.applyResetGrants(0, { grants: [grant({ clears: ['seven_day'] })], eligible: true });
  assert.equal(am._holdsUsableReset(a), true, 'general weekly grant counts');
  am.applyResetGrants(0, { grants: [grant({ clears: ['seven_day_overage_included'] })], eligible: true });
  assert.equal(am._holdsUsableReset(a), true, 'model-scoped weekly grant counts');
});
