import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zaiHourlyCalls, compareOutsideUsage, hourFloor, OUTSIDE_MIN_CALLS } from '../src/outside-usage.js';

const H = 3600_000;
const NOW = Date.UTC(2026, 9, 27, 12, 30, 0);          // 12:30Z
const UP = Date.UTC(2026, 9, 26, 6, 10, 0);            // pool up since 06:10Z yesterday
const hrs = (obj) => new Map(Object.entries(obj).map(([k, v]) => [Number(k), v]));
const at = (h) => h >= 0 ? Date.UTC(2026, 9, 27, h) : Date.UTC(2026, 9, 26, 24 + h); // h<0 → yesterday             // today hour h, UTC

// ── zaiHourlyCalls: z.ai labels are UTC+8 ────────────────────────────────────
test('z.ai "2026-10-27 12:00" is 04:00Z', () => {
  const m = zaiHourlyCalls({ x_time: ['2026-10-27 12:00', '2026-10-27 13:00'], modelCallCount: [5, 7] });
  assert.equal(m.get(at(4)), 5);
  assert.equal(m.get(at(5)), 7);
});

test('zaiHourlyCalls tolerates junk and missing arrays', () => {
  assert.equal(zaiHourlyCalls(null).size, 0);
  assert.equal(zaiHourlyCalls({ x_time: ['garbage'], modelCallCount: [9] }).size, 0);
  assert.equal(zaiHourlyCalls({ x_time: ['2026-10-27 12:00'], modelCallCount: [null] }).get(at(4)), 0);
});

// ── compareOutsideUsage ──────────────────────────────────────────────────────
test('max+1 shape: 600 z.ai calls/h vs 0-4 pool sends → outside', () => {
  const z = new Map(), p = new Map();
  for (let h = 0; h < 12; h++) { z.set(at(h), 600); p.set(at(h), h % 3 === 0 ? 4 : 0); }
  const r = compareOutsideUsage(z, p, { now: NOW, poolUpSince: UP });
  assert.equal(r.outside, true);
  assert.equal(r.zaiCalls, 7200);
  assert.equal(r.poolCalls, 16);
});

test('glm1 shape: z.ai ≈ 1.1x pool → clean', () => {
  const z = new Map(), p = new Map();
  for (let h = 0; h < 12; h++) { z.set(at(h), 110); p.set(at(h), 100); }
  assert.equal(compareOutsideUsage(z, p, { now: NOW, poolUpSince: UP }).outside, false);
});

test('ratio boundary: exactly 3x is clean, above 3x flags', () => {
  const opts = { now: NOW, poolUpSince: at(10) };          // window = 10:00, 11:00
  assert.equal(compareOutsideUsage(hrs({ [at(10)]: 150, [at(11)]: 150 }), hrs({ [at(10)]: 50, [at(11)]: 50 }), opts).outside, false);
  assert.equal(compareOutsideUsage(hrs({ [at(10)]: 151, [at(11)]: 150 }), hrs({ [at(10)]: 50, [at(11)]: 50 }), opts).outside, true);
});

test('noise floor: under the minimum never flags, at the minimum it can', () => {
  const opts = { now: NOW, poolUpSince: at(11) };          // window = 11:00 only
  assert.equal(compareOutsideUsage(hrs({ [at(11)]: OUTSIDE_MIN_CALLS - 1 }), new Map(), opts).outside, false);
  assert.equal(compareOutsideUsage(hrs({ [at(11)]: OUTSIDE_MIN_CALLS }), new Map(), opts).outside, true);
});

test('restart safety: hours before the pool came up are never compared', () => {
  const z = hrs({ [at(9)]: 5000, [at(10)]: 5000, [at(11)]: 5000 });
  const r = compareOutsideUsage(z, new Map(), { now: NOW, poolUpSince: Date.UTC(2026, 9, 27, 11, 40) });
  assert.equal(r.hours, 0, 'no complete hour since boot yet');
  assert.equal(r.outside, false);
});

test('the current (incomplete) hour is never compared', () => {
  const r = compareOutsideUsage(hrs({ [at(12)]: 9999 }), new Map(), { now: NOW, poolUpSince: UP });
  assert.equal(r.zaiCalls, 0, '12:00-13:00 is still running at 12:30');
});

test('window caps at 24 complete hours', () => {
  const r = compareOutsideUsage(new Map(), new Map(), { now: NOW, poolUpSince: NOW - 10 * 24 * H });
  assert.equal(r.hours, 24);
  assert.equal(r.to, hourFloor(NOW));
});

// ── wiring: AccountManager records pool sends per hour; Prober runs the check ─
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';
import { decideZai } from '../src/reset-policy.js';

function zaiPool(extra = {}) {
  const am = new AccountManager([
    { name: 'glm leak', type: 'provider', provider: 'zai', authToken: 'k1', upstream: 'https://api.z.ai/api/anthropic', ...extra },
  ], 0.90);
  return am;
}
const zaiData = (hoursUtc, calls) => ({
  x_time: hoursUtc.map(h => { const d = new Date(h + 8 * H); return d.toISOString().slice(0, 13).replace('T', ' ') + ':00'; }),
  modelCallCount: hoursUtc.map(() => calls),
});

test('acquireAccount counts pool sends per UTC hour for z.ai accounts', () => {
  const am = zaiPool();
  am.notePoolSend(am.accounts[0], NOW);
  am.notePoolSend(am.accounts[0], NOW + 60_000);
  assert.equal(am.accounts[0].poolHourly.get(hourFloor(NOW)), 2);
});

test('prober flags an account whose key is used outside the pool', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  const hours = Array.from({ length: 24 }, (_, i) => hourFloor(NOW) - (24 - i) * H);
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: { utilization: 0.1, resetAt: NOW + H }, wk: { utilization: 0.5, resetAt: NOW + 3 * 24 * H }, source: 'zai' }),
    zaiUsageFn: async () => zaiData(hours, 600),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => NOW,
  });
  await prober.probeProvider(am.accounts[0]);
  const o = am.accounts[0].outsideUsage;
  assert.ok(o, 'outsideUsage recorded');
  assert.equal(o.outside, true);
  assert.equal(o.zaiCalls, 600 * 24);
  assert.equal(o.poolCalls, 0);
});

test('prober leaves a clean account unflagged', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  const hours = Array.from({ length: 24 }, (_, i) => hourFloor(NOW) - (24 - i) * H);
  for (const h of hours) for (let i = 0; i < 100; i++) am.notePoolSend(am.accounts[0], h + 1000);
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: { utilization: 0.1, resetAt: NOW + H }, wk: { utilization: 0.5, resetAt: NOW + 3 * 24 * H }, source: 'zai' }),
    zaiUsageFn: async () => zaiData(hours, 110),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => NOW,
  });
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, false);
});

test('a DISABLED account is never checked (someone else legitimately uses it)', async () => {
  const am = zaiPool({ enabled: false });
  am.poolUpSince = NOW - 30 * H;
  let called = 0;
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => { called++; return zaiData([hourFloor(NOW) - H], 9999); },
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => NOW,
  });
  await prober.probeProvider(am.accounts[0]);
  assert.equal(called, 0);
  assert.equal(am.accounts[0].outsideUsage, undefined);
});

test('the check runs at most hourly per account', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  let called = 0; let t = NOW;
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => { called++; return zaiData([hourFloor(t) - H], 0); },
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);
  t = NOW + 30 * 60_000; await prober.probeProvider(am.accounts[0]);
  assert.equal(called, 1, 'second sweep 30 min later reuses the reading');
  t = NOW + 61 * 60_000; await prober.probeProvider(am.accounts[0]);
  assert.equal(called, 2);
});

test('the flag logs ONCE on transition, not every hour', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  const lines = []; let t = NOW;
  const mkHours = () => Array.from({ length: 24 }, (_, i) => hourFloor(t) - (24 - i) * H);
  const prober = new Prober(am, {
    grantsFn: async () => null, log: (l) => lines.push(l),
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => zaiData(mkHours(), 600),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);
  t += 61 * 60_000; await prober.probeProvider(am.accounts[0]);
  assert.equal(lines.filter(l => /outside-usage/.test(l)).length, 1);
});

// ── prevention: never feed a reset card to a leaking account (R7) ─────────────
test('R7: an account flagged for outside use never redeems a card, even at the wall', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: NOW + 30 * 24 * H, expired: false }], fiveHour: [] };
  const acct = { name: 'leak', enabled: true, quota: { providerSes: 0, providerWk: 1 }, outsideUsage: { outside: true } };
  assert.equal(decideZai(acct, cards, NOW), null);
  const clean = { ...acct, outsideUsage: { outside: false } };
  assert.ok(decideZai(clean, cards, NOW), 'same account without the flag DOES redeem (control)');
});

// ── surfaces: status endpoint + dashboard row ─────────────────────────────────
test('status exposes the outside-usage reading per account', () => {
  const am = zaiPool();
  am.accounts[0].outsideUsage = { outside: true, zaiCalls: 14400, poolCalls: 0, hours: 24 };
  const st = am.getStatus();
  const row = st.accounts.find(a => a.name === 'glm leak');
  assert.equal(row.outsideUsage.outside, true);
  assert.equal(row.outsideUsage.zaiCalls, 14400);
});

test('dashboard row shows the red outside-usage tag only when flagged', async () => {
  const { TUI } = await import('../src/tui.js');
  const am = zaiPool();
  am.accounts[0].quota.providerSes = 0.1; am.accounts[0].quota.providerWk = 1;
  const strip = (x) => String(x).replace(/\x1b\[[0-9;]*m/g, '');
  const d = new TUI({ accountManager: am, config: {} });
  am.accounts[0].outsideUsage = { outside: true, zaiCalls: 14400, poolCalls: 16, hours: 24 };
  assert.match(strip(d._renderAcct(0, 20, true)), /key used outside pool ×900/);
  am.accounts[0].outsideUsage = { outside: false, zaiCalls: 110, poolCalls: 100, hours: 24 };
  assert.doesNotMatch(strip(d._renderAcct(0, 20, true)), /outside pool/);
});

test('the REAL request path (acquireAccount) counts each send', () => {
  // Same fleet shape as routing-modes.test.js (a provider-only fleet routes nothing).
  const am = new AccountManager([{ name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.90, { crossProviderFallbackPolicy: 'always' });
  am.loadConfigProviders([{ name: 'glm', provider: 'zai', token: 'k1' }]);
  am.setAccountEnabled(0, false);
  for (let i = 0; i < 2; i++) {
    const l = am.acquireAccount({ profile: 'all', sessionKey: 's' + i }, new Set());
    assert.equal(l?.account?.name, 'glm', 'routed to the z.ai account');
    am.releaseAccount(l, { success: true });
  }
  const glm = am.accounts.find(a => a.name === 'glm');
  const total = [...(glm.poolHourly?.values() || [])].reduce((s, v) => s + v, 0);
  assert.equal(total, 2, 'two real sends counted');
});

// ── review round 1 hardening (judge FAIL→fix): fail-open + persistence ────────
test('R1.1 a FAILED z.ai fetch never clears a true flag (no fail-open)', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  const hours = Array.from({ length: 24 }, (_, i) => hourFloor(NOW) - (24 - i) * H);
  let failNow = false; let t = NOW;
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => (failNow ? null : zaiData(hours, 600)),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, true);
  failNow = true; t += 61 * 60_000;              // next sweep: fetch fails
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, true, 'flag survives a failed fetch');
  assert.ok(am.accounts[0].outsideUsage.stale, 'reading is marked stale');
  // and the card gate still holds on stale
  const cards = { weekly: [{ recordId: 9, expiresAt: NOW + 30 * 24 * H, expired: false }], fiveHour: [] };
  const acct = { name: 'leak', enabled: true, quota: { providerSes: 0, providerWk: 1 }, outsideUsage: am.accounts[0].outsideUsage };
  assert.equal(decideZai(acct, cards, NOW), null, 'R7 holds while stale');
});

test('R1.2 empty z.ai data (all-zero hours) never clears a true flag', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  let mode = 'leak'; let t = NOW;
  const hours = Array.from({ length: 24 }, (_, i) => hourFloor(NOW) - (24 - i) * H);
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => (mode === 'leak' ? zaiData(hours, 600) : { x_time: hours.map(String), modelCallCount: [] }),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, true);
  mode = 'partial'; t += 61 * 60_000;
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, true, 'flag survives a partial/empty response');
});

test('R1.3 the flag persists across restart (export/restore)', () => {
  const am = zaiPool();
  am.accounts[0].outsideUsage = { outside: true, zaiCalls: 14400, poolCalls: 16, hours: 24, checkedAt: NOW };
  const saved = am.exportQuotaState();
  const am2 = zaiPool();                        // fresh process: fresh poolUpSince, empty poolHourly
  am2.restoreQuotaState(saved);
  assert.equal(am2.accounts[0].outsideUsage.outside, true, 'flag survives restart');
});

test('R1.4 hour-floor labels: ":30" rows are folded into their hour, never dropped', () => {
  const m = zaiHourlyCalls({ x_time: ['2026-10-27 12:00', '2026-10-27 12:30', '2026-10-27 13:15'], modelCallCount: [10, 5, 2] });
  assert.equal(m.get(at(4)), 15, '12:00+12:30 both fold into 04:00Z');
  assert.equal(m.get(at(5)), 2, '13:15 folds into 05:00Z');
});

test('R1.5 a failed fetch retries next sweep, not an hour later', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  let calls = 0; let t = NOW;
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => { calls++; return calls === 1 ? null : zaiData([hourFloor(t) - H], 0); },
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);   // fails
  t += 5 * 60_000;                              // minutes, not an hour
  await prober.probeProvider(am.accounts[0]);
  assert.equal(calls, 2, 'retried on the next sweep');
});

test('R1.6 a well-formed all-zero reading DOES clear the flag (key rotated, leak stopped)', async () => {
  const am = zaiPool();
  am.poolUpSince = NOW - 30 * H;
  let mode = 'leak'; let t = NOW;
  const mk = () => Array.from({ length: 24 }, (_, i) => hourFloor(t) - (24 - i) * H);
  const prober = new Prober(am, {
    grantsFn: async () => null, log: () => {},
    providerProbeFn: async () => ({ ses: null, wk: null, source: 'zai' }),
    zaiUsageFn: async () => zaiData(mk(), mode === 'leak' ? 600 : 0),
    cardsFn: async () => ({ weekly: [], fiveHour: [] }),
    now: () => t,
  });
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, true);
  mode = 'quiet'; t += 25 * H;                 // a full window later, leak gone
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].outsideUsage.outside, false, 'clears once real data shows it stopped');
});

// ── shared-key adoption (2026-10-28: 3 teammate accounts flagged ×490 on connect) ──
test('a just-added shared account does not flag: hours before addedAt are the previous owner\'s', () => {
  const z = new Map(), p = new Map();
  for (let i = 0; i < 12; i++) z.set(Date.UTC(2026, 9, 26, 20) + i * H, 60);  // teammate overnight (Oct 26 20:00 → Oct 27 07:00)
  for (let i = 0; i < 3; i++) p.set(Date.UTC(2026, 9, 27, 9 + i), 30);        // ours since adding
  const addedAt = Date.UTC(2026, 9, 27, 8, 30);                                 // adopted 08:30
  const r = compareOutsideUsage(z, p, { now: NOW, poolUpSince: NOW - 48 * H, sinceMs: addedAt });
  assert.equal(r.zaiCalls, 0, 'pre-adoption teammate hours are excluded from the z.ai tally');
  assert.equal(r.outside, false, 'nothing post-adoption → no flag');
  // control: same data, no sinceMs (a pre-existing account) still flags
  const r2 = compareOutsideUsage(z, p, { now: NOW, poolUpSince: NOW - 48 * H });
  assert.equal(r2.zaiCalls, 720, 'control sees all 12 teammate hours');
  assert.equal(r2.outside, true, 'control flags (720 vs 90)');
});

test('a shared account STILL flags if the OTHER owner outruns us after adoption', () => {
  const z = new Map(), p = new Map();
  z.set(at(-2), 400); p.set(at(-2), 10);                 // after adoption: 40x
  const r = compareOutsideUsage(z, p, { now: NOW, poolUpSince: NOW - 48 * H, sinceMs: at(-3) });
  assert.equal(r.outside, true, 'real post-adoption divergence still flags');
});
