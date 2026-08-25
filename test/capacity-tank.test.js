// TANK — capacity, not delivery (owner-directed 2026-08-25).
//
// "If X tokens is Y% of the limit, the limit is X/Y." The delivered-token columns that
// shipped first answer a DIFFERENT question (how much did this account move?), so an
// account that simply went unused looked small. These pin the capacity math itself:
// the division, the rounding-noise guard, the exact-vs-lower-bound call, and the fact
// that a reading is captured at EVERY close path rather than only the tidy one.

import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger } from '../src/capacity-ledger.js';
import { AccountManager } from '../src/account-manager.js';

const FIVE_H = 5 * 3600_000;

function ledgerWithCycle({ tokens, util, name = 'a', window = 'ses', fromStart = true }) {
  const l = new CapacityLedger();
  const start = Date.now() - FIVE_H;
  l.accrue(name, { input: tokens, output: 0 }, start);
  const open = l.openCycle(name, window);
  // windowStartedAt is what separates an EXACT tank (we watched the whole window) from
  // a lower bound (we joined late and the vendor's % counts spend we never saw).
  open.windowStartedAt = fromStart ? start : start - 3 * 3600_000;
  l.closeCycle(name, window, Date.now(), { resetAt: Date.now(), finalUtilization: util });
  return l;
}

// ── the division itself ──────────────────────────────────────────────────────

test('T1: tank = tokens ÷ utilization — the owner\'s formula, not tokens × anything', () => {
  // 800k delivered at 80% full ⇒ a 1.0M tank. An implementation that multiplies gives
  // 640k, which is LOWER than what was already delivered — the absurdity this pins.
  const l = ledgerWithCycle({ tokens: 800_000, util: 0.8 });
  const t = l.tankStats('a', 'ses');
  assert.equal(t.avg, 1_000_000);
  assert.equal(t.last, 1_000_000);
  assert.ok(t.avg > 800_000, 'a tank can never be smaller than what was delivered into it');
});

test('T1b: the 99%-full case the owner named — Kimi-style, near-exact', () => {
  const l = ledgerWithCycle({ tokens: 990_000, util: 0.99 });
  assert.equal(l.tankStats('a', 'ses').avg, 1_000_000);
});

test('T1c: tank averages ACROSS cycles, each divided by its own utilization', () => {
  // Two cycles that delivered wildly different amounts but describe the same plan:
  // 300k@30% and 900k@90% are both a 1.0M tank. A delivered-token average would say
  // 600k — the exact conflation of demand with capacity this replaces.
  const l = new CapacityLedger();
  for (const [tok, util, i] of [[300_000, 0.3, 2], [900_000, 0.9, 1]]) {
    const b = Date.now() - i * FIVE_H;
    l.accrue('a', { input: tok, output: 0 }, b - FIVE_H);
    l.openCycle('a', 'ses').windowStartedAt = b - FIVE_H;
    l.closeCycle('a', 'ses', b, { resetAt: b, finalUtilization: util });
  }
  const t = l.tankStats('a', 'ses');
  assert.equal(t.n, 2);
  assert.equal(t.avg, 1_000_000, 'both cycles say 1.0M despite 3x different delivery');
  assert.notEqual(t.avg, 600_000, 'never the average of the DELIVERED tokens');
});

test('T1d: `last` is the MOST RECENT cycle\'s tank, distinct from the average', () => {
  // Two cycles describing DIFFERENT tanks — a plan change, or a vendor limit move.
  // last must track the newest observation; if it silently returns the average, a plan
  // upgrade takes many cycles to show and the page misreports the current limit.
  const l = new CapacityLedger();
  for (const [tok, util, i] of [[500_000, 0.5, 2], [600_000, 0.3, 1]]) {   // 1.0M then 2.0M
    const b = Date.now() - i * FIVE_H;
    l.accrue('a', { input: tok, output: 0 }, b - FIVE_H);
    l.openCycle('a', 'ses').windowStartedAt = b - FIVE_H;
    l.closeCycle('a', 'ses', b, { resetAt: b, finalUtilization: util });
  }
  const t = l.tankStats('a', 'ses');
  assert.equal(t.last, 2_000_000, 'the newest cycle: 600k ÷ 0.3');
  assert.equal(t.avg, 1_500_000, 'the average of 1.0M and 2.0M');
  assert.notEqual(t.last, t.avg, 'last must not silently be the average');
});

// ── the rounding-noise guard ─────────────────────────────────────────────────

test('T2: a cycle closing under 5% full is EXCLUDED — vendor whole-percent rounding', () => {
  // 40k at a reported 4% implies 1.0M; if the true value was 3% (same rounded display)
  // it implies 1.33M. A third of the answer would be rounding, so it is not averaged in.
  const l = ledgerWithCycle({ tokens: 40_000, util: 0.04 });
  assert.equal(l.tankStats('a', 'ses'), null, 'no tank from a rounding-dominated reading');
});

test('T2b: 5% and above IS counted — the guard excludes noise, not data', () => {
  const l = ledgerWithCycle({ tokens: 50_000, util: 0.05 });
  const t = l.tankStats('a', 'ses');
  assert.ok(t, 'a 5% reading is usable');
  assert.equal(t.avg, 1_000_000);
});

test('T2c: a mixed history keeps the usable cycles and drops only the noisy one', () => {
  const l = new CapacityLedger();
  for (const [tok, util, i] of [[20_000, 0.02, 3], [500_000, 0.5, 2], [700_000, 0.7, 1]]) {
    const b = Date.now() - i * FIVE_H;
    l.accrue('a', { input: tok, output: 0 }, b - FIVE_H);
    l.openCycle('a', 'ses').windowStartedAt = b - FIVE_H;
    l.closeCycle('a', 'ses', b, { resetAt: b, finalUtilization: util });
  }
  const t = l.tankStats('a', 'ses');
  assert.equal(t.n, 2, 'the 2%-full cycle is excluded, the other two counted');
  assert.equal(t.avg, 1_000_000);
});

// ── exact vs lower bound ─────────────────────────────────────────────────────

test('T4: a window watched from its START yields an EXACT tank', () => {
  const l = ledgerWithCycle({ tokens: 800_000, util: 0.8, fromStart: true });
  const t = l.tankStats('a', 'ses');
  assert.equal(t.exact, 1);
  assert.equal(t.bounded, 0);
  assert.equal(t.lowerBound, false, 'no ≥ marker when we saw the whole window');
});

test('T4b: a window JOINED LATE is a lower bound — the vendor % counts spend we missed', () => {
  const l = ledgerWithCycle({ tokens: 800_000, util: 0.8, fromStart: false });
  const t = l.tankStats('a', 'ses');
  assert.equal(t.bounded, 1);
  assert.equal(t.exact, 0);
  assert.equal(t.lowerBound, true, 'flagged so the UI renders ≥, never a bare number');
});

// ── capture at every close path ──────────────────────────────────────────────

function amWith(account) {
  const am = new AccountManager([account], 0.9);
  am.capacity._readFloorOverride = { ses: 0, wk: 0 };
  return am;
}

test('T5: the quota-CLEAR path captures the reading before nulling it', () => {
  // _clearExpiredQuotas is the authoritative OAuth rollover. It nulls unified5h right
  // after closing, so a close that does not snapshot the reading loses it forever —
  // and every tank would then silently fall back to the live estimate.
  const am = amWith({ name: 'c1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });
  const b = Date.now() - 1000;
  am.capacity.accrue('c1', { input: 900_000, output: 0 }, b - FIVE_H);
  am.capacity.openCycle('c1', 'ses').windowStartedAt = b - FIVE_H;
  am.accounts[0].quota.unified5h = 0.9;
  am.accounts[0].quota.unified5hReset = b;
  am.refreshExpiredQuotas();                       // → _clearExpiredQuotas
  assert.equal(am.accounts[0].quota.unified5h, null, 'the reading was nulled by the rollover');
  const t = am.capacity.tankStats('c1', 'ses');
  assert.ok(t, 'but the cycle kept it');
  assert.equal(t.avg, 1_000_000, '900k ÷ 0.9');
});

test('T5b: the CLOCK-sweep path captures the reading too', () => {
  const am = amWith({ name: 'g1', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] });
  const b = Date.now() - 1000;
  am.capacity.accrue('g1', { input: 600_000, output: 0 }, b - FIVE_H);
  am.capacity.openCycle('g1', 'ses').windowStartedAt = b - FIVE_H;
  am.accounts[0].quota.providerSes = 0.6;
  am.accounts[0].quota.providerSesReset = b;
  am.closeExpiredCapacityCycles();
  const t = am.capacity.tankStats('g1', 'ses');
  assert.ok(t, 'the sweep close recorded a reading');
  assert.equal(t.avg, 1_000_000, '600k ÷ 0.6');
});

test('T5c: the STAMP-ADVANCE path uses the OLD window\'s reading, never the new one', () => {
  // The probe writes the new window's utilization into the quota fields, THEN notices
  // the advance. Re-reading the field there would divide the old window's tokens by the
  // NEW window's percentage — wrong on exactly the rollover this path exists to catch.
  const am = amWith({ name: 'g2', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] });
  // The advance guard needs a real window move (>60s jitter epsilon), so the old
  // window's reset must be genuinely in the past — not one second ago.
  const oldReset = Date.now() - 10 * 60_000;
  am.capacity.accrue('g2', { input: 800_000, output: 0 }, oldReset - FIVE_H);
  am.capacity.openCycle('g2', 'ses').windowStartedAt = oldReset - FIVE_H;
  am.accounts[0].quota.providerSesReset = oldReset;
  am.accounts[0].quota.providerSes = 0.8;                       // the CLOSING window: 80%
  // A probe arrives reporting the NEW window: 2% full, resetting 5h out.
  am.applyProviderUsage(0, { source: 'zai', ses: { utilization: 0.02, resetAt: Date.now() + FIVE_H } });
  const t = am.capacity.tankStats('g2', 'ses');
  assert.ok(t, 'the advance closed a cycle with a reading');
  assert.equal(t.avg, 1_000_000, '800k ÷ 0.80 (the old window) — NOT ÷ 0.02 = 40M');
  assert.notEqual(t.avg, 40_000_000, 'never the new window\'s percentage');
});

// ── the manager-level accessor the UI reads ──────────────────────────────────

test('T6: capacityTank prefers measured cycles and falls back to the live window', () => {
  const am = amWith({ name: 'c2', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });
  am.accrueCapacity(0, { input: 100_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.1;
  am.capacity.noteUtilizationObserved();
  const live = am.capacityTank(0, 'ses');
  assert.equal(live.source, 'live', 'no closed cycle yet → the OPEN window still answers');
  assert.equal(live.avg, 1_000_000, '100k ÷ 10% — the number exists from minute one');

  // now close a real cycle; the measured tank must take over
  const b = Date.now() - 1000;
  am.capacity.accrue('c2', { input: 400_000, output: 0 }, b - FIVE_H);
  am.capacity.openCycle('c2', 'ses').windowStartedAt = b - FIVE_H;
  am.accounts[0].quota.unified5hReset = b;
  am.accounts[0].quota.unified5h = 0.5;
  am.refreshExpiredQuotas();
  const measured = am.capacityTank(0, 'ses');
  assert.equal(measured.source, 'cycles', 'a completed cycle outranks the live estimate');
  assert.ok(measured.avg > 0);
});

test('T7: the LIVE estimate obeys the same rounding floor as closed cycles', () => {
  // A 1%-full open window read "≥45M" on the live page (2026-08-25): the closed-cycle
  // guard existed, the live fallback lacked it. Both must share TANK_MIN_UTIL.
  const am = amWith({ name: 'c3', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 });
  am.accrueCapacity(0, { input: 455_000, output: 0 });
  am.accounts[0].quota.unified5h = 0.01;
  am.capacity.noteUtilizationObserved();
  assert.equal(am.capacityTank(0, 'ses'), null, 'no tank from a 1% reading');
  am.accounts[0].quota.unified5h = 0.05;
  am.capacity.noteUtilizationObserved();
  const t = am.capacityTank(0, 'ses');
  assert.ok(t, 'a 5% reading is usable');
  assert.equal(t.avg, 9_100_000, '455k ÷ 0.05');
});
