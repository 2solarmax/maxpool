import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function makeAm(opts = {}) {
  const mk = (name) => ({
    name, type: 'provider', provider: 'zai', enabled: true,
    profiles: ['all'], apiKey: 'k',
  });
  const am = new AccountManager([mk('unltd'), mk('limited')], 0.9, {
    // The DEFAULT_PEAK_PROVIDERS windows are injected by the config layer
    // (config.js + loadConfig migration), NOT by DEFAULT_SCHEDULER — documented in
    // the 2026-08-18 peak task research. A bare AccountManager has no windows, so
    // the peak tier is inert unless the test injects them like config.js does.
    providers: {
      zai: {
        peakTimezone: 'Asia/Singapore',
        peakWindows: [{ days: [1, 2, 3, 4, 5], startMin: 14 * 60, endMin: 18 * 60 }],
      },
    },
    ...opts,
  });
  // Production wires quota through restoreQuotaState (restart) / applyProviderUsage
  // (probe) — the constructor always starts from emptyQuota(). Use the real path.
  am.restoreQuotaState([
    { name: 'unltd', accountUuid: null, quota: { weeklyAbsent: true, providerSes: 0.17, providerWk: null, providerSesReset: Date.now() + 3 * 3600_000 } },
    { name: 'limited', accountUuid: null, quota: { weeklyAbsent: false, providerSes: 0.10, providerWk: 0.5, providerSesReset: Date.now() + 3 * 3600_000, providerWkReset: Date.now() + 3 * 24 * 3600_000 } },
  ]);
  return am;
}

// ---------- _fastRefillMultiplier ----------

test('multiplier: full discount at 0% session, decays linearly, gone at fade point', () => {
  // Since SOAK MODE (2026-09-26) a weeklyAbsent fixture reads soakDiscount/soakFadeUtil
  // (0.9/0.9) — the fast-refill path is pinned with soak neutralized to its old knobs.
  const am = makeAm();
  const unltd = am.accounts[0];
  am.scheduler.soakDiscount = am.scheduler.fastRefillDiscount; // 0.6
  am.scheduler.soakFadeUtil = am.scheduler.fastRefillFadeUtil; // 0.65
  const disc = 0.6, fade = 0.65;
  unltd.quota.providerSes = 0;
  assert.equal(am._fastRefillMultiplier(unltd), 1 - disc);
  unltd.quota.providerSes = fade / 2;
  assert.equal(am._fastRefillMultiplier(unltd), 1 - disc / 2);
  unltd.quota.providerSes = fade;
  assert.equal(am._fastRefillMultiplier(unltd), 1);
  unltd.quota.providerSes = 0.99;
  assert.equal(am._fastRefillMultiplier(unltd), 1);
});

test('multiplier: NOT applied to weekly-limited providers or Claude accounts', () => {
  const am = makeAm();
  assert.equal(am._fastRefillMultiplier(am.accounts[1]), 1); // limited zai
  const claude = { type: 'oauth', quota: { weeklyAbsent: true, unified5h: 0.1 } };
  assert.equal(am._fastRefillMultiplier(claude), 1); // not a provider
});

test('multiplier: feature off (discount 0) returns exactly 1', () => {
  // soakDiscount is the weeklyAbsent off-switch now — both off for a clean 1.
  const am = makeAm({ fastRefillDiscount: 0 });
  am.scheduler.soakDiscount = 0;
  assert.equal(am._fastRefillMultiplier(am.accounts[0]), 1);
});

// ---------- score composition ----------

test('score: the discount only removes cost — total stays ≥ the discounted in-flight floor, never negative', () => {
  // v1.19.0 (2026-08-29): in-flight terms carry the discount too, so the floor is
  // the DISCOUNTED in-flight cost. What stays inviolate: the total is never
  // negative, and past the fade point (mult 1) the floor is the old full one.
  const am = makeAm();
  const unltd = am.accounts[0];
  const ctx = am._scoringContext();
  for (const ses of [0, 0.1, 0.3, 0.6, 0.64, 0.65]) {
    unltd.quota.providerSes = ses;
    const mult = am._fastRefillMultiplier(unltd);
    const s = am._scoreAccount(unltd, {}, ctx);
    const floor = (unltd.activeWeight + 1) * am.scheduler.concurrencyWeight * mult;
    assert.ok(s >= floor - 1e-9,
      `ses=${ses}: score ${s} dipped below the discounted in-flight floor ${floor}`);
    assert.ok(s >= 0, `ses=${ses}: score ${s} is negative`);
  }
});

test('score: off-peak head-to-head — idle unltd beats idle limited', () => {
  const am = makeAm();
  const ctx = am._scoringContext();
  const sUnltd = am._scoreAccount(am.accounts[0], {}, ctx);
  const sLtd = am._scoreAccount(am.accounts[1], {}, ctx);
  assert.ok(sUnltd < sLtd, `unltd ${sUnltd} should beat limited ${sLtd} at similar util`);
});

test('score: the win dies as the fast window fills (convergence, not a cliff)', () => {
  const am = makeAm();
  const ctx = am._scoringContext();
  const [unltd, ltd] = am.accounts;
  unltd.quota.providerSes = 0.6; // just under fade 0.65 → discount ~4.6%
  const s1 = am._scoreAccount(unltd, {}, ctx);
  const s2 = am._scoreAccount(ltd, {}, ctx);
  // At 60% vs 10% util the raw utilization gap (0.5×3×mult) still dominates →
  // limited wins. The discount must NOT rescue a filling window.
  assert.ok(s2 < s1, `limited ${s2} should win once the unltd window fills (got unltd ${s1})`);
});

test('score: in-flight burst cost scales by mult for unltd, full for limited', () => {
  // v1.19.0: the in-flight terms carry the discount, so the discounted account's
  // burst cost is exactly mult× the limited account's (same util) at every depth
  // — a proportional softening, never more (no flat bonus leaking in).
  const am = makeAm();
  // post-soak: use the OLD knob values so this proportionality pin stays about
  // fast-refill's shape (soak's stronger values are pinned in fast-refill-spread K*)
  am.scheduler.soakDiscount = am.scheduler.fastRefillDiscount;
  am.scheduler.soakFadeUtil = am.scheduler.fastRefillFadeUtil;
  const unltd = am.accounts[0];
  const ctx = am._scoringContext();
  const mult = am._fastRefillMultiplier(unltd);
  assert.ok(mult > 0 && mult < 1, 'fixture must be inside the discount window');
  const before = am._scoreAccount(unltd, {}, ctx);
  unltd.activeWeight = 5; // deep burst
  const after = am._scoreAccount(unltd, {}, ctx);
  const ltd = am.accounts[1];
  ltd.quota.providerSes = unltd.quota.providerSes; // same util for parity
  const ltdBefore = am._scoreAccount(ltd, {}, ctx);
  ltd.activeWeight = 5;
  const ltdAfter = am._scoreAccount(ltd, {}, ctx);
  const dUnltd = after - before;
  const dLtd = ltdAfter - ltdBefore;
  assert.ok(Math.abs(dUnltd - dLtd * mult) < 1e-6,
    `unltd burst cost must equal mult×ltd (${dUnltd} vs ${dLtd * mult})`);
});

test('score: BOTH balancing terms carry the discount (pace, not just utilization)', () => {
  // The pace term is only non-zero when the account is AHEAD of an even burn — a
  // fresh window at low util has pace 0, so a test built on the default fixture
  // cannot see whether paceCost was discounted at all (mutation M6 survived one).
  // Force a real pace overage: 45% used with the window just opened.
  const am = makeAm();
  const unltd = am.accounts[0];
  const now = Date.now();
  unltd.quota.providerSes = 0.45;
  unltd.quota.providerSesReset = now + 4.5 * 3600_000; // ~10% elapsed → overage ~0.35
  const pace = am._accountScarcity(unltd, now);
  assert.ok(pace > 0.2, `fixture must have a real pace overage (got ${pace})`);

  const mult = am._fastRefillMultiplier(unltd);
  assert.ok(mult < 1, 'discount is live at ses 0.45');

  const ctx = { now, fleetRecentWeight: 0 };
  const actual = am._scoreAccount(unltd, {}, ctx);
  // Recompute the discounted composition by hand and confirm the score matches the
  // DISCOUNTED form, not the undiscounted one — the gap between them is the assertion.
  const conc = (unltd.activeWeight + 1) * am.scheduler.concurrencyWeight * mult;
  const capP = am.scheduler.capPenaltyWeight
    * Math.max(0, (unltd.activeWeight + 1) - am.scheduler.perAccountConcurrencyTarget) * mult;
  const util = am._rawUtilization(unltd);
  const discounted = conc + capP
    + pace * am.scheduler.paceCostWeight * mult
    + util * am.scheduler.utilizationWeight * mult;
  const undiscounted = conc / mult + capP / mult
    + pace * am.scheduler.paceCostWeight
    + util * am.scheduler.utilizationWeight;
  assert.ok(Math.abs(actual - discounted) < 1e-6,
    `score ${actual} should equal the discounted form ${discounted}`);
  assert.ok(undiscounted - discounted > 0.3,
    'the two forms must differ enough for this assertion to have teeth');
});

// ---------- peak interaction ----------

test('peak: fast-refill does NOT touch the peak tier — unltd still de-preferred in-window', () => {
  const am = makeAm();
  const unltd = am.accounts[0];
  // In the z.ai peak window (Mon-Fri 06-10 UTC), tier must still be 1: peak spend
  // costs 2x for EVERY plan; weeklyAbsent removes the weekly bucket, not the rate.
  const inWindow = new Date('2026-08-27T08:00:00Z'); // Thu 08:00 UTC
  assert.equal(am._peakTier(unltd, inWindow.getTime()), 1);
});

test('score: at session util in the reserve band the reserve floor is NOT discounted', () => {
  // _weeklyRawState for a provider = max(ses, wk=null) — so a weeklyAbsent account at
  // ses 0.87 IS weekly-reserve. reserveCost must pay FULL freight there; if the
  // multiplier ever leaked onto it, the anti-dogpile floor would silently soften
  // exactly where quota is lowest. Post-SOAK (2026-09-26) this is a STRONGER pin than
  // it was: soakFadeUtil is 0.90, so at ses 0.87 the account IS still discounted on its
  // balancing terms — the floor being undiscounted is now a real separation, not a
  // consequence of the discount already having faded to zero at 0.65.
  const am = makeAm();
  const unltd = am.accounts[0];
  unltd.quota.providerSes = 0.87;
  const state = am._weeklyRawState(unltd);
  assert.equal(state, 'reserve', 'fixture: weeklyAbsent at ses 0.87 is reserve');
  // _reserveCost's band/pace terms read unified7d (Anthropic-only, null for a
  // provider), so a provider in reserve pays exactly the FLOOR. That floor is the
  // anti-dogpile guarantee and must arrive undiscounted — an INDEPENDENT literal,
  // not reserveFloorCost, so scaling the constant can't make this pass vacuously.
  const rc = am._reserveCost(unltd, Date.now(), state);
  assert.equal(rc, 5, 'provider in reserve pays the full floor, never a discounted one');
  assert.equal(rc, am.scheduler.reserveFloorCost, 'and that floor is the configured one');

  // STRUCTURAL guarantee, not a coincidence: reserve starts at 0.85 and FAST-REFILL's
  // discount is fully faded by fastRefillFadeUtil (0.65), so that multiplier is EXACTLY
  // 1 everywhere the reserve/critical bands live — pin the relationship so a config
  // change that inverts it fails here. SOAK MODE deliberately breaks this shape
  // (soakFadeUtil 0.90 > 0.85): a no-weekly account's SESSION window is its only
  // limit, so its balancing terms stay preferred even in the band its own utilization
  // creates — while every SAFETY term (this floor, capPenalty via the capFloor clamp,
  // critical, ramp, failure, all hard gates) stays undiscounted. That separation is
  // pinned by the K5/K8 soak tests; what THIS pin guards is that the fast-refill path
  // still keeps the old geometry.
  assert.ok(am.scheduler.fastRefillFadeUtil <= am.scheduler.weeklyReserveThreshold,
    'fade point must sit at or below the reserve threshold');
  // (the fixture account is weeklyAbsent, so it reads soak knobs — assert via the
  // capFloor route which clamps to fast-refill strength)
  assert.equal(am._fastRefillMultiplier(unltd, { capFloor: true }), 1,
    'multiplier is 1 throughout the reserve band (capFloor clamps soak to fast-refill)');
});

// ---------- persistence ----------

test('persistence: weeklyAbsent survives an export/restore round-trip', () => {
  // Without this the flag is cleared on EVERY restart and the discount silently
  // drops until the next probe sweep re-learns the plan shape.
  const am = makeAm();
  const exported = am.exportQuotaState();
  const row = exported.find(r => r.name === 'unltd');
  assert.equal(row.quota.weeklyAbsent, true, 'weeklyAbsent must be exported');
  assert.equal(row.quota.providerSes, 0.17, 'session utilization must be exported');

  const fresh = makeAm();
  // Simulate a restart: fresh manager, quota only from the persisted payload.
  for (const a of fresh.accounts) a.quota.weeklyAbsent = false;
  fresh.restoreQuotaState(exported);
  const u = fresh.accounts.find(a => a.name === 'unltd');
  assert.equal(u.quota.weeklyAbsent, true);
  assert.ok(fresh._fastRefillMultiplier(u) < 1, 'discount must be live right after restore');
});

// ---------- status surface ----------

test('status: fastRefill block exposes armed + per-account multiplier', () => {
  const am = makeAm();
  const st = am.getStatus();
  const fr = st.scheduler.fastRefill;
  assert.equal(fr.enabled, true);
  assert.equal(fr.discount, 0.6);
  const row = fr.accounts.find(a => a.name === 'unltd');
  assert.ok(row, 'unltd row present');
  // post-soak: 1 - 0.9*(1 - 0.17/0.90) = 0.13 (weeklyAbsent reads soak knobs now)
  // soak: 1 - 0.9*(1 - 0.17/0.90) = 0.27
  assert.equal(row.multiplier, 0.27);
  assert.equal(fr.accounts.length, 1); // limited excluded
});

test('soak: the capFloor clamp is ABSOLUTE inside the reserve band (discount AND fade)', () => {
  // Shipped-then-caught 2026-09-26: capFloor clamped only the DISCOUNT, so soak's wider
  // fade (0.90) still applied a residual 0.98 multiplier at ses 0.87 — inside the
  // reserve band the safety floor exists to protect absolutely.
  const am = makeAm();
  const unltd = am.accounts[0];
  for (const ses of [0.85, 0.87, 0.90, 0.95, 0.99]) {
    unltd.quota.providerSes = ses;
    assert.equal(am._fastRefillMultiplier(unltd, { capFloor: true }), 1,
      `the safety floor must be undiscounted at ses ${ses}, not merely reduced`);
  }
});

test('soak: the status block names the regime actually in force', () => {
  // The block advertised discount 0.6 / fadeUtil 0.65 while a weeklyAbsent account ran
  // on soak's 0.9/0.9 — a TUI reading it would describe settings that were not applied.
  const am = makeAm();
  const fr = am.getStatus().scheduler.fastRefill;
  assert.ok(fr.soak, 'the soak regime is reported');
  assert.equal(fr.soak.discount, am.scheduler.soakDiscount);
  assert.equal(fr.soak.fadeUtil, am.scheduler.soakFadeUtil);
  const row = fr.accounts.find(a => a.name === 'unltd');
  // and the per-account multiplier is consistent with the SOAK knobs it actually uses
  const expected = 1 - fr.soak.discount * (1 - row.sesUtilization / fr.soak.fadeUtil);
  assert.ok(Math.abs(row.multiplier - expected) < 0.005,
    `row multiplier ${row.multiplier} must follow the soak knobs (${expected.toFixed(3)})`);
});
