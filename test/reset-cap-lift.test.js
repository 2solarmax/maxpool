// TEST PLAN 21-27 (success criteria 10, 6, 8): the D2 cap lift. A capped account
// holding a usable general-weekly reset runs to its weekly limit, the pool spends
// the reset there, the cap applies again afterwards. Hysteresis through listing
// failures, end-on-claim, give-back ceiling, both windows, GLM cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { decideClaude } from '../src/reset-policy.js';

const DAY = 86400_000;
const H = 3600_000;
const now = () => Date.now();

function cappedAm({ cap = 0.75, type = 'oauth', provider = undefined } = {}) {
  const acct = type === 'provider'
    ? { name: 'glm a', type: 'provider', provider, authToken: 'k', apiKey: 'k', credential: 'k' }
    : { name: 'claude a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 };
  const am = new AccountManager([acct, { ...acct, name: acct.name + '2' }], 0.9);
  for (const a of am.accounts) {
    a.capUtilization = cap;
    a.capMode = 'fixed';
  }
  return am;
}

const GEN_GRANT = () => ({ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: Date.now() + 30 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null });
const FABLE_GRANT = () => ({ ...GEN_GRANT(), id: 'f1', clears: ['seven_day_overage_included'] });
const GIVEBACK_GRANT = () => ({ ...GEN_GRANT(), id: 'gb1', clears: ['seven_day_overage_included'], givesBackWeekly: true });

function setUsage(a, { wk, ses, wkReset = 3 * DAY, sesReset = 3 * H, scoped = null }) {
  a.quota.unified7d = wk; a.quota.unified7dReset = Date.now() + wkReset;
  a.quota.unified5h = ses ?? 0.1; a.quota.unified5hReset = Date.now() + sesReset;
  a.quota.lastProbeOkAt = Date.now();
  if (scoped) a.quota.scopedWeekly = scoped;
}

// ── TEST 21: the lift suspends the cap; the claim fires at 0.99; cap returns ──
test('SC10: capped 0.75 + fresh seven_day grant → not capped, routable normal, claim at 0.99, capped returns after the claim', () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.93 });
  // Without the grant: capped.
  assert.equal(am._weeklyRawState(a), 'capped', 'control: the cap holds at 0.93/0.75');
  // With the grant: lifted.
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), true, 'the lift is active');
  assert.notEqual(am._weeklyRawState(a), 'capped', 'not capped while lifted');
  assert.equal(am._weeklyRawState(a), 'normal', 'routable at normal share (0.93 < 0.999 wall)');
  assert.equal(am._isSessionQuotaUnavailable(a), false, 'the session bench reads no cap either');
  // Climb to the claim point.
  setUsage(a, { wk: 0.995 });
  const act = decideClaude(a, a.resetGrants);
  assert.ok(act, 'the claim fires at 0.99');
  // Grant gone from a fresh listing after the claim → capped returns at 0.80.
  am.applyResetGrants(0, { grants: [], eligible: true });
  setUsage(a, { wk: 0.80 });
  assert.equal(am.capLiftActive(a), false, 'the lift ended (grant gone)');
  assert.equal(am._weeklyRawState(a), 'capped', 'capped returns at 0.80 over the 0.75 cap');
});

// ── TEST 22: grace through listing failures; negative control ─────────────────
test('SC10: the lift holds 10 min through listing failures, then ends; a fresh listing holds it', async () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.80 });
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), true);
  // The listing now FAILS for 30 minutes: the lift holds for 10 min of grace.
  const t0 = a.capLift.graceUntil;
  assert.ok(Number.isFinite(t0));
  // Simulate the clock passing the grace window: capLiftActive checks wall time.
  const realNow = Date.now;
  const shift = { ms: 0 };
  Date.now = () => realNow() + shift.ms;
  try {
    shift.ms = 9 * 60_000;
    assert.equal(am.capLiftActive(a, Date.now()), true, 'still lifted inside the 10-min grace');
    shift.ms = 11 * 60_000;
    assert.equal(am.capLiftActive(a, Date.now()), false, 'the lift ends after the grace window');
    assert.equal(am._weeklyRawState(a), 'capped', 'capped returns after grace');
  } finally { Date.now = realNow; }
  // Negative control: a fresh listing with a live grant keeps the lift.
  const am2 = cappedAm({ cap: 0.75 });
  const b = am2.accounts[0];
  setUsage(b, { wk: 0.80 });
  am2.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  const realNow2 = Date.now;
  Date.now = () => realNow2() + 25 * 60_000;
  try {
    // A REFRESHED listing re-arms the grace window each time.
    Date.now = realNow2;
    for (let i = 0; i < 5; i++) {
      am2.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
      Date.now = () => realNow2() + i * 5 * 60_000;
    }
    Date.now = () => realNow2() + 24 * 60_000;
    am2.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
    Date.now = () => realNow2() + 26 * 60_000;
    assert.equal(am2.capLiftActive(b, Date.now()), true, 'a live refreshed listing keeps the lift (negative control)');
  } finally { Date.now = realNow2; }
});

// ── TEST 23: hysteresis across fresh→stale→fresh at 60s cadence ───────────────
test('SC10: fresh→stale→fresh at 60s cadence = at most 2 state changes; no wkReset hold while lifted', () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.80 });
  const liftLogs = [];
  const realLog = console.log;
  console.log = m => { if (/cap lifted|cap restored/.test(m)) liftLogs.push(m); };
  try {
    for (let i = 0; i < 30; i++) {   // 30 minutes at 60s cadence
      const stale = i % 2 === 1;     // alternate fresh/stale listings
      if (stale) {
        // A FAILED listing marks the stored listing stale (keep-last-good) — the
        // grace window carries the lift.
        am.applyResetGrants(0, { error: 'HTTP 429' });
      } else {
        am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
      }
    }
  } finally { console.log = realLog; }
  assert.equal(am.capLiftActive(a), true, 'the lift survived the alternation');
  assert.ok(liftLogs.length <= 2, `at most lift+restore logs across the flap (got ${liftLogs.length}: ${liftLogs.join(' | ')})`);
  // The retry oracle never answers wkReset because of a cap while lifted.
  setUsage(a, { wk: 0.93 });
  const retry = am._retryInfo(a, null, Date.now());
  assert.notEqual(retry.cause, 'weekly_exhausted', 'no wkReset hold from the cap while lifted');
});

// ── TEST 24: a claim failure ends the lift ────────────────────────────────────
test('SC10: a claim failure while lifted applies the cap again on the next evaluation', async () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.995 });
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), true);
  am.endCapLift(0, 'claim failed');   // what _claimClaudeGrant does on a failed claim
  assert.equal(am.capLiftActive(a), false, 'the lift ended on the failed claim');
  setUsage(a, { wk: 0.80 });
  assert.equal(am._weeklyRawState(a), 'capped', 'the cap applies again');
});

// ── TEST 25: Fable-only and unmeasured give-back never lift; measured = cap+drop ─
test('SC10: Fable-only grant and unmeasured give-back grant NEVER lift; measured drop lifts to cap+drop', () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.80 });
  am.applyResetGrants(0, { grants: [FABLE_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), false, 'model-only reset never lifts the cap');
  am.applyResetGrants(0, { grants: [GIVEBACK_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), false, 'give-back without a measured drop never lifts (pre-mortem #7)');
  // One measured claim records giveBack.drop 0.2 → the ceiling is 0.95.
  a.giveBack = { drop: 0.2, at: Date.now() };
  am.applyResetGrants(0, { grants: [GIVEBACK_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), true, 'measured drop lifts');
  setUsage(a, { wk: 0.90 });
  assert.equal(am._weeklyRawState(a), 'normal', '0.90 under the 0.95 ceiling → not capped');
  setUsage(a, { wk: 0.96 });
  assert.equal(am._weeklyRawState(a), 'capped', '0.96 above the cap+drop ceiling → capped again');
});

// ── TEST 26: the lift suspends BOTH windows + the GLM max(ses,wk) cap ─────────
test('SC10: (a) Claude ses 0.80 over a 0.75 cap is not session-benched while lifted; (b) GLM capped 0.60 climbs past it and the card redeems at 0.90', async () => {
  // (a) Claude
  const am = cappedAm({ cap: 0.75, type: 'oauth' });
  const claude = am.accounts[0];
  setUsage(claude, { wk: 0.60, ses: 0.80 });
  assert.equal(am._isSessionQuotaUnavailable(claude), true, 'control: the session cap bench holds at ses 0.80');
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am._isSessionQuotaUnavailable(claude), false, 'the session bench reads no cap while lifted');

  // (b) GLM: cap 0.60 on max(ses,wk); a usable weekly card lifts; wk climbs to the 0.90 wall.
  const glm = cappedAm({ cap: 0.60, type: 'provider', provider: 'zai' });
  const g = glm.accounts[0];
  g.quota.providerSes = 0.30; g.quota.providerSesReset = Date.now() + 3 * H;
  g.quota.providerWk = 0.62; g.quota.providerWkReset = Date.now() + 5 * DAY;
  g.quota.weeklyAbsent = false;
  assert.equal(glm._weeklyRawState(g), 'capped', 'control: the GLM cap holds at wk 0.62 over 0.60');
  glm.applyResetCards(0, { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 20 * DAY, expired: false }], fiveHour: [] });
  assert.equal(glm.capLiftActive(g), true, 'a z.ai weekly card lifts the provider cap');
  assert.notEqual(glm._weeklyRawState(g), 'capped', 'routable past 0.60 while lifted');
  // climbs to the wall → decideZai redeems at 0.90
  g.quota.providerWk = 0.91;
  const { decideZai } = await import('../src/reset-policy.js');
  const act = decideZai(g, glm.accounts[0].resetCards);
  assert.equal(act?.card?.recordId, 9, 'the card redeems at the 0.90 wall');
});

// ── C3 start-gates: dead/benched accounts never lift ──────────────────────────
test('SC8: refreshDead / poolBenchedBy / disabled accounts never start the lift', () => {
  const am = cappedAm({ cap: 0.75 });
  const a = am.accounts[0];
  setUsage(a, { wk: 0.80 });
  a.refreshDead = true;
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), false, 'refreshDead never lifts');
  a.refreshDead = false;
  a.poolBenchedBy = 'cloud';
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), false, 'a pool-benched duplicate never lifts');
  a.poolBenchedBy = null;
  a.enabled = false;
  am.applyResetGrants(0, { grants: [GEN_GRANT()], eligible: true });
  assert.equal(am.capLiftActive(a), false, 'a disabled account never lifts');
});

// ── an uncapped account holding a grant does not "lift" (nothing to lift) ─────
test('an uncapped account with a grant stays ordinary (no lift state, no log)', () => {
  const am = cappedAm({ cap: 0.75 });
  const b = am.accounts[1];
  b.capUtilization = null;   // uncapped
  setUsage(b, { wk: 0.5 });
  const logs = [];
  const realLog = console.log;
  console.log = m => logs.push(m);
  try { am.applyResetGrants(1, { grants: [GEN_GRANT()], eligible: true }); }
  finally { console.log = realLog; }
  assert.equal(am.capLiftActive(b), false);
  assert.equal(logs.filter(l => /cap lifted/.test(l)).length, 0, 'no lift log for an uncapped account');
});
