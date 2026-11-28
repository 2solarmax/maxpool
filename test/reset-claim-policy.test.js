// TEST PLAN 12, 13, 14, 30 (success criteria 5, 8, C5): the claim decision table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideClaude, decideClaudeWithReason, decideZai, CLAUDE_WALL_WEEKLY, POLICY } from '../src/reset-policy.js';
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
// Owner 2026-11-27 (final contract): "No reset should fire until the account has been
// fully utilized. 100%." — a reset is NOT spent before 100%, long-lived or expiring.
test('SC5: the reset fires only when the account is FULLY used — nothing fires before 100%', () => {
  // Owner 2026-11-27: "No reset should fire until the account has been fully utilized. 100%."
  for (const wk of [0.90, 0.95, 0.99, 0.995, 0.999]) {
    assert.equal(decideClaude(acct({ wk, resetIn: 3 * DAY }), listing({ grants: [G()] })), null,
      `${wk} with a long-lived reset: nothing is spent`);
  }
  assert.equal(decideClaude(acct({ wk: 1.0, resetIn: 3 * DAY }), listing({ grants: [G()] }))?.reason, 'weekly at wall',
    '100%: the reset fires');
  assert.equal(POLICY.limitReached, 1, 'the limit IS 100%');
  // ...and a reset about to expire is NOT spent below 100% either (the "last precaution" is gone).
  assert.equal(decideClaude(acct({ wk: 0.995, resetIn: 3 * DAY }), listing({ grants: [G({ endsAt: Date.now() + 10 * H })] })), null,
    'a grant dying in 10h at 99.5%: kept');
});

test('SC5: (a) general grant at fresh unified7d 1.0 (100%) → claim', () => {
  assert.ok(decideClaude(acct({ wk: 1.0 }), listing({ grants: [G()] })));
});
test('SC5: (b) same at 0.98 → none (below CLAUDE_WALL_WEEKLY)', () => {
  assert.equal(decideClaude(acct({ wk: 0.98 }), listing({ grants: [G()] })), null);
});
test('SC5: (c) Fable grant with probe-measured scopedWeekly.fable 1.0 (100%) → claim', () => {
  const a = acct({ wk: 0.5, scoped: { fable: { utilization: 1.0, resetAt: Date.now() + DAY, isActive: true } } });
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
    assert.equal(decideClaude(acct({ wk: 1.0 }), listing({ grants: [g] })), null, `${JSON.stringify(g).slice(0, 40)} must not claim`);
  }
});
test('SC8: (e) session-only grant → never', () => {
  assert.equal(decideClaude(acct({ wk: 1.0 }), listing({ grants: [G({ clears: ['five_hour'] })] })), null);
  assert.equal(decideClaude(acct({ wk: 1.0 }), listing({ grants: [G({ clears: [] })] })), null, 'unknown scope too');
});
test('SC5 (GLM): (f) a z.ai weekly card is KEPT until the account is 100% used', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: Date.now() + 20 * DAY, expired: false }], fiveHour: [] };
  // Was 0.90: a card was spent with up to 10% of the week left (owner, 2026-11-27: "That's idiotic.
  // There's 10% more."). Now nothing fires before the account is fully used.
  for (const wk of [0.905, 0.95, 0.99, 0.999]) {
    assert.equal(decideZai({ enabled: true, quota: { providerSes: 0.2, providerWk: wk, providerWkReset: Date.now() + 3 * DAY } }, cards), null,
      `z.ai weekly card at ${wk}: kept`);
  }
  assert.equal(decideZai({ enabled: true, quota: { providerSes: 0.2, providerWk: 1, providerWkReset: Date.now() + 3 * DAY } }, cards)?.reason, 'weekly at wall',
    'z.ai weekly card at 100%: spent');
  assert.equal(POLICY.wallWeekly, 1, 'the z.ai weekly wall IS the limit');
  assert.equal(CLAUDE_WALL_WEEKLY, 1, 'the Claude/Codex wall IS the limit');
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
  assert.equal(decideClaude(acct({ wk: 1.0, resetIn: -H }), listing({ grants: [G()] })), null);
});
test('SC8: (b) lastProbeOkAt 30 min old → no claim (decide only on THIS sweep)', () => {
  assert.equal(decideClaude(acct({ wk: 1.0, lastProbeOkAt: Date.now() - 30 * 60_000 }), listing({ grants: [G()] })), null);
});
test('SC8: (c) lastProbeOkAt <= lastClaimAt → no claim (no second claim for one wall)', () => {
  const t = Date.now() - 60_000;
  assert.equal(decideClaude(acct({ wk: 1.0, lastProbeOkAt: t, lastClaimAt: t + 1000 }), listing({ grants: [G()] })), null);
});

// ── TEST 30: skip logs once per (account, reason) change ──────────────────────
test('SC5 (C5): 5 sweeps at the wall with the claim held → ONE skip log with its reason', async () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 1.0, resetAt: Date.now() + DAY }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G({ usableNow: false })] }) });   // held: not usable → skip
  const a = am.accounts[0];
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  const wallLogs = () => logs.filter(l => /at wall, claim held/.test(l));
  for (let i = 0; i < 5; i++) { clock += 6 * 60_000; await prober.probeOne(a); }
  assert.equal(wallLogs().length, 1, `one skip line across 5 sweeps (got ${wallLogs().length})`);
  assert.match(wallLogs()[0], /claim held \(grant not usable\)$/, 'the EXACT reason (a usable:false grant), not a guess');
});

// ── judge #6: the policy's OWN rejection reason, one per gate ─────────────────
test('SC5 (judge #6): decideClaudeWithReason names the exact gate that refused', () => {
  const why = (a, l) => decideClaudeWithReason(a, l);
  const t = Date.now() - 60_000;
  const cases = [
    ['listing stale', acct({ wk: 1.0 }), listing({ grants: [G()], stale: true })],
    ['cooldown', acct({ wk: 1.0 }), listing({ grants: [G()], cooldownUntil: Date.now() + H })],
    ['not eligible', acct({ wk: 1.0 }), listing({ grants: [G()], eligible: false })],
    ['probe not fresh', acct({ wk: 1.0, lastProbeOkAt: Date.now() - 30 * 60_000 }), listing({ grants: [G()] })],
    ['weekly window elapsed', acct({ wk: 1.0, resetIn: -H }), listing({ grants: [G()] })],
    ['already claimed for this wall', acct({ wk: 1.0, lastProbeOkAt: t, lastClaimAt: t + 1000 }), listing({ grants: [G()] })],
    ['grant not usable', acct({ wk: 1.0 }), listing({ grants: [G({ usableNow: false })] })],
    ['general not held', acct({ wk: 1.0 }), listing({ grants: [G({ clears: ['seven_day_overage_included'] })] })],
    ['fable not held', acct({ wk: 0.5, scoped: { fable: { utilization: 1.0, resetAt: Date.now() + DAY } } }), listing({ grants: [G()] })],
  ];
  for (const [want, a, l] of cases) {
    const r = why(a, l);
    assert.equal(r.action, null, `${want}: no action`);
    assert.equal(r.reason, want, `expected "${want}", got "${r.reason}"`);
  }
  // Below 100% with nothing else to name, the reason is "below wall".
  assert.equal(why(acct({ wk: 0.5 }), listing({ grants: [G()] })).reason, 'below wall');
  // The wrapper still returns just the action.
  assert.ok(decideClaude(acct({ wk: 1.0 }), listing({ grants: [G()] })));
});

test('SC5 (judge #6): the prober logs the POLICY reason (a stale listing at the wall says "listing stale", not "probe not fresh")', async () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 1.0, resetAt: Date.now() + DAY }, weeklyAbsent: false }),
    grantsFn: async () => ({ error: 'HTTP 429' }) });   // the listing call fails → stored listing goes stale
  const a = am.accounts[0];
  am.applyResetGrants(0, listing({ grants: [G()] }));   // a good listing first
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  clock += 6 * 60_000; await prober.probeOne(a);
  const wall = logs.filter(l => /at wall, claim held/.test(l));
  assert.equal(wall.length, 1, logs.join(' | '));
  assert.match(wall[0], /claim held \(listing stale\)$/);
});

test('SC5 (judge #6): leaving the wall resets the skip key — the next wall logs again', async () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const logs = [];
  let wk = 1.0;
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: wk, resetAt: Date.now() + DAY }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G({ usableNow: false })] }) });
  const a = am.accounts[0];
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  const wallLogs = () => logs.filter(l => /at wall, claim held/.test(l)).length;
  clock += 6 * 60_000; await prober.probeOne(a);
  assert.equal(wallLogs(), 1);
  wk = 0.40;                                  // a free refill: the account left the wall
  clock += 6 * 60_000; await prober.probeOne(a);
  assert.equal(wallLogs(), 1, 'no log below the wall');
  wk = 1.0;                                 // a NEW wall, same reason
  clock += 6 * 60_000; await prober.probeOne(a);
  assert.equal(wallLogs(), 2, 'the new wall logs its reason again');
});

// ── judge #1 at the policy: the probe SEND time orders a reading vs a claim ───
test('SC8 (judge #1): a reading SENT before the last claim never licenses a claim, even if applied after it', () => {
  const claimAt = Date.now() - 30_000;
  const a = acct({ wk: 1.0, lastProbeOkAt: claimAt + 5_000, lastClaimAt: claimAt });
  a.quota.lastProbeOkSentAt = claimAt - 2_000;      // sent before, applied after
  assert.equal(decideClaudeWithReason(a, listing({ grants: [G()] })).reason, 'already claimed for this wall');
  a.quota.lastProbeOkSentAt = claimAt + 1_000;      // control: sent after the claim
  assert.ok(decideClaude(a, listing({ grants: [G()] })), 'a reading sent after the claim may claim');
});

// ── judge #8 (D4), REWRITTEN for the final contract (owner 2026-11-27): there is no
// dying-value claim. A grant is claimed when the window it clears is measured at 100%;
// at 100% the GENERAL claim alone can wait for a free refill with pool room (R7).
test('SC5 (judge #8): a DYING Fable grant is NOT claimed on a model bucket below 100%, refill near or far', () => {
  const dyingFable = G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt: Date.now() + 10 * H });
  // Below the model wall nothing is spent — the Fable refill 6h, 18h, or 3 days out.
  for (const resetIn of [18 * H, 3 * DAY, 6 * H]) {
    const a = acct({ wk: 0.4, scoped: { fable: { utilization: 0.5, resetAt: Date.now() + resetIn } } });
    const r = decideClaudeWithReason(a, listing({ grants: [dyingFable] }));
    assert.equal(r.action, null, `50% Fable bucket, refill in ${resetIn / H}h: kept (got ${r.reason})`);
    assert.equal(r.heldScope ?? null, null, 'no general hold is reported: nothing is at its wall');
  }
  // A Fable bucket measured at 100% claims its grant.
  const full = acct({ wk: 0.4, scoped: { fable: { utilization: 1, resetAt: Date.now() + 3 * DAY } } });
  const hit = decideClaudeWithReason(full, listing({ grants: [dyingFable] }));
  assert.equal(hit.action?.scope, 'fable');
  assert.equal(hit.action?.reason, 'fable weekly at wall');
  // 99.9% is not 100%.
  const near = acct({ wk: 0.4, scoped: { fable: { utilization: 0.999, resetAt: Date.now() + 3 * DAY } } });
  assert.equal(decideClaudeWithReason(near, listing({ grants: [dyingFable] })).action, null);
});

test('SC5 (judge #8): a DYING GENERAL grant is NOT claimed below 100%; at 100% it claims and never waits for a refill it would not see', () => {
  const dying = G({ endsAt: Date.now() + 10 * H });
  for (const resetIn of [3 * DAY, 18 * H, 6 * H]) {
    const r = decideClaudeWithReason(acct({ wk: 0.5, resetIn }), listing({ grants: [dying] }));
    assert.equal(r.action, null, `50% of the week used, refill in ${resetIn / H}h: kept (got ${r.reason})`);
  }
  // At 100% the dying grant is claimed outright: it dies before the refill, so a hold would lose it.
  assert.equal(decideClaude(acct({ wk: 1.0, resetIn: 18 * H }), listing({ grants: [dying] }))?.reason, 'weekly at wall',
    'a grant that expires before the refill is claimed at 100%, not held');
  // At 100% a grant that OUTLIVES the refill waits for it when the pool has room (R7)…
  const held = decideClaudeWithReason(acct({ wk: 1.0, resetIn: 6 * H }), listing({ grants: [G({ endsAt: Date.now() + 30 * H })] }), Date.now(), { peersWithRoom: () => 2 });
  assert.equal(held.action, null);
  assert.equal(held.reason, 'other accounts have room');
  assert.equal(held.heldScope, 'general');
  // …and claims the moment that room is gone.
  assert.equal(decideClaudeWithReason(acct({ wk: 1.0, resetIn: 6 * H }), listing({ grants: [G({ endsAt: Date.now() + 30 * H })] }), Date.now(), { peersWithRoom: () => 1 }).action?.reason, 'weekly at wall');
});

// ── judge #1 through the REAL prober: a claim that lands while a probe is in flight ──
test('SC8 (judge #1): a claim landing while the prober\'s probe is in flight → that probe\'s reading never claims again', async () => {
  const am = new AccountManager([{ name: 'a-race', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const a = am.accounts[0];
  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/oauth/profile')) return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-race' } }) };
    posts.push(String(url));
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const logs = [];
  const tick = () => new Promise(r => setTimeout(r, 5));
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    grantsFn: async () => listing({ grants: [G({ resetsLeft: 2, resetsTotal: 2 })] }),
    probeFn: async () => {
      await tick();
      a.lastClaimAt = Date.now();            // the reactive path claimed meanwhile
      await tick();
      return { fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 1.0, resetAt: Date.now() + DAY }, weeklyAbsent: false };
    } });
  try {
    await prober.probeOne(a);
  } finally { globalThis.fetch = realFetch; }
  assert.ok(a.quota.lastProbeOkAt > a.lastClaimAt, 'precondition: the reading was applied AFTER the claim');
  assert.equal(posts.length, 0, 'the pre-claim reading did not license a second claim');
  assert.ok(logs.some(l => /claim held \(already claimed for this wall\)/.test(l)), logs.join(' | '));
});
