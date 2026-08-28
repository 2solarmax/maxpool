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
  // equilibrium lands near 1/mult (~1.9x at mult 0.529); the steep past-D floor
  // and the hard gates keep it from starving anyone. Pre-fix: parity (1.05x).
  const { am, now } = pair();
  const picks = simulate(am, now, 3000);
  const ratio = picks['glm-unl'] / picks['glm-wk'];
  assert.ok(ratio > 1.5, `unlimited should run meaningfully hotter, got ${ratio.toFixed(2)}x`);
  assert.ok(ratio < 3.5, `but never starve the sibling, got ${ratio.toFixed(2)}x`);
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
  // the window where fast-refill was already acting.
  const { am, u, w, now } = pair({ unlSes: 0.65 });
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
  am.scheduler.fastRefillDiscount = 0;
  const ctx = equalShare(am, now);
  assert.equal(am._fastRefillMultiplier(u), 1);
  const su = am._scoreAccount(u, { weight: 1 }, ctx);
  const sw = am._scoreAccount(w, { weight: 1 }, ctx);
  // Both pay full spread; only the real quota difference separates them.
  assert.ok(sw - su < 0.5, `feature off → no spread-sized gap, got ${(sw - su).toFixed(3)}`);
});
