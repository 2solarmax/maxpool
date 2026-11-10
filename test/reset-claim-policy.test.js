// TEST PLAN 12, 13, 14, 30 (success criteria 5, 8, C5): the claim decision table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideClaude, decideZai, CLAUDE_WALL_WEEKLY } from '../src/reset-policy.js';
import { Prober } from '../src/prober.js';
import { AccountManager } from '../src/account-manager.js';

const DAY = 86400_000;
const H = 3600_000;

function acct({ wk = 0.3, scoped = null, lastProbeOkAt = Date.now(), resetIn = 3 * DAY, lastClaimAt = null, enabled = true } = {}) {
  return { name: 'a', enabled, lastClaimAt,
    quota: { unified7d: wk, unified7dReset: Date.now() + resetIn, unified5h: 0.2, lastProbeOkAt, scopedWeekly: scoped } };
}
function listing({ grants, eligible = true, stale = false, cooldownUntil = null } = {}) {
  return { grants, nextGrantId: null, cooldownUntil, eligible, stale, checkedAt: Date.now() };
}
const G = (o = {}) => ({ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: Date.now() + 30 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null, requiresLimit: false, ...o });

// ── TEST 12: the decision table ───────────────────────────────────────────────
test('SC5: (a) general grant at fresh unified7d 0.995 → claim', () => {
  assert.ok(decideClaude(acct({ wk: 0.995 }), listing({ grants: [G()] })));
});
test('SC5: (b) same at 0.98 → none (below CLAUDE_WALL_WEEKLY)', () => {
  assert.equal(decideClaude(acct({ wk: 0.98 }), listing({ grants: [G()] })), null);
});
test('SC5: (c) Fable grant with probe-measured scopedWeekly.fable 0.995 → claim', () => {
  const a = acct({ wk: 0.5, scoped: { fable: { utilization: 0.995, resetAt: Date.now() + DAY, isActive: true } } });
  const act = decideClaude(a, listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }));
  assert.ok(act);
  assert.equal(act.scope, 'fable');
});
test('SC5: (c-neg) a REACTIVE scoped entry at 1.0 does NOT claim (probe must measure)', () => {
  const a = acct({ wk: 0.5, scoped: { fable: { utilization: 1.0, resetAt: Date.now() + DAY, isActive: true, reactive: true } } });
  assert.equal(decideClaude(a, listing({ grants: [G({ clears: ['seven_day_overage_included'] })] })), null);
});
test('SC8: (d) blocking / unavailable_reason / usableNow:false → none', () => {
  for (const g of [G({ blocking: true }), G({ unavailableReason: 'cooldown' }), G({ usableNow: false })]) {
    assert.equal(decideClaude(acct({ wk: 0.995 }), listing({ grants: [g] })), null, `${JSON.stringify(g).slice(0, 40)} must not claim`);
  }
});
test('SC8: (e) session-only grant → never', () => {
  assert.equal(decideClaude(acct({ wk: 0.995 }), listing({ grants: [G({ clears: ['five_hour'] })] })), null);
  assert.equal(decideClaude(acct({ wk: 0.995 }), listing({ grants: [G({ clears: [] })] })), null, 'unknown scope too');
});
test('SC5 (GLM): (f) z.ai at 0.90 claims — POLICY.wallWeekly UNCHANGED at 0.90', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: Date.now() + 20 * DAY, expired: false }], fiveHour: [] };
  const zaiAcct = { enabled: true, quota: { providerSes: 0.2, providerWk: 0.905 } };
  const act = decideZai(zaiAcct, cards);
  assert.ok(act, 'z.ai still redeems at its own 0.90 wall');
  assert.equal(CLAUDE_WALL_WEEKLY, 0.99, 'the Claude constant is separate');
});

// ── TEST 13: `rejected` + 5h 1.0 + 7d 0.3 holding a general grant → no claim ──
test('SC8: a generic rejected with healthy unified weekly does NOT read as a weekly wall', () => {
  const a = acct({ wk: 0.3 });
  a.quota.unifiedStatus = 'rejected';
  a.quota.unified5h = 1.0;
  assert.equal(decideClaude(a, listing({ grants: [G()] })), null,
    'the 5h window / generic rejected must not spend a general grant (pre-mortem #8)');
});

// ── TEST 14: freshness conditions, one at a time ──────────────────────────────
test('SC8: (a) unified7dReset in the past → no claim (window rolled; 0% used)', () => {
  assert.equal(decideClaude(acct({ wk: 0.995, resetIn: -H }), listing({ grants: [G()] })), null);
});
test('SC8: (b) lastProbeOkAt 30 min old → no claim (decide only on THIS sweep)', () => {
  assert.equal(decideClaude(acct({ wk: 0.995, lastProbeOkAt: Date.now() - 30 * 60_000 }), listing({ grants: [G()] })), null);
});
test('SC8: (c) lastProbeOkAt <= lastClaimAt → no claim (no second claim for one wall)', () => {
  const t = Date.now() - 60_000;
  assert.equal(decideClaude(acct({ wk: 0.995, lastProbeOkAt: t, lastClaimAt: t + 1000 }), listing({ grants: [G()] })), null);
});

// ── TEST 30: skip logs once per (account, reason) change ──────────────────────
test('SC5 (C5): 5 sweeps at the wall with the claim held → ONE skip log with its reason', async () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + DAY }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G({ usableNow: false })] }) });   // held: not usable → skip
  const a = am.accounts[0];
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  const wallLogs = () => logs.filter(l => /at wall, claim held/.test(l));
  for (let i = 0; i < 5; i++) { clock += 6 * 60_000; await prober.probeOne(a); }
  assert.equal(wallLogs().length, 1, `one skip line across 5 sweeps (got ${wallLogs().length})`);
  assert.match(wallLogs()[0], /general not held|probe not fresh|grant not usable/, 'the reason is named');
});
