import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { mergePeakDefaults } from '../src/peak-window.js';
import { TUI, __tuiTest } from '../src/tui.js';
const { strip } = __tuiTest;

// Lanes B-E of the TEST PLAN. The clock is ALWAYS injected — never ambient (T3).
const U = (y, mo, d, h, mi) => Date.UTC(y, mo, d, h, mi, 0, 0);
const TUE_IN = U(2026, 7, 18, 7, 0);     // Tuesday 07:00 UTC — inside the zai window
const TUE_OFF = U(2026, 7, 18, 23, 0);   // Tuesday 23:00 — outside
const SAT_IN = U(2026, 7, 22, 7, 0);     // Saturday — never peak

const PEAK_SCHED = { providers: mergePeakDefaults({}, undefined) };   // zai window + 0.5 cap
// Sticky tests need providers ELIGIBLE for a Claude-profile session — the live config
// shape (claudeFallback:'always'), otherwise _matchesRequest bars them and the binding
// never exists to escape from.
const PEAK_SCHED_STICKY = {
  providers: mergePeakDefaults({ zai: { claudeFallback: 'always' }, kimi: { claudeFallback: 'always' } }, undefined),
};

const fleet = (sched, opts = {}) => {
  const accounts = [
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', apiKey: 'k', profiles: ['all'] },
    { name: 'kimi', type: 'provider', provider: 'kimi', apiKey: 'kk', profiles: ['all'] },
    ...(opts.extra || []),
  ];
  return new AccountManager(accounts, 0.90, { ...sched });
};

const glmOf = am => am.accounts.find(a => a.name === 'glm');
const ccOf = am => am.accounts.find(a => a.name === 'cc');

// ── Lane B: priority tier ──────────────────────────────────────────────────────

test('B1 in-peak, GLM ranks below Claude in ALL 5 routing modes', () => {
  for (const mode of ['balance', 'prefer-claude', 'prefer-zai', 'prefer-kimi', 'sticky']) {
    const am = fleet({ ...PEAK_SCHED, routingMode: mode });
    const pClaude = am._effectivePriority(ccOf(am), {}, TUE_IN);
    const pGlm = am._effectivePriority(glmOf(am), {}, TUE_IN);
    assert.ok(pClaude < pGlm, `${mode}: Claude(${pClaude}) must outrank GLM(${pGlm}) during peak`);
  }
});

test('B2 soft: with every NON-PEAK route removed, GLM is STILL selected', () => {
  const am = fleet({ ...PEAK_SCHED, routingMode: 'balance' });
  // Both halves of SC1: kimi has no window, so in-peak it is a legitimate non-peak
  // alternative that de-preference SHOULD prefer. The soft guarantee is about the
  // state where NO non-peak route exists — remove both to exercise it.
  ccOf(am).enabled = false;
  am.accounts.find(a => a.provider === 'kimi').enabled = false;
  const picked = am._selectNext({ profile: 'all' }, new Set(), TUE_IN);
  assert.equal(picked?.name, 'glm', 'peak de-preference never strands a request');
  // ...and while a non-peak route DOES exist, the de-preference actually bites.
  const am2 = fleet({ ...PEAK_SCHED, routingMode: 'balance' });
  ccOf(am2).enabled = false;
  assert.equal(am2._selectNext({ profile: 'all' }, new Set(), TUE_IN)?.name, 'kimi',
    'in-peak GLM loses to the non-peak provider');
});

test('B3 prefer-zai in-peak: the mode choice is overridden (documented consequence of SC1)', () => {
  const am = fleet({ ...PEAK_SCHED, routingMode: 'prefer-zai' });
  assert.ok(am._effectivePriority(ccOf(am), {}, TUE_IN) < am._effectivePriority(glmOf(am), {}, TUE_IN));
});

test('B4 SC2 identity: off-peak priority === _basePriority for every account x mode', () => {
  for (const mode of ['balance', 'prefer-claude', 'prefer-zai', 'prefer-kimi', 'sticky']) {
    const am = fleet({ ...PEAK_SCHED, routingMode: mode });
    for (const a of am.accounts) {
      assert.equal(
        am._effectivePriority(a, {}, TUE_OFF),
        am._basePriority(a, {}),
        `${mode}/${a.name}: off-peak must be byte-identical`,
      );
    }
  }
});

test('B5 stride is load-bearing: a hand-set priority 5000 does not beat the tier (under a mode that honors it)', () => {
  // Under prefer-kimi, non-preferred accounts return their BASE — so a hand-set
  // priority is live here in a way balance mode (everything 0) never exercises.
  const sched = { ...PEAK_SCHED, routingMode: 'prefer-kimi' };
  const am = fleet(sched, {
    extra: [{ name: 'hotglm2', type: 'provider', provider: 'zai', priority: 5000, apiKey: 'k2', profiles: ['all'] }],
  });
  const hot = am.accounts.find(a => a.name === 'hotglm2');
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  const pHot = am._effectivePriority(hot, {}, TUE_IN);     // 5000 + 1*stride
  const pKimi = am._effectivePriority(kimi, {}, TUE_IN);   // 0 (preferred)
  assert.ok(pKimi < pHot, `kimi(${pKimi}) outranks a priority-5000 PEAK zai(${pHot})`);
  // THE STRIDE PIN: with stride=1 this comparison still holds (0 < 5001), so also pin
  // the ordering against a NON-preferred non-peak account — the case stride actually guards.
  const am2 = fleet(sched, {
    extra: [{ name: 'lowglm2', type: 'provider', provider: 'zai', priority: 1, apiKey: 'k2', profiles: ['all'] }],
  });
  const low = am2.accounts.find(a => a.name === 'lowglm2');   // non-peak?? NO — zai in-peak.
  // zai is in-peak here, so the honest pin is: same account OFF-peak vs a peak sibling.
  const pOff = am2._effectivePriority(low, {}, TUE_OFF);     // 1
  const pIn = am2._effectivePriority(low, {}, TUE_IN);       // 1 + stride
  assert.ok(pIn - pOff >= 1000, `the tier stride must dominate any hand-set base (got ${pIn - pOff})`);
});

// ── Lane C: cap ────────────────────────────────────────────────────────────────

test('C1 over-cap GLM not selected during peak WITH Claude free; selected off-peak', () => {
  const am = fleet({ ...PEAK_SCHED, routingMode: 'balance' });
  glmOf(am).quota.providerWk = 0.6;    // >= 0.5 cap
  assert.equal(am._peakTier(glmOf(am), TUE_IN), 2, 'tier 2 = over cap in-peak');
  const inPeak = am._selectNext({ profile: 'all' }, new Set(), TUE_IN);
  assert.equal(inPeak?.name, 'cc', 'Claude preferred while GLM is over cap');
  assert.equal(am._peakTier(glmOf(am), TUE_OFF), 0, 'off-peak: same account, no tier');
  const offPeak = am._selectNext({ profile: 'all' }, new Set(), TUE_OFF);
  assert.ok(offPeak, 'off-peak GLM still serves (subject to normal gates)');
});

test('C2 peakCap 1.0 = feature off, even at util 1.0 (the >= boundary)', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 1.0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  glmOf(am).quota.providerWk = 1.0;
  assert.equal(am._peakTier(glmOf(am), TUE_IN), 1, 'cap>=1 never promotes to tier 2 — depreference only');
});

test('C3 peakCap 0.0 hard-bars during peak, utilization-INDEPENDENT (even 0% and null)', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  for (const wk of [0.0, 0.4, 1.0, null]) {
    glmOf(am).quota.providerWk = wk;
    assert.equal(am._peakHardBarred(glmOf(am), TUE_IN), true, `cap 0 bars at providerWk=${wk}`);
    assert.equal(am._isAvailable(glmOf(am), { allowWeeklyReserve: true, now: TUE_IN }), false, 'unavailable in-peak');
  }
  assert.equal(am._peakHardBarred(glmOf(am), TUE_OFF), false, 'C4: the bar is window-scoped');
});

test('C5 kimi (no windows) is NEVER affected — any clock, any utilization', () => {
  const am = fleet(PEAK_SCHED);
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerWk = 0.99;
  for (const t of [TUE_IN, TUE_OFF, SAT_IN, U(2026, 7, 16, 8, 0), U(2026, 7, 23, 9, 59)]) {
    assert.equal(am._peakTier(kimi, t), 0, `kimi tier 0 at ${new Date(t).toISOString()}`);
    assert.equal(am._peakHardBarred(kimi, t), false);
  }
});

test('C6 legacy TOKENS_LIMIT (providerWk null) + cap 0.5 → soft cap inert (tier 1)', () => {
  const am = fleet({ ...PEAK_SCHED, routingMode: 'balance' });
  glmOf(am).quota.providerWk = null;
  glmOf(am).quota.weeklyAbsent = true;
  assert.equal(am._peakTier(glmOf(am), TUE_IN), 1, 'unknown weekly NEVER means over-cap');
});

// ── Lane D: starvation — the session-kill regressions ──────────────────────────

test('D1 soft: every Claude unavailable + GLM over cap → GLM still SERVES (last resort)', () => {
  const am = fleet({ ...PEAK_SCHED, routingMode: 'balance' });
  ccOf(am).enabled = false;
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.enabled = false;
  glmOf(am).quota.providerWk = 0.9;   // way over cap
  const picked = am._selectNext({ profile: 'all' }, new Set(), TUE_IN);
  assert.equal(picked?.name, 'glm', 'SC8: the cap is de-prioritisation, never a strand');
});

test('D3 hard (cap 0.0): oracle holds FINITE on the window end — parks, does not die', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  ccOf(am).enabled = false;
  am.accounts.find(a => a.provider === 'kimi').enabled = false;
  const plan = am.nextRetryForRequest({ profile: 'all' }, new Set(), TUE_IN);
  assert.ok(Number.isFinite(plan.retryAfterMs), `FINITE hold (got ${plan.retryAfterMs}) — Infinity kills`);
  assert.equal(plan.cause, 'peak_window');
  const expected = U(2026, 7, 18, 10, 0) - TUE_IN;
  assert.ok(Math.abs(plan.retryAfterMs - expected) < 60_000, `hold == window remainder (±1min): ${plan.retryAfterMs} vs ${expected}`);
  assert.equal(am.hasAvailableRoute({ profile: 'all' }, new Set(), TUE_IN), false);
});

test('D4 compound: peak-barred + rate-limited → retryAt = max(windowEnd, cooldown end)', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  ccOf(am).enabled = false;
  am.accounts.find(a => a.provider === 'kimi').enabled = false;
  const glm = glmOf(am);
  glm.status = 'throttled';
  glm.rateLimitedUntil = TUE_IN + 30 * 60_000;   // 30min — LONGER than nothing, shorter than window
  const plan = am.nextRetryForRequest({ profile: 'all' }, new Set(), TUE_IN);
  assert.ok(Number.isFinite(plan.retryAfterMs));
  // the hold must not report free while the cooldown still runs
  assert.ok(plan.retryAfterMs >= 30 * 60_000 - 60_000, 'retryAt >= cooldown end');
});

test('D5 compound: peak-barred + weekly-exhausted → weekly reset dominates (precedence)', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  ccOf(am).enabled = false;
  am.accounts.find(a => a.provider === 'kimi').enabled = false;
  const glm = glmOf(am);
  glm.quota.providerWk = 0.9995;
  const weeklyReset = TUE_IN + 3 * 86400_000;   // 3 days — dominates the 3h window
  glm.quota.providerWkReset = weeklyReset;
  // The substantive guarantee: the hold reports the TRUE soonest-usable time, i.e. the
  // dominating weekly reset, not the (much sooner) window end. Delete the weeklyReset
  // term from the peak branch's max-merge and this dies.
  const info = am._retryInfo(glm, null, TUE_IN);
  assert.equal(info.retryAt, weeklyReset, 'retryAt = the weekly reset, not the window end');
  // The CAUSE must follow the DOMINANT blocker too, not just the branch we happen to be
  // in. Labelling a 3-DAY weekly wait `peak_window` would tell the user "peak ends in 3h"
  // — the misleading-message class this codebase has been bitten by. Fixed 2026-08-18
  // after the simplifier surfaced the divergence.
  assert.equal(info.cause, 'weekly_exhausted', 'the dominant blocker owns the label');
  const plan = am.nextRetryForRequest({ profile: 'all' }, new Set(), TUE_IN);
  assert.ok(Number.isFinite(plan.retryAfterMs) && plan.retryAfterMs > 2.9 * 86400_000);
});

test('D5b negative control: barred with NO weekly pressure still reports peak_window', () => {
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  const info = am._retryInfo(glmOf(am), null, TUE_IN);
  assert.equal(info.cause, 'peak_window', 'without a dominating weekly, peak owns the label');
  assert.equal(info.retryAt, U(2026, 7, 18, 10, 0), 'and the time is the window end');
});

// ── Lane E: sticky ─────────────────────────────────────────────────────────────

test('E1 sticky: a GLM-bound session migrates OFF GLM at window start (escape fires)', () => {
  const am = fleet({ ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  const glm = glmOf(am);
  // bind a session to GLM before the window
  am._bindSession('sess-1', glm, null);
  // off-peak it stays
  assert.equal(am._boundAccount('sess-1', 'all', new Set(), {}, U(2026, 7, 18, 5, 0))?.name, 'glm', 'pre-peak: bound');
  // in-peak the escape fires → the session leaves (selection is where migration happens)
  const picked = am._selectNext({ profile: 'all', sessionKey: 'sess-1' }, new Set(), TUE_IN);
  assert.equal(picked?.name, 'cc', 'in-peak: the GLM-bound session migrates to Claude');
});

test('E3 BLOCKER-2 regression: peak failover KEEPS homeName — session returns after the window', () => {
  const am = fleet({ ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  const glm = glmOf(am);
  am._bindSession('sess-1', glm, null);
  // during peak the session is served by Claude (failover)
  const cc = ccOf(am);
  am._bindSession('sess-1', cc, null, TUE_IN);
  const binding = am.sessionBindings.get('sess-1');
  assert.equal(binding.homeName, 'glm', 'a peak move is a FAILOVER — homeName must stay GLM');
  // after the window the session returns to its home
  assert.equal(am._boundAccount('sess-1', 'all', new Set(), {}, TUE_OFF)?.name, 'glm', 'SC2 tail: returns post-peak');
});

test('E3b BLOCKER-2, LOWER-priority leg: a ranked provider home survives the peak failover', () => {
  // E3 above binds two priority-0 accounts, so it only exercises the EQUAL-priority
  // leg. The DESIGN's actual BLOCKER-2 case is `oauth 0 < provider 10` — a RANKED
  // provider home. Without a raw priority on glm that branch is unreachable, and the
  // guard it protects is unpinned (mutation-verified: deleting `peakFailover` left the
  // whole suite green until this test existed).
  const am = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, priority: 0 },
    { name: 'glm', type: 'provider', provider: 'zai', apiKey: 'k', profiles: ['all'], priority: 10 },
  ], 0.90, { ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  const glm = am.accounts.find(a => a.name === 'glm');
  const cc = am.accounts.find(a => a.name === 'cc');

  am._bindSession('sess-p', glm, null, TUE_OFF);
  assert.equal(am.sessionBindings.get('sess-p').homePriority, 10, 'home is the RANKED provider');

  // Peak forces the session onto the higher-ranked (lower-number) Claude account.
  am._bindSession('sess-p', cc, null, TUE_IN);
  assert.equal(am.sessionBindings.get('sess-p').homeName, 'glm',
    'a peak-forced move to a BETTER-ranked account is a FAILOVER — homeName must stay GLM');
  assert.equal(am._boundAccount('sess-p', 'all', new Set(), {}, TUE_OFF)?.name, 'glm',
    'SC2 tail: the session returns to its GLM home once the window closes');

  // Negative control: the SAME move OFF-peak is a by-choice rebalance — it re-homes.
  const am2 = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, priority: 0 },
    { name: 'glm', type: 'provider', provider: 'zai', apiKey: 'k', profiles: ['all'], priority: 10 },
  ], 0.90, { ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  am2._bindSession('sess-p', am2.accounts.find(a => a.name === 'glm'), null, TUE_OFF);
  am2._bindSession('sess-p', am2.accounts.find(a => a.name === 'cc'), null, TUE_OFF);
  assert.equal(am2.sessionBindings.get('sess-p').homeName, 'cc',
    'off-peak the guard is inert — a lower-priority move still re-homes (SC2)');
});

test('E3c the failover guard needs a NON-PEAK destination — a peak→peak move still re-homes', () => {
  // Both halves of `peakFailover` are load-bearing and must not be collapsed into the
  // equal-priority leg's `oldHomeInPeak`: moving between two accounts of the SAME
  // peaked family relieves nothing, so it is an ordinary by-choice rebalance.
  const am = new AccountManager([
    { name: 'glm-a', type: 'provider', provider: 'zai', apiKey: 'k', profiles: ['all'], priority: 10 },
    { name: 'glm-b', type: 'provider', provider: 'zai', apiKey: 'k2', profiles: ['all'], priority: 5 },
  ], 0.90, { ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  const a = am.accounts.find(x => x.name === 'glm-a');
  const b = am.accounts.find(x => x.name === 'glm-b');
  assert.ok(am._peakTier(a, TUE_IN) > 0 && am._peakTier(b, TUE_IN) > 0, 'both are in peak');

  am._bindSession('sess-z', a, null, TUE_IN);
  am._bindSession('sess-z', b, null, TUE_IN);
  assert.equal(am.sessionBindings.get('sess-z').homeName, 'glm-b',
    'peak→peak is not a failover — the better-ranked account becomes home');
});

// ── Red-team fixes (2026-08-18). Each of these pins a construct that survived the
// first mutation sweep, or a defect the red-team probe found in the shipped code. ──

test('R1 a HEALTHY provider that merely LEARNED its weekly reset reports peak, not weekly', () => {
  // The defect: providerWkReset is set on every successfully-PROBED account, so reading
  // it unconditionally made a 5%-weekly account report a 72h "weekly_exhausted" hold
  // instead of the real 3h peak hold — the multi-day-hang class, inverted.
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  const glm = glmOf(am);
  glm.quota.providerWk = 0.05;                       // healthy
  glm.quota.providerWkReset = TUE_IN + 3 * 86400_000; // known, but NOT blocking
  const info = am._retryInfo(glm, null, TUE_IN);
  assert.equal(info.cause, 'peak_window', 'a healthy account is peak-blocked, not weekly-blocked');
  assert.ok(info.retryAt - TUE_IN < 4 * 3600_000, `hold must be the ~3h window, got ${(info.retryAt - TUE_IN) / 3600_000}h`);
});

test('R2 peakCap coercion FAILS SAFE — no garbage value may hard-bar', () => {
  // `Number(null)` is 0, which is the hard bar. `peakCap: null` is the natural JSON
  // spelling of "no cap" AND the convention peakTimezone uses in the same object.
  const am = fleet(PEAK_SCHED);
  for (const bad of [null, '', false, [], {}, 'abc', NaN, undefined]) {
    am.scheduler.providers = { zai: { peakCap: bad } };
    am._peakCache = null;
    assert.equal(am._peakSettingsFor('zai').cap, 0.5, `peakCap: ${JSON.stringify(bad)} must fall back, never bar`);
  }
  // ...while a real 0 still means the deliberate hard bar.
  am.scheduler.providers = { zai: { peakCap: 0 } };
  am._peakCache = null;
  assert.equal(am._peakSettingsFor('zai').cap, 0);
  // The SAME garbage must be rejected by the SETTER (critic round 2, 2026-08-18): a
  // persisted 0 is structurally unreachable by the read-path guard above. This test
  // loops the identical 8 values through setPeakSettingsForProvider.
  const am2 = fleet(PEAK_SCHED);
  for (const bad of [null, '', false, [], {}, 'abc', NaN, undefined]) {
    const ok = am2.setPeakSettingsForProvider('zai', { peakCap: bad });
    if (bad === undefined) continue;   // undefined = "not changing it" — legit
    assert.equal(ok, false, `setter must REJECT peakCap: ${JSON.stringify(bad)}`);
  }
  assert.equal(am2.setPeakSettingsForProvider('zai', { peakCap: 0 }), true, 'a real 0 is a deliberate instruction');
  assert.equal(am2._peakSettingsFor('zai').cap, 0);
});

test('R3 setPeakSettingsForProvider accepts peakTimezone and REJECTS a bad zone', () => {
  const am = fleet(PEAK_SCHED);
  assert.equal(am.setPeakSettingsForProvider('zai', { peakTimezone: 'Europe/Berlin' }), true);
  assert.equal(am._peakSettingsFor('zai').timezone, 'Europe/Berlin', 'the zone actually changed');
  assert.equal(am.setPeakSettingsForProvider('zai', { peakTimezone: 'Not/AZone' }), false, 'a typo is rejected at the setter');
  assert.equal(am._peakSettingsFor('zai').timezone, 'Europe/Berlin', 'and leaves the previous value intact');
  assert.equal(am.setPeakSettingsForProvider('zai', { peakTimezone: null }), true, 'null = follow the machine zone');
  assert.equal(am._peakSettingsFor('zai').timezone, null);
});

test('R4 the selector REFUSES a hard-barred account (the gate, not just the oracle)', () => {
  // No test previously covered "_selectNext honours the hard bar" — only the oracle did.
  const sched = { providers: mergePeakDefaults({ zai: { peakCap: 0 } }, undefined), routingMode: 'balance' };
  const am = fleet(sched);
  ccOf(am).enabled = false;
  am.accounts.find(a => a.provider === 'kimi').enabled = false;
  assert.equal(am._selectNext({ profile: 'all' }, new Set(), TUE_IN), null,
    'a hard-barred sole account is NOT selected — the request parks on the finite hold');
});

test('R5 E2: a peak account is never a MIGRATION DESTINATION', () => {
  const am = fleet({ ...PEAK_SCHED_STICKY, routingMode: 'sticky' });
  const cc = ccOf(am);
  // bind to Claude, make Claude hot, and confirm the in-peak GLM is not chosen as target
  am._bindSession('s-mig', cc, null);
  cc.quota.unified5h = 0.99;   // hot
  const picked = am._selectNext({ profile: 'all', sessionKey: 's-mig' }, new Set(), TUE_IN);
  assert.notEqual(picked?.name, 'glm', 'never migrate ONTO a peak-suppressed account');
});

test('R6 SC9: the peak header survives STICKY mode (which overwrites xpText wholesale)', () => {
  // sticky is DEFAULT_SCHEDULER.routingMode, the TUI's own fallback, AND the legacy
  // migration target — and its `xpText = this._crossProviderText()` assignment
  // discarded a peak note that had been prepended. Verified dead by red-team probe.
  for (const mode of ['sticky', 'balance']) {
    const am = fleet({ ...PEAK_SCHED_STICKY, routingMode: mode });
    // Freeze the TUI's clock reads by pointing the memo at an in-window instant.
    am._peakStateFor('zai', TUE_IN);
    const tui = new TUI({ accountManager: am, config: {} });
    const note = strip(tui._peakHeaderNote(TUE_IN));
    assert.match(note, /peak/i, `${mode}: _peakHeaderNote must render in-window`);
  }
});
