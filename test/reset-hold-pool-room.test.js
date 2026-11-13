// Owner 2026-11-13 (task-2026-11-13-maxpool-hold-resets-when-pool-has-room):
// at the weekly wall, HOLD the reset claim when BOTH the account's free weekly
// refill is < 24h away AND at least two other accounts in this pool have room.
// Unknown capacity → claim as before. A grant that would die before (or right
// at) the refill is always claimed. Dying-value and session-only rules unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as policy from '../src/reset-policy.js';
import { decideClaude, decideClaudeWithReason } from '../src/reset-policy.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const DAY = 86400_000;
const H = 3600_000;
const HOLD = 'free refill <24h away, other accounts have room';

function acct({ wk = 0.995, resetIn = 18 * H, scoped = null, lastProbeOkAt = Date.now(), lastClaimAt = null } = {}) {
  return { name: 'a', enabled: true, lastClaimAt,
    quota: { unified7d: wk, unified7dReset: Date.now() + resetIn, unified5h: 0.2, lastProbeOkAt, scopedWeekly: scoped } };
}
function listing({ grants, eligible = true, stale = false, cooldownUntil = null } = {}) {
  return { grants, nextGrantId: null, cooldownUntil, eligible, stale, checkedAt: Date.now() };
}
const G = (o = {}) => ({ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: Date.now() + 30 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null, requiresLimit: false, ...o });
const peers = n => ({ peersWithRoom: () => n });
const why = (a, l, opts) => decideClaudeWithReason(a, l, Date.now(), opts);

// ── the decision table ────────────────────────────────────────────────────────
test('HOLD: at wall + refill 18h away + 2 peers with room → no claim, plain-words reason', () => {
  const r = why(acct(), listing({ grants: [G()] }), peers(2));
  assert.equal(r.action, null, 'held, not claimed');
  assert.equal(r.reason, HOLD);
  assert.equal(policy.HOLD_POOL_HAS_ROOM, HOLD, 'the reason is exported for the log/status');
});

test('CLAIM: at wall + refill 30h away (≥ 24h) + ample peers → claims as today', () => {
  const r = why(acct({ resetIn: 30 * H }), listing({ grants: [G()] }), peers(5));
  assert.equal(r.action?.reason, 'weekly at wall');
});

test('CLAIM: at wall + refill 18h + only ONE peer with room → claims (needs ≥ 2)', () => {
  assert.equal(why(acct(), listing({ grants: [G()] }), peers(1)).action?.reason, 'weekly at wall');
  assert.equal(why(acct(), listing({ grants: [G()] }), peers(0)).action?.reason, 'weekly at wall');
});

test('CLAIM: capacity unknown (no peer function, or it answers null/NaN) → claims as today', () => {
  assert.equal(why(acct(), listing({ grants: [G()] }), {}).action?.reason, 'weekly at wall', 'no peersWithRoom');
  assert.equal(why(acct(), listing({ grants: [G()] }), { peersWithRoom: () => null }).action?.reason, 'weekly at wall', 'null');
  assert.equal(why(acct(), listing({ grants: [G()] }), { peersWithRoom: () => NaN }).action?.reason, 'weekly at wall', 'NaN');
  assert.equal(why(acct(), listing({ grants: [G()] }), { peersWithRoom: () => 2.5 }).action?.reason, 'weekly at wall',
    'a fractional count is not a confirmed integer of accounts');
  assert.ok(decideClaude(acct(), listing({ grants: [G()] })), 'the 2-arg prober-free call keeps claiming');
});

test('CLAIM: unknown refill time → claims (never hold on a guess)', () => {
  const a = acct(); a.quota.unified7dReset = null;
  assert.equal(why(a, listing({ grants: [G()] }), peers(5)).action?.reason, 'weekly at wall');
});

test('CLAIM: a grant that expires BEFORE the refill is claimed, never left to die', () => {
  const r = why(acct({ resetIn: 18 * H }), listing({ grants: [G({ endsAt: Date.now() + 10 * H })] }), peers(5));
  assert.equal(r.action?.reason, 'weekly at wall');
});

test('CLAIM: a grant that expires within 24h AFTER the refill is claimed too (it would sit unspent at ~0% use)', () => {
  const r = why(acct({ resetIn: 18 * H }), listing({ grants: [G({ endsAt: Date.now() + 18 * H + 12 * H })] }), peers(5));
  assert.equal(r.action?.reason, 'weekly at wall');
  // control: a grant outliving the refill by days is held
  const h = why(acct({ resetIn: 18 * H }), listing({ grants: [G({ endsAt: Date.now() + 18 * H + 3 * DAY })] }), peers(5));
  assert.equal(h.action, null);
  assert.equal(h.reason, HOLD);
  // a grant with no end date never dies: held
  assert.equal(why(acct(), listing({ grants: [G({ endsAt: null })] }), peers(5)).reason, HOLD);
});

test('UNCHANGED: dying-value claim (below the wall) still fires with ample peers', () => {
  const r = why(acct({ wk: 0.5, resetIn: 3 * DAY }), listing({ grants: [G({ endsAt: Date.now() + 10 * H })] }), peers(5));
  assert.equal(r.action?.reason, 'dying value');
});

test('UNCHANGED: a session-only grant is never claimed, peers or not', () => {
  for (const n of [0, 5]) {
    assert.equal(why(acct({ resetIn: 30 * H }), listing({ grants: [G({ clears: ['five_hour'] })] }), peers(n)).action, null);
  }
});

test('UNCHANGED: every existing skip keeps precedence over the hold', () => {
  const t = Date.now() - 60_000;
  const cases = [
    ['listing stale', acct(), listing({ grants: [G()], stale: true })],
    ['cooldown', acct(), listing({ grants: [G()], cooldownUntil: Date.now() + H })],
    ['probe not fresh', acct({ lastProbeOkAt: Date.now() - 30 * 60_000 }), listing({ grants: [G()] })],
    ['already claimed for this wall', acct({ lastProbeOkAt: t, lastClaimAt: t + 1000 }), listing({ grants: [G()] })],
    ['weekly window elapsed', acct({ resetIn: -H }), listing({ grants: [G()] })],
  ];
  for (const [want, a, l] of cases) assert.equal(why(a, l, peers(5)).reason, want);
});

test('RE-EVALUATED every tick: capacity gone → the very next decision claims; refill pushed past 24h → claims', () => {
  const a = acct();
  let room = 2;
  const opts = { peersWithRoom: () => room };
  assert.equal(why(a, listing({ grants: [G()] }), opts).reason, HOLD, 'tick 1: held');
  room = 1;
  assert.equal(why(a, listing({ grants: [G()] }), opts).action?.reason, 'weekly at wall', 'tick 2: one peer left → claim');
  room = 3;
  a.quota.unified7dReset = Date.now() + 25 * H;
  assert.equal(why(a, listing({ grants: [G()] }), opts).action?.reason, 'weekly at wall', 'tick 3: refill ≥ 24h → claim');
});

test('SCOPED (model weekly at the wall): held when peers have room for THAT model; the scope is passed through', () => {
  const scoped = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } };
  const fableG = G({ clears: ['seven_day_overage_included'] });
  const asked = [];
  const h = why(acct({ wk: 0.5, resetIn: 3 * DAY, scoped }), listing({ grants: [fableG] }), { peersWithRoom: s => { asked.push(s); return 2; } });
  assert.equal(h.action, null);
  assert.equal(h.reason, HOLD);
  assert.deepEqual(asked, ['fable'], 'capacity asked for the fable bucket');
  const c = why(acct({ wk: 0.5, resetIn: 3 * DAY, scoped }), listing({ grants: [fableG] }), { peersWithRoom: s => (s === 'fable' ? 1 : 9) });
  assert.equal(c.action?.reason, 'fable weekly at wall');
  // the fable refill far away → claims
  const far = { fable: { utilization: 0.995, resetAt: Date.now() + 3 * DAY, isActive: true } };
  assert.equal(why(acct({ wk: 0.5, resetIn: 3 * DAY, scoped: far }), listing({ grants: [fableG] }), peers(9)).action?.reason, 'fable weekly at wall');
});

// ── "has room": the per-peer predicate through a REAL AccountManager ─────────
function pool(n = 3) {
  const am = new AccountManager(Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'oauth', accessToken: `t${i}`, refreshToken: `r${i}`, expiresAt: Date.now() + 3600_000 })), 0.9);
  for (const a of am.accounts) {
    a.quota.unified7d = 0.3; a.quota.unified7dReset = Date.now() + 3 * DAY;
    a.quota.unified5h = 0.2; a.quota.unified5hReset = Date.now() + 3 * H;
    a.quota.lastProbeOkAt = Date.now();
  }
  const self = am.accounts[0];
  self.quota.unified7d = 0.995; self.quota.unified7dReset = Date.now() + 18 * H;
  return am;
}
const count = (am, scope = 'general') => am.countPeersWithRoom(am.accounts[0], scope);

test('ROOM: two healthy fresh peers count; self never counts — even when self itself is roomy', () => {
  const am = pool(3);
  assert.equal(typeof am.countPeersWithRoom, 'function');
  assert.equal(count(am), 2);
  // The contract is "OTHER accounts": give SELF roomy quotas and count again —
  // the number must not move (a future caller may hold a roomy self).
  am.accounts[0].quota.unified7d = 0.2;
  am.accounts[0].quota.unified5h = 0.1;
  assert.equal(count(am), 2, 'self with room still does not count');
  // …and when self has NO identity to match on (no uuid, no credential), only the
  // object check keeps it out.
  am.accounts[0].credential = null;
  assert.equal(count(am), 2, 'identity-less roomy self still does not count');
});

test('ROOM: each disqualifier drops exactly one peer', () => {
  const cases = {
    'stale probe (> 5 min)': p => { p.quota.lastProbeOkAt = Date.now() - 6 * 60_000; },
    'never probed': p => { p.quota.lastProbeOkAt = null; },
    'weekly unknown': p => { p.quota.unified7d = null; },
    '5h unknown': p => { p.quota.unified5h = null; },
    'weekly 0.655 (room 0.345 < 0.35)': p => { p.quota.unified7d = 0.655; },
    '5h 0.655 (room to the 0.90 bench 0.245 < 0.25)': p => { p.quota.unified5h = 0.655; },
    disabled: p => { p.enabled = false; },
    throttled: p => { p.status = 'throttled'; p.rateLimitedUntil = Date.now() + H; },
    'cooling down': p => { p.cooldownUntil = Date.now() + 60_000; },
    'status error': p => { p.status = 'error'; },
    'status exhausted': p => { p.status = 'exhausted'; },
    'subscription gone': p => { p.subscriptionGone = true; },
    'refresh dead': p => { p.refreshDead = true; },
    'duplicate benched by the team pool': p => { p.poolBenchedBy = 'cloud'; },
    'remote mirror (another process routes it)': p => { p.remote = { link: { lastOkAt: Date.now() } }; },
    'same identity as self': p => { p.accountUuid = 'u-self'; },
    'usage cap 0.5 at 0.3 (room 0.2)': p => { p.capUtilization = 0.5; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const am = pool(3);
    am.accounts[0].accountUuid = 'u-self';
    mutate(am.accounts[1]);
    assert.equal(count(am), 1, name);
  }
});

test('ROOM: boundaries — 0.645 weekly / 0.645 5h still count', () => {
  const am = pool(3);
  am.accounts[1].quota.unified7d = 0.645;
  am.accounts[2].quota.unified5h = 0.645;
  assert.equal(count(am), 2);
});

test('BOUNDARIES: refill exactly 24h away → claim; a grant ending exactly 24h AFTER the refill → held', () => {
  assert.equal(why(acct({ resetIn: 24 * H }), listing({ grants: [G()] }), peers(5)).action?.reason, 'weekly at wall');
  const endsAtRefillPlus24 = Date.now() + 18 * H + 24 * H;
  const h = why(acct({ resetIn: 18 * H }), listing({ grants: [G({ endsAt: endsAtRefillPlus24 })] }), peers(5));
  assert.equal(h.action, null);
  assert.equal(h.reason, HOLD);
});

test('BOUNDARIES: a peer probe exactly 5 min old still counts; weekly/5h exactly at the room line still count', () => {
  const am = pool(3);
  am.accounts[1].quota.lastProbeOkAt = Date.now() - 5 * 60_000;   // exactly CLAIM_FRESH_MS
  am.accounts[2].quota.unified7d = 0.65;                          // exactly 1 - holdPeerWeeklyRoom
  assert.equal(count(am), 2);
  const am2 = pool(3);
  am2.accounts[1].quota.unified5h = 0.65;                         // exactly switchThreshold - holdPeerSessionRoom
  assert.equal(count(am2), 2);
});

test('ROOM: a provider (GLM/Kimi) is not a Claude peer', () => {
  const am = pool(2);
  am.accounts[1].type = 'provider';
  assert.equal(count(am), 0);
});

test('ROOM (scoped): a peer counts for a model only with a measured, roomy bucket for it', () => {
  const am = pool(3);
  am.accounts[1].quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } };
  am.accounts[2].quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } };
  assert.equal(count(am, 'fable'), 2);
  am.accounts[2].quota.scopedWeekly = {};                                       // unknown → not counted
  assert.equal(count(am, 'fable'), 1);
  am.accounts[2].quota.scopedWeekly = { fable: { utilization: 0.2, reactive: true } };  // a 429 guess is not a reading
  assert.equal(count(am, 'fable'), 1);
  am.accounts[2].quota.scopedWeekly = { fable: { utilization: 0.7 } };            // too full for that model
  assert.equal(count(am, 'fable'), 1);
});

// ── end to end: the real prober decides with the real pool ───────────────────
function stubFetch(posts) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/oauth/profile')) return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-x' } }) };
    posts.push(String(url));
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  return () => { globalThis.fetch = realFetch; };
}

test('PROBER: holds while two peers have room (logs the reason), claims on the sweep after one peer goes stale', async () => {
  const am = pool(3);
  const self = am.accounts[0];
  const logs = [];
  const posts = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G()] }) });
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  const restore = stubFetch(posts);
  try {
    clock += 6 * 60_000; await prober.probeOne(self);
    assert.equal(posts.length, 0, 'held: no claim POST');
    assert.ok(logs.some(l => l.endsWith(`at wall, claim held (${HOLD})`)), logs.join(' | '));
    am.accounts[2].quota.lastProbeOkAt = Date.now() - 10 * 60_000;   // capacity can no longer be confirmed
    clock += 6 * 60_000; await prober.probeOne(self);
    assert.equal(posts.length, 1, 'the next sweep claims');
  } finally { restore(); }
});

test('PROBER (scoped): a model wall asks capacity FOR THAT MODEL — peers roomy in general but with no model bucket → claims', async () => {
  const am = pool(3);
  const self = am.accounts[0];
  const posts = [];
  const logs = [];
  const fableWall = () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.5, resetAt: Date.now() + 3 * DAY },
    scopedWeekly: { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } }, weeklyAbsent: false });
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => fableWall(),
    grantsFn: async () => listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }) });
  let clock = 1_700_000_000_000;
  prober._now = () => clock;
  const restore = stubFetch(posts);
  try {
    clock += 6 * 60_000; await prober.probeOne(self);
    assert.equal(posts.length, 1, 'no peer has a fable reading → capacity for fable is unknown → claim');
    assert.ok(logs.some(l => /claiming grant g1 \(fable weekly at wall/.test(l)), logs.join(' | '));
  } finally { restore(); }
  // control: with fable room on both peers the same wall is HELD (the scope reached the counter)
  const am2 = pool(3);
  for (const p of am2.accounts.slice(1)) p.quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } };
  const posts2 = [];
  const logs2 = [];
  const prober2 = new Prober(am2, { intervalMs: 0, log: m => logs2.push(m), providerProbeFn: async () => null,
    probeFn: async () => fableWall(),
    grantsFn: async () => listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }) });
  prober2._now = () => clock;
  const restore2 = stubFetch(posts2);
  try {
    await prober2.probeOne(am2.accounts[0]);
    assert.equal(posts2.length, 0, 'fable room on two peers → held');
    assert.ok(logs2.some(l => l.endsWith(`at wall, claim held (${HOLD})`)), logs2.join(' | '));
  } finally { restore2(); }
});

test('REACTIVE: a weekly 429 at the wall honours the same hold (no claim while peers have room); claims when they do not', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    self.status = 'throttled'; self.rateLimitedUntil = Date.now() + H;
    const attempted = await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(attempted, false, 'held: not attempted');
    assert.equal(posts.length, 0);
    am.accounts[1].enabled = false;                                   // only one peer left
    await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'claims once capacity is short');
  } finally { restore(); }
});
