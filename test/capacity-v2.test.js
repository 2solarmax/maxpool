// Capacity v2 (2026-11-06): median-of-slopes per cycle, median across cycles, no physical
// floor clamp, cross-pool cycle merge, one Capacity row per account identity, plan column.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CapacityLedger, mergeCycles, tankStatsFromCycles, segmentSlopes } from '../src/capacity-ledger.js';
import { AccountManager, sanitizePlan, planMonthlyUSD } from '../src/account-manager.js';
import { PoolLink } from '../src/pool-link.js';
import { TUI } from '../src/tui.js';

const FIVE_H = 5 * 3600_000, SEVEN_D = 7 * 86400_000;
const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '');

function cyc(tokens, util, i = 0, extra = {}) {
  const endedAt = Date.now() - i * SEVEN_D;
  return { startedAt: endedAt - SEVEN_D, endedAt, tokens, complete: true, disabledDuring: false,
    finalUtilization: util, resetAt: endedAt, axis: 'all', ...extra };
}

test('V1: clamp removed — median of [5,6,6,18]M cycles is 6M, not 18M-floored', () => {
  const cycles = [5e6, 6e6, 6e6, 18e6].map((t, i) => cyc(t, 1.0, 4 - i));
  const t = tankStatsFromCycles(cycles, 'wk');
  assert.equal(t.avg, 6_000_000);
  assert.equal(t.n, 4);
});

test('V1b: Med-3 is the median of the LAST 3 cycles, Med-all of every cycle ([5,6,6,18,7]M)', () => {
  const cycles = [5e6, 6e6, 6e6, 18e6, 7e6].map((t, i) => cyc(t, 1.0, 5 - i)); // oldest first
  const t = tankStatsFromCycles(cycles, 'wk');
  assert.equal(t.recent, 7_000_000, 'last three 6,18,7 -> 7');
  assert.equal(t.recentN, 3);
  assert.equal(t.avg, 6_000_000, 'all five -> 6');
  assert.equal(t.n, 5);
  const two = tankStatsFromCycles(cycles.slice(-2), 'wk');
  assert.equal(two.recent, 12_500_000, 'two cycles -> median of those two');
  assert.equal(two.recentN, 2);
  assert.equal(tankStatsFromCycles(cycles.slice(-1), 'wk').recent, 7_000_000);
});

test('V2: across cycles is a MEDIAN, not a mean', () => {
  const t = tankStatsFromCycles([1e6, 1e6, 10e6].map((x, i) => cyc(x, 1.0, 3 - i)), 'wk');
  assert.equal(t.avg, 1_000_000, 'mean would be 4M');
});

test('V3: segment slopes ignore pairs with delta-util < 0.05; low-util-only cycle is dropped', () => {
  const s = (t, tokens, util) => ({ t, tokens, util });
  // 0.10 -> 0.12 (skipped as a pair) -> 0.20: one 10pp segment, 800k/0.10 = 8M... anchor stays at 0.10
  const slopes = segmentSlopes([s(1, 100_000, 0.10), s(2, 120_000, 0.12), s(3, 900_000, 0.20)]);
  assert.deepEqual(slopes, [8_000_000]);
  // low-util-only: final 0.2, one sample, no qualifying pair, close fallback needs >= 0.5
  const t = tankStatsFromCycles([cyc(1e6, 0.2, 0, { samples: [s(1, 1e6, 0.2)] })], 'wk');
  assert.equal(t, null, 'too little data → no bogus number');
});

test('V4: a cycle with ≥2 qualifying samples uses the median slope, not close-time tokens/util', () => {
  const s = (t, tokens, util) => ({ t, tokens, util });
  // close-time says 10M/1.0 = 10M, but the slopes say 4M (earlier usage was outside the pool)
  const samples = [s(1, 6e6, 0.5), s(2, 8e6, 1.0 - 0.0)];
  const t = tankStatsFromCycles([cyc(10e6, 1.0, 0, { samples })], 'wk');
  assert.equal(t.avg, 4_000_000);
});

test('V5: a short (reports@-style) weekly tail still counts with ≥2 samples and util ≥ 0.5', () => {
  const s = (t, tokens, util) => ({ t, tokens, util });
  const end = Date.now();
  const c = { startedAt: end - 4.3 * 86400_000, endedAt: end, tokens: 9.88e6, complete: false, disabledDuring: false,
    finalUtilization: 1.0, resetAt: end, axis: 'all', samples: [s(1, 2e6, 0.2), s(2, 9.88e6, 1.0)] };
  assert.ok(tankStatsFromCycles([c], 'wk'), 'counted');
  assert.equal(tankStatsFromCycles([{ ...c, samples: undefined }], 'wk'), null, 'no samples → the read floor still drops it');
});

test('V6: mergeCycles SUMS concurrent cycles (the real mk@gomokka 11-04 case) and takes max util', () => {
  const r = Date.parse('2026-11-04T16:00:00Z');
  const mac = [{ startedAt: r - SEVEN_D, endedAt: r, resetAt: r, tokens: 9_044_788, finalUtilization: 1.0, complete: false, axis: 'all' }];
  const cloud = [{ startedAt: r - 3 * 86400_000, endedAt: r + 1000, resetAt: r + 1000, tokens: 1_337_933, finalUtilization: 1.0, complete: true, axis: 'all' }];
  const m = mergeCycles(mac, cloud);
  assert.equal(m.length, 1);
  assert.equal(m[0].tokens, 10_382_721);
  assert.equal(m[0].finalUtilization, 1.0, 'util is the vendor global: max, never summed');
  assert.equal(tankStatsFromCycles(m, 'wk', { readFloor: { wk: 0 } }).avg, 10_382_721);
});

test('V6b: merged util is the MAX of the two readings (vendor global), not min or sum', () => {
  const r = Date.now();
  const m = mergeCycles([{ startedAt: r - SEVEN_D, endedAt: r, resetAt: r, tokens: 4e6, finalUtilization: 0.8, axis: 'all' }],
                        [{ startedAt: r - SEVEN_D, endedAt: r, resetAt: r, tokens: 1e6, finalUtilization: 0.95, axis: 'all' }]);
  assert.equal(m[0].finalUtilization, 0.95);
  assert.equal(Math.round(tankStatsFromCycles(m, 'wk').avg), Math.round(5e6 / 0.95));
});

test('V7: mergeCycles unions disjoint cycles and honours the ±10 min tolerance', () => {
  const r = Date.now() - SEVEN_D;
  const a = [{ startedAt: r - SEVEN_D, endedAt: r, resetAt: r, tokens: 5, finalUtilization: 0.9, axis: 'all' }];
  const farB = [{ startedAt: r, endedAt: r + SEVEN_D, resetAt: r + SEVEN_D, tokens: 7, finalUtilization: 0.9, axis: 'all' }];
  assert.equal(mergeCycles(a, farB).length, 2, 'disjoint → union');
  const near = [{ ...a[0], resetAt: r + 9 * 60_000, endedAt: r + 9 * 60_000, tokens: 3 }];
  assert.equal(mergeCycles(a, near)[0].tokens, 8, 'within 10 min → same window, summed');
  const out = [{ ...a[0], resetAt: r + 11 * 60_000, endedAt: r + 11 * 60_000, tokens: 3 }];
  assert.equal(mergeCycles(a, out).length, 2, 'beyond tolerance → separate');
  assert.equal(mergeCycles(a, []).length, 1);
});

test('V8: samples are recorded per utilization reading, capped, and survive serialize/restore', () => {
  const l = new CapacityLedger();
  const t0 = Date.now() - FIVE_H;
  for (let k = 1; k <= 200; k++) {
    l.accrue('a', { input: 10_000, output: 0, cacheRead: 40_000, model: 'claude-opus-4' }, t0 + k);
    l.noteUtilizationObserved(t0 + k, [{ name: 'a', window: 'ses', utilization: k / 400 }]);
  }
  l.closeCycle('a', 'ses', Date.now(), { resetAt: Date.now(), finalUtilization: 0.5 });
  const c = l.serialize().accounts.a.ses.closed[0];
  assert.ok(c.samples.length <= 64 && c.samples.length > 10);
  assert.equal(c.models.opus, 10_000_000, 'model family breakdown recorded (all tokens)');
  assert.equal(c.cacheRead, 8_000_000, 'cache recorded separately');
  assert.equal(c.tokens, 10_000_000, 'tank tokens = input + cache_read + cache_creation + output');
  const l2 = CapacityLedger.fromSerialized(JSON.parse(JSON.stringify(l.serialize())));
  assert.equal(l2.tankStats('a', 'ses').avg, 20_000_000, 'slope 50k tokens per 0.0025 util');
});

test('V9: legacy (io-axis) payload restores but is NEVER blended into the all-token median', () => {
  const r = Date.now();
  const v4 = { schemaVersion: 4, accounts: { a: { ses: {
    open: { startedAt: r - 600_000, tokensSoFar: 123, lastAccrualAt: r - 1000, complete: true, disabledDuring: false, peakUtilization: 0.3 },
    closed: [{ startedAt: r - FIVE_H, endedAt: r - 1, tokens: 800_000, complete: true, disabledDuring: false, finalUtilization: 0.8, resetAt: r - 1 }] },
    wk: { open: null, closed: [] }, days: {} } } };
  const l = CapacityLedger.fromSerialized(v4);
  assert.equal(l.serialize().schemaVersion, 5);
  const closed = l.serialize().accounts.a.ses.closed;
  assert.equal(closed.length, 2, 'old row kept + the in-flight old-axis cycle closed as legacy');
  assert.ok(closed.every(c => c.axis === 'io'));
  assert.equal(l.openCycle('a', 'ses'), null, 'no cycle continues across the axis change');
  assert.equal(l.tankStats('a', 'ses'), null, 'legacy rows are not capacity on the new axis');
  // new-axis cycles start fresh and are the only ones counted
  l.accrue('a', { input: 100_000, output: 0, cacheRead: 700_000 }, r - FIVE_H + 60_000);
  l.closeCycle('a', 'ses', r + 60_000, { resetAt: r + 60_000, finalUtilization: 0.8 });
  const t = l.tankStats('a', 'ses');
  assert.equal(t.n, 1);
  assert.equal(t.avg, 1_000_000, '800k all-token ÷ 0.8 — the 800k legacy row did not enter');
});

test('V9b: mergeCycles never sums across token axes; a row without axis is legacy', () => {
  const r = Date.now();
  const base = { startedAt: r - SEVEN_D, endedAt: r, resetAt: r, tokens: 4e6, finalUtilization: 1 };
  assert.equal(mergeCycles([{ ...base, axis: 'all' }], [{ ...base }]).length, 2);
  assert.equal(tankStatsFromCycles([{ ...base }], 'wk'), null);
});

test('V9c: all-token accrual counts input + cache_read + cache_creation + output, same for any model/provider', () => {
  const l = new CapacityLedger();
  l.accrue('g', { input: 14, output: 67, cacheRead: 10_880, cacheCreation: 0, model: 'glm-5.3' }, Date.now());
  l.accrue('c', { input: 10, output: 5, cacheRead: 0, cacheCreation: 11_922, model: 'claude-haiku' }, Date.now());
  assert.equal(l.openCycle('g', 'ses').tokensSoFar, 10_961);
  assert.equal(l.openCycle('c', 'ses').tokensSoFar, 11_937);
  assert.equal(l.openCycle('g', 'ses').models.glm, 10_961);
});

test('V10: plan config → monthly price; Anthropic with no plan defaults to monthly $200 (owner)', () => {
  assert.equal(planMonthlyUSD({ tier: 'GLM Coding Max', cadence: 'quarterly', priceUsd: 403.2, billingMonths: 3 }), 134.4);
  assert.ok(Math.abs(planMonthlyUSD({ tier: 'x', cadence: 'annual', priceUsd: 1411.2 }) - 117.6) < 1e-9, 'months from cadence word');
  assert.equal(sanitizePlan('junk'), null);
  const am = new AccountManager([{ name: 'o', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  assert.equal(am.monthlyPriceFor(am.accounts[0]), 200);
  am.accounts[0].plan = sanitizePlan({ tier: 'Max 20x', cadence: 'monthly', priceUsd: 250, billingMonths: 1 });
  assert.equal(am.monthlyPriceFor(am.accounts[0]), 250, 'configured plan overrides the default');
  const g = new AccountManager([{ name: 'g', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'] }], 0.9);
  assert.equal(g.monthlyPriceFor(g.accounts[0]), null, 'no default for GLM');
  g.accounts[0].plan = sanitizePlan({ tier: 'GLM Coding Max', cadence: 'quarterly', priceUsd: 403.2, billingMonths: 3 });
  assert.ok(Math.abs(g.monthlyPriceFor(g.accounts[0]) - 134.4) < 1e-9, 'plan is the fallback');
  g.applyMonthlyPrice(0, 60);
  assert.equal(g.monthlyPriceFor(g.accounts[0]), 60, 'live z.ai API value wins over the configured plan');
});

// ── one row per identity ────────────────────────────────────────────────────
function twoPoolAM() {
  const am = new AccountManager([
    { name: 'mk@gomokka', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, accountUuid: 'U1' },
    { name: 'kira', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, accountUuid: 'U2' },
    { name: 'nouuid', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
  ], 0.9, { routingMode: 'balance' });
  const r = Date.now() - SEVEN_D;
  am.capacity.accrue('mk@gomokka', { input: 6e6, output: 0 }, r - SEVEN_D);
  am.capacity.closeCycle('mk@gomokka', 'wk', r, { resetAt: r, finalUtilization: 1.0 });
  const link = new PoolLink({ name: 'team', url: 'http://x', key: 'k' });
  link.lastOkAt = 1; link.lastError = null;
  link.status = { accounts: [
    { name: 'mk@gomokka', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', inFlight: 0, quota: {},
      plan: { tier: 'Max 20x', cadence: 'monthly', priceUsd: 200, billingMonths: 1 },
      cycles: { wk: [{ startedAt: Date.now() - 8 * 86400_000, endedAt: Date.now() - 86400_000, resetAt: Date.now() - 86400_000, tokens: 5e6, finalUtilization: 1.0, complete: true, axis: 'all' }], ses: [] },
      },
  ] };
  link.identities = new Map([['uuid:U1', { name: 'mk@gomokka', provider: 'anthropic', type: 'oauth' }]]);
  am.setPoolLinks([link]);
  am.applyPoolLinks();
  return am;
}
const renderWk = (am, W = 150) => { const t = new TUI({ accountManager: am, config: {} }); t.capacityWindow = 'wk'; return t._renderCapacityPage(W).map(strip).join('\n'); };

test('V11: a benched local row + its cloud mirror (same uuid) render as ONE row, Where=both, cloud history merged', () => {
  const am = twoPoolAM();
  assert.equal(am.accounts.filter(a => a.remoteUuid === 'U1' || a.accountUuid === 'U1').length, 2, 'fixture has the pair');
  const page = renderWk(am);
  const mk = page.split('\n').filter(l => /mk@gomokka/.test(l));
  assert.equal(mk.length, 1, 'one row per identity:\n' + page);
  assert.match(mk[0], /both/);
  assert.match(mk[0], /Max 20x M \$200\/mo/, 'plan cell from the cloud-exported plan');
  assert.doesNotMatch(page, /cache \d+%/, 'no cosmetic cache note');
  // merged history: local 6M@1.0 + cloud 5M@1.0 are DISJOINT windows → median of [6M,5M] = 5.5M; $200/5.5M
  assert.match(mk[0], /5\.5M/);
  assert.match(mk[0], /\$36\.36/);
  am.setPoolLinks([]);
});

test('V12: local-only rows stay; an identity-less row stays separate and is marked ?', () => {
  const page = renderWk(twoPoolAM());
  assert.match(page.split('\n').find(l => /kira/.test(l)), /laptop/);
  assert.match(page, /nouuid\?/);
});

test('V13: capacityTank for a mirror unions BOTH ledgers (never "more cycles wins")', () => {
  const am = twoPoolAM();
  const mirror = am.accounts.find(a => a.remote);
  const t = am.capacityTank(mirror.index, 'wk');
  assert.equal(t.n, 2);
  assert.equal(t.source, 'cycles');
  am.setPoolLinks([]);
});

test('V14: getStatus exports bounded closed cycles per window and plan', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, accountUuid: 'U',
    plan: { tier: 'Max 20x', cadence: 'monthly', priceUsd: 200 } }], 0.9);
  for (let i = 0; i < 20; i++) {
    const e = Date.now() - (20 - i) * SEVEN_D;
    am.capacity.accrue('a', { input: 1e6, output: 0, cacheRead: 1e6 }, e - SEVEN_D, ['wk']);
    am.capacity.closeCycle('a', 'wk', e, { resetAt: e, finalUtilization: 1.0 });
  }
  const row = am.getStatus().accounts[0];
  assert.equal(row.cycles.wk.length, 12);
  assert.equal(row.plan.tier, 'Max 20x');
  assert.equal(row.cache, undefined, 'no cache field exported');
});
