// FAST-REFILL vs THE SPREAD EQUALISER (owner option 1, 2026-08-29).
//
// The 2026-08-25 fast-refill discount touched utilization + pace only. Those are
// SMALL terms; `spread` — an account's share of recent fleet load — is the big one,
// and it exists to pull everybody back to parity. Measured on the real fleet at
// converged equal share: spread contributed 1.500 to BOTH accounts while the whole
// discount bought a 0.152 gap, so the unlimited account settled at ~52/48 — parity.
// The owner saw the consequence: a weekly-limited sibling burned to wk 100% while
// the no-weekly-limit account, whose window refills 33.6x a week, sat "barely used".
//
// These pin the fix and, more importantly, the SHAPE of it: a discount that decays,
// never a bonus; balancing terms only, never safety ones; and byte-identical to the
// old behaviour wherever the multiplier is 1.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const provider = (name, extra = {}) => ({
  name, type: 'provider', provider: 'zai', authToken: 'z',
  upstream: 'https://z', profiles: ['all'], ...extra,
});

/** Two z.ai siblings, identical except one has NO weekly window. */
function pair({ unlSes = 0.10, wkSes = 0.10, wkWeekly = 0.45 } = {}) {
  const am = new AccountManager(
    [provider('glm-unl'), provider('glm-wk')],
    0.90,
    { routingMode: 'balance' },
  );
  const [u, w] = am.accounts;
  const now = Date.now();
  u.quota.providerSes = unlSes;
  u.quota.weeklyAbsent = true;
  u.quota.providerSesReset = now + 4 * 3600_000;
  w.quota.providerSes = wkSes;
  w.quota.providerWk = wkWeekly;
  w.quota.providerSesReset = now + 4 * 3600_000;
  w.quota.providerWkReset = now + 3 * 86400_000;
  return { am, u, w, now };
}

/** Give every account the SAME recent load — the converged state the balancer
 *  drives toward, and the exact state in which the old discount washed out. */
function equalShare(am, now, weightEach = 1000) {
  for (const a of am.accounts) {
    a.loadEvents = [{ at: now - 60_000, weight: weightEach, success: true, durationMs: 1000 }];
  }
  return { now, fleetRecentWeight: weightEach * am.accounts.length };
}

/** Route N requests, feeding each pick back into the load window AND accruing
 *  in-flight weight like production does. The v1.18.0 mistake (2026-08-28 live
 *  measurement) was simulating without in-flight: live requests run 18-27s at
 *  weight 10-50, so in-flight — not spread — is the marginal price of traffic,
 *  and a simulation that never accrues it models an address production never
 *  reads. Here each request occupies its account for RTT_MS then releases;
 *  arrivals are paced so both accounts can be busy at once, which is the regime
 *  that actually sets the equilibrium share. */
function simulate(am, now, n = 2000, { rttMs = 20_000, arrivalMs = 5_000, w = 50 } = {}) {
  for (const a of am.accounts) { a.loadEvents = []; a.activeWeight = 0; }
  const picks = Object.fromEntries(am.accounts.map(a => [a.name, 0]));
  const queue = []; // {releaseAt, account, w}
  const flight = new Map(am.accounts.map(a => [a.name, 0]));
  for (let i = 0; i < n; i++) {
    const t = now + i * arrivalMs;
    while (queue.length && queue[0].releaseAt <= t) {
      const d = queue.shift();
      flight.set(d.account, Math.max(0, (flight.get(d.account) || 0) - d.w));
    }
    for (const a of am.accounts) a.activeWeight = flight.get(a.name) || 0;
    const fleetRecentWeight = am.accounts.reduce(
      (t2, a) => t2 + am._loadSummary(a, am.scheduler.spreadWindowMs, t).weight, 0);
    let best = null;
    for (const a of am.accounts) {
      const s = am._scoreAccount(a, { weight: w }, { now: t, fleetRecentWeight });
      if (!best || s < best.s) best = { a, s };
    }
    picks[best.a.name]++;
    flight.set(best.a.name, (flight.get(best.a.name) || 0) + w);
    best.a.loadEvents.push({ at: t, weight: w, success: true, durationMs: rttMs });
    queue.push({ releaseAt: t + rttMs, account: best.a.name, w });
    queue.sort((x, y) => x.releaseAt - y.releaseAt);
  }
  return picks;
}

// ── the defect the owner reported ────────────────────────────────────────────

test('S1: at EQUAL share the unlimited account is now meaningfully cheaper', () => {
  // Pre-fix this gap was 0.152 on a ~3.7 score — under 5%, which round-robin and
  // concurrency jitter swamp. The spread term is what makes it decisive.
  const { am, u, w, now } = pair();
  const ctx = equalShare(am, now);
  const su = am._scoreAccount(u, { weight: 1 }, ctx);
  const sw = am._scoreAccount(w, { weight: 1 }, ctx);
  assert.ok(su < sw, 'unlimited is cheaper');
  assert.ok(sw - su > 0.5, `gap must be decisive, got ${(sw - su).toFixed(3)}`);
});

test('S2: EQUILIBRIUM share with in-flight accrual — ~1/mult, no starvation', () => {
  // The real assertion of this change: not "cheaper for one request" but "settles
  // at a higher steady share" IN THE LIVE REGIME. With in-flight accrual the
  // marginal price of traffic to the discounted account is cost*mult, so
  // equilibrium lands near 1/mult. Since SOAK MODE (2026-09-26) the early-window
  // multiplier is ~0.2 (soakDiscount 0.9) so the equilibrium is ~5x, clamped by the
  // steep past-D floor; pre-soak it was ~1.9x (mult 0.529), pre-fast-refill parity.
  const { am, now } = pair();
  const picks = simulate(am, now, 3000);
  const ratio = picks['glm-unl'] / picks['glm-wk'];
  assert.ok(ratio > 2.5, `unlimited should run far hotter under soak, got ${ratio.toFixed(2)}x`);
  assert.ok(ratio < 12, `but never starve the sibling, got ${ratio.toFixed(2)}x`);
  assert.ok(picks['glm-wk'] > 400, 'the weekly-limited sibling still gets real traffic');
});

// ── the discount still DECAYS: preference is temporary, never structural ──────

test('S3: the preference fades as the fast window fills', () => {
  // Two points suffice under in-flight accrual: deep-in-the-window the
  // equilibrium is clamped by concurrency depth, so mid-window ratios sit at
  // the clamp and mid-vs-late monotonicity is unmeasurable there. Early vs
  // near-fade is the decision-grade signal, and S4 pins the exact fade point.
  const ratios = [];
  for (const ses of [0.05, 0.64]) {
    const { am, now } = pair({ unlSes: ses });
    const picks = simulate(am, now, 1200);
    ratios.push(picks['glm-unl'] / picks['glm-wk']);
  }
  assert.ok(ratios[0] > ratios[1], `fades with fullness: ${ratios.map(r => r.toFixed(2))}`);
});

test('S4: AT/ABOVE the fade point the spread term is byte-identical to pre-fix', () => {
  // multiplier is exactly 1 there, so `share * weight * 1 === share * weight`.
  // This is the invariant that makes the change safe: it can only ever act inside
  // the window where the preference was already acting. Since SOAK MODE the fade
  // point is soakFadeUtil (0.90), not fastRefillFadeUtil (0.65).
  const { am, u, w, now } = pair({ unlSes: 0.90 });
  const ctx = equalShare(am, now);
  assert.equal(am._fastRefillMultiplier(u), 1, 'discount fully faded at the fade point');
  const su = am._scoreAccount(u, { weight: 1 }, ctx);
  const sw = am._scoreAccount(w, { weight: 1 }, ctx);
  // Only the weekly-pace difference remains — the unlimited account has no weekly
  // window, so it is still slightly cheaper, but by the ORIGINAL margin, not a
  // spread-sized one.
  assert.ok(sw - su < 0.5, `no spread-sized preference past the fade point, got ${(sw - su).toFixed(3)}`);
});

// ── it is a DISCOUNT, not a bonus (the red team's original rejection) ─────────

test('S5: the spread contribution is never negative — a discount can only shrink it', () => {
  // The 2026-08-25 red team killed a flat -3 priority bonus because it drove the
  // total score negative, breaking the non-negative band structure the reserve /
  // critical costs are calibrated against. A multiplier in [0,1] cannot do that.
  for (const ses of [0, 0.1, 0.3, 0.64, 0.65, 0.9, 1]) {
    const { am, u, now } = pair({ unlSes: ses });
    const ctx = equalShare(am, now);
    const mult = am._fastRefillMultiplier(u);
    assert.ok(mult >= 0 && mult <= 1, `multiplier in [0,1] at ses=${ses}, got ${mult}`);
    assert.ok(am._scoreAccount(u, { weight: 1 }, ctx) >= 0, `score stays non-negative at ses=${ses}`);
  }
});

test('S6: a WEEKLY-LIMITED provider gets no spread discount at all', () => {
  // The whole justification is "this window refills 33.6x per week". An account
  // with a weekly cap does not have that property and must not get the preference.
  const { am, w, now } = pair();
  assert.equal(am._fastRefillMultiplier(w), 1);
  const ctx = equalShare(am, now);
  const withShare = am._scoreAccount(w, { weight: 1 }, ctx);
  w.loadEvents = [];
  const noShare = am._scoreAccount(w, { weight: 1 }, { ...ctx });
  // Its spread term is the undiscounted full 3 * share.
  assert.ok(Math.abs((withShare - noShare) - 0.5 * am.scheduler.spreadShareWeight) < 1e-9,
    'weekly-limited account pays full spread price');
});

test('S7: an OAuth (Claude) account is untouched — provider-only by construction', () => {
  const am = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
  ], 0.90, { routingMode: 'balance' });
  am.accounts[0].quota.unified5h = 0.1;
  assert.equal(am._fastRefillMultiplier(am.accounts[0]), 1);
});

// ── safety terms stay undiscounted ───────────────────────────────────────────

test('S8: in-flight terms carry the discount; the hard gate does not', () => {
  // v1.19.0 design (owner-approved outcome, 2026-08-29): in the live regime
  // in-flight IS the marginal price of traffic, so the linear term and the
  // past-D penalty carry the SAME multiplier as the other balancing terms.
  // What must NOT soften: the per-account hard request gate. It is a count of
  // concurrent requests (safetyMaxActivePerAccount), not a score — discounting
  // the score while the count gate holds means a discounted account can run at
  // most mult×fewer concurrent requests before REFUSAL, never a 429 dogpile.
  const { am, u, now } = pair();
  const ctx = equalShare(am, now);
  const mult = am._fastRefillMultiplier(u);
  assert.ok(mult < 1, 'fixture must be inside the discount window');
  const base = am._scoreAccount(u, { weight: 1 }, ctx);
  u.activeWeight = 1;
  const withOne = am._scoreAccount(u, { weight: 1 }, ctx);
  // Linear term: one unit of in-flight adds exactly concurrencyWeight * mult.
  assert.ok(Math.abs((withOne - base) - am.scheduler.concurrencyWeight * mult) < 1e-9,
    `one extra in-flight costs concurrencyWeight*mult = ${(am.scheduler.concurrencyWeight * mult).toFixed(3)}, got ${(withOne - base).toFixed(3)}`);
  // Past-D penalty: also discounted, but its marginal cost stays well above any
  // balancing term — the anti-dogpile floor keeps its ranking even discounted.
  u.activeWeight = 10;
  const deep = am._scoreAccount(u, { weight: 1 }, ctx);
  const marginalPastD = (deep - withOne) / 9;
  assert.ok(marginalPastD >= am.scheduler.concurrencyWeight * mult - 1e-9,
    `marginal in-flight cost never falls below the discounted linear rate (got ${marginalPastD.toFixed(3)})`);
  // And the HARD gate is a count, not a score — an account can never route past it.
  assert.equal(am.scheduler.safetyMaxActivePerAccount, 50, 'hard per-account request gate exists');
});

test('S9: a capped unlimited account is still BENCHED — the discount never buys past a cap', () => {
  // Interaction with v1.15.0: cheapness is a score, the cap is a gate. The gate wins.
  const { am, u, now } = pair({ unlSes: 0.10 });
  u.capUtilization = 0.05;                       // already over its reservation
  assert.equal(am._isSessionQuotaUnavailable(u), true, 'benched by the cap');
  assert.equal(am._isAvailable(u), false, 'and unavailable, however cheap it scores');
  void now;
});

// ── the feature switch ───────────────────────────────────────────────────────

test('S10: fastRefillDiscount = 0 restores exact pre-2026-08-25 scoring', () => {
  const { am, u, w, now } = pair();
  // (post-soak: the weeklyAbsent account reads soakDiscount, so turning THIS knob
  // off must also neutralize soak — K6 pins the soak knob itself)
  am.scheduler.soakDiscount = 0;
  am.scheduler.fastRefillDiscount = 0;
  const ctx = equalShare(am, now);
  assert.equal(am._fastRefillMultiplier(u), 1);
  const su = am._scoreAccount(u, { weight: 1 }, ctx);
  const sw = am._scoreAccount(w, { weight: 1 }, ctx);
  // Both pay full spread; only the real quota difference separates them.
  assert.ok(sw - su < 0.5, `feature off → no spread-sized gap, got ${(sw - su).toFixed(3)}`);
});

// ── SOAK MODE (owner-directed 2026-09-26) ────────────────────────────────────
// "This account has no weekly limit — send as many requests as possible to it, the
// only thing to watch is the session limit, which resets fast anyway."
// Measured before this change: the no-weekly account took 50 of 162 GLM requests
// (~31%) — near parity, because fastRefill's 0.6 discount faded out at ses 0.65 and
// the spread term pulled it back to the fleet mean. Soak escalates the same mechanism
// (0.9 discount, fade at 0.9) so it is the DEFAULT route until its window is nearly
// full, while every hard gate stays exactly where it was.

test('K1: soak mode is ON BY DEFAULT for a weekly-less account (no config needed)', () => {
  const { am, u } = pair({ unlSes: 0.10 });
  assert.equal(am.scheduler.soakDiscount, 0.9, 'default soak discount ships enabled');
  const mult = am._fastRefillMultiplier(u);
  // 1 - 0.9*(1 - 0.10/0.9) = 1 - 0.9*0.889 = 0.2
  assert.ok(Math.abs(mult - 0.2) < 0.01, `expected ~0.2 early-window multiplier, got ${mult.toFixed(3)}`);
});

test('K2: soak is MUCH stronger than the old fast-refill preference at the same utilization', () => {
  const { am, u } = pair({ unlSes: 0.10 });
  const soakMult = am._fastRefillMultiplier(u);
  // Recreate the pre-soak behaviour by pointing the knobs back at the old values.
  am.scheduler.soakDiscount = am.scheduler.fastRefillDiscount;   // 0.6
  am.scheduler.soakFadeUtil = am.scheduler.fastRefillFadeUtil;   // 0.65
  const oldMult = am._fastRefillMultiplier(u);
  assert.ok(soakMult < oldMult,
    `soak must prefer the account more strongly than fast-refill did (${soakMult.toFixed(3)} vs ${oldMult.toFixed(3)})`);
});

test('K3: a weekly-LIMITED sibling is never soaked — the preference is weekly-less only', () => {
  const { am, w } = pair();
  assert.equal(am._fastRefillMultiplier(w), 1, 'a weekly-limited account scores undiscounted');
});

test('K4: the preference holds nearly to the top of the session window, then reaches parity', () => {
  const { am, u } = pair();
  const at = (ses) => { u.quota.providerSes = ses; return am._fastRefillMultiplier(u); };
  assert.ok(at(0.50) < 0.7, 'still strongly preferred at half a window');
  assert.ok(at(0.80) < 1, 'still preferred at 80% — the old design had already faded out here');
  assert.equal(at(0.90), 1, 'exact parity at the fade point');
  assert.equal(at(0.99), 1, 'and above it');
});

test('K5: soaking never routes past a HARD gate — session bench, cap and request cap all hold', () => {
  const { am, u } = pair({ unlSes: 0.10 });
  // The session window is the ONLY thing bounding a soak, so it must still bench.
  u.quota.providerSes = 0.99;
  assert.equal(am._isSessionQuotaUnavailable(u), true,
    'a full session window benches the account no matter how cheap soak makes it score');
  // A usage cap still wins over cheapness.
  u.quota.providerSes = 0.10;
  u.capUtilization = 0.05;
  u.capMode = 'fixed';
  assert.equal(am._isAvailable(u), false, 'an owner cap outranks soak');
  // And the hard per-account in-flight gate is a count, not a score.
  assert.equal(am.scheduler.safetyMaxActivePerAccount, 50, 'hard request gate unchanged');
});

test('K6: soakDiscount = 0 turns the feature off and restores fast-refill exactly', () => {
  const { am, u } = pair({ unlSes: 0.10 });
  am.scheduler.soakDiscount = 0;
  assert.equal(am._fastRefillMultiplier(u), 1, 'feature off → undiscounted');
});

test('K7: soak shows up where it matters — the account WINS the score against a healthy sibling', () => {
  const { am, u, w, now } = pair({ unlSes: 0.10, wkSes: 0.10, wkWeekly: 0.45 });
  const ctx = equalShare(am, now);
  const su = am._scoreAccount(u, { weight: 1 }, ctx);
  const sw = am._scoreAccount(w, { weight: 1 }, ctx);
  assert.ok(su < sw, `the weekly-less account must score cheaper (soak ${su.toFixed(3)} vs sibling ${sw.toFixed(3)})`);
  // And by a wide margin — this is the "as many requests as possible" intent, not a nudge.
  assert.ok(sw - su > 1, `the margin must be decisive, got ${(sw - su).toFixed(3)}`);
});


test('K8: soak NEVER starves the weekly-limited sibling — the safety floor holds', () => {
  // The exact defect the first soak implementation shipped with: soakDiscount 0.9
  // also weakened the past-D in-flight floor, and the production-shaped simulation
  // gave the unlimited account EVERY pick (ratio Infinity, sibling starved). The floor
  // now clamps at fast-refill's 0.6, so soak changes WHERE traffic goes at equal
  // depth, not how deep one account may stack.
  const { am, now } = pair();
  const picks = simulate(am, now, 3000);
  const ratio = picks['glm-unl'] / picks['glm-wk'];
  assert.ok(Number.isFinite(ratio), `sibling must not be starved, got ${ratio}`);
  assert.ok(picks['glm-wk'] > 400, `the weekly-limited sibling still gets real traffic (${picks['glm-wk']})`);
});
