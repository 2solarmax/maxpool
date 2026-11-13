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

// Every helper takes an explicit `now` (red-team #5): a boundary test reads ONE
// clock value for building its fixture AND for the decision, so it can't drift by
// a millisecond between the two.
function acct({ wk = 0.995, resetIn = 18 * H, scoped = null, now = Date.now(), lastProbeOkAt = now, lastClaimAt = null } = {}) {
  return { name: 'a', enabled: true, lastClaimAt,
    quota: { unified7d: wk, unified7dReset: now + resetIn, unified5h: 0.2, lastProbeOkAt, scopedWeekly: scoped } };
}
function listing({ grants, eligible = true, stale = false, cooldownUntil = null, now = Date.now() } = {}) {
  return { grants, nextGrantId: null, cooldownUntil, eligible, stale, checkedAt: now };
}
const G = (o = {}, now = Date.now()) => ({ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: now + 30 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null, requiresLimit: false, ...o });
const peers = n => ({ peersWithRoom: () => n });
const why = (a, l, opts, now = Date.now()) => decideClaudeWithReason(a, l, now, { now, ...opts });

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

// ── "has room": the per-peer predicate through a REAL AccountManager ─────────
function pool(n = 3, now = Date.now()) {
  const am = new AccountManager(Array.from({ length: n }, (_, i) => ({ name: `c${i}`, type: 'oauth', accessToken: `t${i}`, refreshToken: `r${i}`, expiresAt: now + 3600_000 })), 0.9);
  for (const a of am.accounts) {
    a.accountUuid = `u-${a.name}`;   // a resolvable identity (red-team r2 #4: no identity ⇒ not a peer)
    a.quota.unified7d = 0.3; a.quota.unified7dReset = now + 3 * DAY;
    a.quota.unified5h = 0.2; a.quota.unified5hReset = now + 3 * H;
    a.quota.lastProbeOkAt = now;
  }
  const self = am.accounts[0];
  self.quota.unified7d = 0.995; self.quota.unified7dReset = now + 18 * H;
  return am;
}
const count = (am, now = Date.now()) => am.countPeersWithRoom(am.accounts[0], now);

test('ROOM: two healthy fresh peers count; self never counts — even when self itself is roomy', () => {
  const am = pool(3);
  assert.equal(typeof am.countPeersWithRoom, 'function');
  assert.equal(count(am), 2);
  // The contract is "OTHER accounts": give SELF roomy quotas and count again —
  // the number must not move (a future caller may hold a roomy self).
  am.accounts[0].quota.unified7d = 0.2;
  am.accounts[0].quota.unified5h = 0.1;
  assert.equal(count(am), 2, 'self with room still does not count');
  // …and when self has NO identity to match on (no uuid, no credential).
  am.accounts[0].credential = null;
  am.accounts[0].accountUuid = null;
  assert.equal(count(am), 2, 'identity-less roomy self still does not count');
});

test('RT2-4 (minor): a peer whose identity cannot be resolved is not counted (unknown identity = unknown capacity)', () => {
  const now = Date.now();
  const am = pool(3, now);
  am.accounts[1].accountUuid = null;
  assert.equal(am.capacityIdentity(am.accounts[1]), null, 'precondition: no identity');
  assert.equal(count(am, now), 1);
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
  const now = Date.now();
  assert.equal(why(acct({ resetIn: 24 * H, now }), listing({ grants: [G({}, now)], now }), peers(5), now).action?.reason, 'weekly at wall');
  const endsAtRefillPlus24 = now + 18 * H + 24 * H;
  const h = why(acct({ resetIn: 18 * H, now }), listing({ grants: [G({ endsAt: endsAtRefillPlus24 }, now)], now }), peers(5), now);
  assert.equal(h.action, null);
  assert.equal(h.reason, HOLD);
});

test('BOUNDARIES: a peer probe exactly 5 min old still counts; weekly/5h exactly at the room line still count', () => {
  const now = Date.now();
  const am = pool(3, now);
  am.accounts[1].quota.lastProbeOkAt = now - 5 * 60_000;          // exactly CLAIM_FRESH_MS
  am.accounts[2].quota.unified7d = 0.65;                          // exactly 1 - holdPeerWeeklyRoom
  assert.equal(count(am, now), 2);
  const am2 = pool(3, now);
  am2.accounts[1].quota.unified5h = 0.65;                         // exactly switchThreshold - holdPeerSessionRoom
  assert.equal(count(am2, now), 2);
});

// ── red-team round 1 (2026-11-13) ────────────────────────────────────────────
test('RT1 (blocker): a GENERAL hold never leans on peers whose model limit is exhausted or full — Fable would have no route', () => {
  const now = Date.now();
  const exhausted = { fable: { utilization: 1.0, resetAt: now + DAY, isActive: true } };
  const am = pool(3, now);
  am.accounts[1].quota.scopedWeekly = structuredClone(exhausted);
  am.accounts[2].quota.scopedWeekly = structuredClone(exhausted);
  assert.equal(count(am, now), 0, 'Fable-exhausted peers cannot carry the walled account');
  const cases = {
    'fable measured full (0.80, no room)': { fable: { utilization: 0.80, resetAt: now + DAY } },
    'fable reactive 429 mark': { fable: { utilization: 1.0, resetAt: now + DAY, reactive: true } },
    'opus exhausted': { opus: { utilization: 0.999, resetAt: now + DAY } },
  };
  for (const [name, sw] of Object.entries(cases)) {
    const a = pool(3, now);
    a.accounts[1].quota.scopedWeekly = sw;
    assert.equal(count(a, now), 1, name);
  }
  // A peer with a roomy model bucket (or none reported) still counts for the general hold.
  const ok = pool(3, now);
  ok.accounts[1].quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: now + DAY } };
  assert.equal(count(ok, now), 2);
  // An INACTIVE model limit binds nothing (same rule as the router's _scopedExhausted).
  const inactive = pool(3, now);
  inactive.accounts[1].quota.scopedWeekly = { fable: { utilization: 1.0, resetAt: now + DAY, isActive: false } };
  assert.equal(count(inactive, now), 2);
});

test('RT1 (blocker, e2e): a general wall with Fable-exhausted peers → the prober CLAIMS', async () => {
  const am = pool(3);
  for (const p of am.accounts.slice(1)) p.quota.scopedWeekly = { fable: { utilization: 1.0, resetAt: Date.now() + DAY, isActive: true } };
  const posts = [];
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G()] }) });
  prober._now = () => 1_700_000_000_000 + 6 * 60_000;
  const restore = stubFetch(posts);
  try { await prober.probeOne(am.accounts[0]); } finally { restore(); }
  assert.equal(posts.length, 1);
});

test('RT2 (blocker): a general hold falls through to the model loop — a DYING Fable grant is still claimed', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.5, resetAt: now + 3 * DAY, isActive: true } };
  const dyingFable = G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt: now + 10 * H }, now);
  const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), dyingFable], now }), { peersWithRoom: () => 2 }, now);
  assert.equal(r.action?.grant?.id, 'f1', `dying Fable claimed (got ${r.reason})`);
  assert.equal(r.action?.reason, 'dying value');
});

test('RT3 (major): the reactive weekly-429 path holds even when the walled account\'s probe and listing are stale (the normal state at the wall)', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    self.resetGrants = { ...self.resetGrants, stale: true };          // the usage endpoint 429s at the wall
    self.quota.lastProbeOkAt = Date.now() - 30 * 60_000;              // probe not fresh
    self.status = 'throttled'; self.rateLimitedUntil = Date.now() + H;
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held');
    assert.equal(posts.length, 0);
    // control: a grant that dies before the refill is claimed on the same 429
    am.applyResetGrants(0, listing({ grants: [G({ endsAt: Date.now() + 10 * H })] }));
    self.resetGrants = { ...self.resetGrants, stale: true };
    await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'dying grant claimed');
  } finally { restore(); }
});

test('RT3 (major): reactive refill ≥ 24h → claims; peers stale → claims', async () => {
  for (const [name, setup] of Object.entries({
    'refill 30h away': am => { am.accounts[0].quota.unified7dReset = Date.now() + 30 * H; },
    'peer probes stale': am => { for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000; },
  })) {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      am.applyResetGrants(0, listing({ grants: [G()] }));
      setup(am);
      await am.tryReactiveClaim(am.accounts[0], { kind: 'weekly', weeklyUtil: 1 });
      assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, name);
    } finally { restore(); }
  }
});

// Red-team r2 #3: driven in SERVER order (server.js: markRateLimited → tryReactiveClaim).
test('RT2-3 (server order): a Fable 429 never spends a Fable reset on the fast path, and its retry-after is never read as the refill', async () => {
  for (const fableRoomOnPeers of [true, false]) {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      const self = am.accounts[0];
      self.quota.unified7d = 0.5; self.quota.unified7dReset = Date.now() + 3 * DAY;
      self.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } };   // the probe's measurement
      if (fableRoomOnPeers) for (const p of am.accounts.slice(1)) p.quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } };
      am.applyResetGrants(0, listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }));
      am.markRateLimited(0, 60, { status: 429, recordFailure: false, modelScope: 'fable' });
      const e = self.quota.scopedWeekly.fable;
      assert.equal(e.reactive, true, 'precondition: the 429 rewrote the bucket as a reactive mark');
      assert.ok(e.resetAt - Date.now() <= 61_000, 'precondition: the reactive resetAt IS the retry-after');
      assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), false, 'no attempt (pre-mortem #3: a 429 guess never spends)');
      assert.equal(posts.length, 0);
    } finally { restore(); }
  }
});

test('RT2-3 (server order): a WEEKLY 429\'s retry-after never stands in for the refill — the 7d reset stamp decides', async () => {
  for (const [name, resetIn, want] of [['7d reset 30h away, retry-after 60s', 30 * H, 1], ['7d reset 18h away, retry-after 60s', 18 * H, 0]]) {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      const self = am.accounts[0];
      self.quota.unified7dReset = Date.now() + resetIn;
      am.applyResetGrants(0, listing({ grants: [G()] }));
      const stampBefore = self.quota.unified7dReset;
      am.markRateLimited(0, 60, { status: 429, recordFailure: false });
      assert.equal(self.quota.unified7dReset, stampBefore, 'markRateLimited leaves the 7d stamp alone');
      await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
      assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, want, name);
    } finally { restore(); }
  }
});

// Red-team r2 #1: a held reset is never stranded when the usage endpoint goes dark.
function failingProber(am, posts, logs = []) {
  const p = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    probeFn: async () => ({ error: 'HTTP 429', status: 429 }),
    grantsFn: async () => ({ error: 'HTTP 429' }) });
  p._now = () => Date.now() + 6 * 60_000;   // past the grants cadence: the listing call runs (and fails)
  return p;
}

test('RT2-1 (major): held on a 429 → probe fails → peers go stale → the NEXT sweep claims through the stored listing', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    self.status = 'throttled'; self.rateLimitedUntil = Date.now() + 4 * H;
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held on the 429');
    const prober = failingProber(am, posts);
    await prober.probeOne(self);
    assert.equal(posts.length, 0, 'peers still fresh and roomy → still held');
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;   // the endpoint is dark for them too
    const r = await prober.probeOne(self);
    assert.equal(r.ok, false, 'precondition: this sweep\'s own probe failed');
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'capacity unknown → claimed');
  } finally { restore(); }
});

test('RT2-1 (major): probe ANSWERS but the listing call fails (stale) → a held wall is rescued once peers go stale', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held on the 429');
    const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
      probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H }, weeklyAbsent: false }),
      grantsFn: async () => ({ error: 'HTTP 429' }) });
    prober._now = () => Date.now() + 6 * 60_000;
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    const r = await prober.probeOne(self);
    assert.equal(r.ok, true, 'precondition: the usage probe itself succeeded');
    assert.equal(self.resetGrants.stale, true, 'precondition: the listing went stale this tick');
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
  } finally { restore(); }
});

test('RT2-1 (guard): the rescue honours a listing cooldown', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held on the 429');
    self.resetGrants = { ...self.resetGrants, cooldownUntil: Date.now() + H };
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    await failingProber(am, posts).probeOne(self);
    assert.equal(posts.length, 0, 'cooldown → no claim, even with capacity unknown');
  } finally { restore(); }
});

test('RT2-1 (control): the rescue only revisits a wall this pool HELD — a never-held wall with a dark endpoint keeps today\'s behaviour', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    am.applyResetGrants(0, listing({ grants: [G()] }));
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    await failingProber(am, posts).probeOne(am.accounts[0]);
    assert.equal(posts.length, 0);
  } finally { restore(); }
});

// Red-team r2 #2: two roomy peers carry ONE held wall, not four.
test('RT2-2 (major): 4 walled accounts, 2 roomy peers → exactly one holds, the other three claim', async () => {
  const posts = [];
  const logs = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(6);
    for (const a of am.accounts.slice(0, 4)) { a.quota.unified7d = 0.995; a.quota.unified7dReset = Date.now() + 18 * H; }
    const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
      probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H }, weeklyAbsent: false }),
      grantsFn: async () => listing({ grants: [G()] }) });
    prober._now = () => Date.now() + 6 * 60_000;
    for (const a of am.accounts.slice(0, 4)) await prober.probeOne(a);
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 3, logs.join(' | '));
    assert.equal(logs.filter(l => l.endsWith(`claim held (${HOLD})`)).length, 1);
    // A second sweep: the one holder keeps holding (its own hold isn't counted twice).
    const before = posts.length;
    await prober.probeOne(am.accounts[0]);
    assert.equal(posts.length, before, 'the sole holder is still held');
  } finally { restore(); }
});

test('RT2-2 (major): the same pool-wide budget on the 429 fast path', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(4);
    for (const a of am.accounts.slice(0, 2)) { a.quota.unified7d = 0.995; a.quota.unified7dReset = Date.now() + 18 * H; }
    am.applyResetGrants(0, listing({ grants: [G()] }));
    am.applyResetGrants(1, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(am.accounts[0], { kind: 'weekly', weeklyUtil: 1 }), false, 'first wall held');
    await am.tryReactiveClaim(am.accounts[1], { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'second wall claims: 2 peers carry only one');
  } finally { restore(); }
});

// The hold register: only a LIVE hold consumes another wall's budget.
// 4 accounts: c0, c1 walled (18h refill); c2, c3 roomy. c0 holds first; then a
// change to c0 decides whether c1 may hold too (2 peers carry one wall).
async function secondWallHolds(mutateFirst) {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(4);
    for (const a of am.accounts.slice(0, 2)) { a.quota.unified7d = 0.995; a.quota.unified7dReset = Date.now() + 18 * H; }
    am.applyResetGrants(0, listing({ grants: [G()] }));
    am.applyResetGrants(1, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(am.accounts[0], { kind: 'weekly', weeklyUtil: 1 }), false, 'c0 holds');
    mutateFirst(am.accounts[0]);
    const attempted = await am.tryReactiveClaim(am.accounts[1], { kind: 'weekly', weeklyUtil: 1 });
    return attempted === false && posts.length === 0;
  } finally { restore(); }
}

test('RT2-2 (register): a held wall consumes budget only while it is LIVE', async () => {
  assert.equal(await secondWallHolds(() => {}), false, 'control: c0 still holding → c1 claims');
  assert.equal(await secondWallHolds(a => { a.enabled = false; }), true, 'c0 disabled → no load, no budget');
  assert.equal(await secondWallHolds(a => { a.poolBenchedBy = 'cloud'; }), true, 'c0 benched to the team pool → not ours');
  assert.equal(await secondWallHolds(a => { a.quota.unified7d = 0.1; }), true, 'c0 left the wall (refill landed) → not holding');
  assert.equal(await secondWallHolds(a => { a.quota.unified7dReset = Date.now() - 1000; }), true, 'c0 refill time passed → not holding');
});

test('RT2-1 (rescue guard): a stale hold stamp on an account that has LEFT the wall never claims (the fast path trusts the 429, the rescue must not)', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held');
    self.quota.unified7d = 0.1;                                                     // the free refill landed
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    await failingProber(am, posts).probeOne(self);
    assert.equal(posts.length, 0, 'no claim at 10% used');
  } finally { restore(); }
});

test('RT2-1 (rescue): a probe that THROWS also rescues a held wall', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held');
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
      probeFn: async () => { throw new Error('socket hang up'); }, grantsFn: async () => ({ error: 'HTTP 429' }) });
    prober._now = () => Date.now() + 6 * 60_000;
    await prober.probeOne(self);
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
  } finally { restore(); }
});

test('RT2-1 (scope of the rescue): a sweep that decides FRESH (probe + listing fine) never routes through the fast path', async () => {
  const am = pool(3);
  const self = am.accounts[0];
  let reactiveCalls = 0;
  const real = am.tryReactiveClaim.bind(am);
  am.tryReactiveClaim = (...a) => { reactiveCalls++; return real(...a); };
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G()] }) });
  prober._now = () => Date.now() + 6 * 60_000;
  await prober.probeOne(self);
  await prober.probeOne(self);
  assert.equal(am.isHoldingWall(self), true, 'precondition: the sweep held and registered it');
  assert.equal(reactiveCalls, 0);
});

test('RT2-1 (noise): the held line prints once per hold, not once per failed sweep', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  const realLog = console.log;
  const lines = [];
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
    const prober = failingProber(am, posts);
    for (let i = 0; i < 3; i++) await prober.probeOne(self);     // peers fresh → still held each time
  } finally { console.log = realLog; restore(); }
  assert.equal(lines.filter(l => l.includes(`c0: at wall, claim held (${HOLD})`)).length, 1, lines.join(' | '));
});

test('RT2-2 (policy): holders multiply the peers needed', () => {
  const now = Date.now();
  const l = listing({ grants: [G({}, now)], now });
  assert.equal(why(acct({ now }), l, { peersWithRoom: () => 3, holdersInPool: () => 2 }, now).action?.reason, 'weekly at wall', '3 < 2×2');
  assert.equal(why(acct({ now }), l, { peersWithRoom: () => 4, holdersInPool: () => 2 }, now).reason, HOLD, '4 ≥ 2×2');
  assert.equal(why(acct({ now }), l, { peersWithRoom: () => 9, holdersInPool: () => 1.5 }, now).action?.reason, 'weekly at wall', 'non-integer holders → claim');
  assert.equal(why(acct({ now }), l, { peersWithRoom: () => 9, holdersInPool: () => 0 }, now).action?.reason, 'weekly at wall', 'zero holders is not a count (self is one) → claim');
});

test('RT4 (major): room is measured to the peer\'s CAP on both windows', () => {
  const now = Date.now();
  const wk = pool(3, now);
  wk.accounts[1].capUtilization = 0.70; wk.accounts[1].quota.unified7d = 0.64;   // 0.06 to the cap
  assert.equal(count(wk, now), 1, 'weekly: cap 0.70 at 0.64 → not counted');
  const ses = pool(3, now);
  ses.accounts[1].capUtilization = 0.70; ses.accounts[1].quota.unified7d = 0.30; ses.accounts[1].quota.unified5h = 0.50;
  assert.equal(count(ses, now), 1, '5h: cap 0.70 at 0.50 → 0.20 to the cap < 0.25');
  const ok = pool(3, now);
  ok.accounts[1].capUtilization = 0.80; ok.accounts[1].quota.unified7d = 0.40; ok.accounts[1].quota.unified5h = 0.50;
  assert.equal(count(ok, now), 2, 'cap 0.80: 0.40 weekly / 0.30 5h room → counts');
});

test('RT6 (minor): two local names for ONE account count once', () => {
  const now = Date.now();
  const am = pool(4, now);
  am.accounts[1].accountUuid = 'u-dup';
  am.accounts[2].accountUuid = 'u-dup';
  assert.equal(count(am, now), 2, 'u-dup once + the fourth account');
});

test('ROOM: a provider (GLM/Kimi) is not a Claude peer', () => {
  const am = pool(2);
  am.accounts[1].type = 'provider';
  assert.equal(count(am), 0);
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

// ── red-team round 3 (2026-11-13): the hold is for the GENERAL weekly wall ONLY ──
// Orchestrator decision: a per-model (Fable) wall and a dying-value grant claim
// exactly as at cb969da — no hold, no hold record, no rescue for them.
const fableWallProbe = (wk = 0.5, wkResetIn = 3 * DAY) => async () => ({
  fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: wk, resetAt: Date.now() + wkResetIn },
  scopedWeekly: { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } }, weeklyAbsent: false });
const fableRoomOn = ps => { for (const p of ps) p.quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } }; };

test('R3-1: a Fable WALL claims as at cb969da — no hold, whatever room the peers have; capacity is never asked', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H, isActive: true } };
  const asked = [];
  const r = why(acct({ wk: 0.5, resetIn: 3 * DAY, scoped, now }), listing({ grants: [G({ clears: ['seven_day_overage_included'] }, now)], now }),
    { peersWithRoom: (...a) => { asked.push(a); return 9; }, holdersInPool: () => 1 }, now);
  assert.equal(r.action?.reason, 'fable weekly at wall');
  assert.equal(r.heldScope ?? null, null, 'nothing held');
  assert.deepEqual(asked, [], 'a model wall never consults pool capacity');
});

test('R3-1 (sweep): a Fable wall is claimed on the FIRST sweep with Fable room on every peer, and no hold is recorded', async () => {
  const am = pool(3);
  const self = am.accounts[0];
  self.quota.unified7d = 0.5; self.quota.unified7dReset = Date.now() + 3 * DAY;
  fableRoomOn(am.accounts.slice(1));
  const posts = [];
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: fableWallProbe(), grantsFn: async () => listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }) });
  prober._now = () => Date.now() + 6 * 60_000;
  const restore = stubFetch(posts);
  try { await prober.probeOne(self); } finally { restore(); }
  assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'claimed at once');
  assert.equal(self._wallHold, undefined, 'no hold record for a model wall');
});

test('R3-1 (fast path): a 429 over a probe-measured Fable wall claims as at cb969da — no hold, no hold record', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    // general weekly below the wall but its refill 18h out: only "general only" keeps
    // this Fable 429 out of the hold (the general refill stamp would otherwise hold it)
    self.quota.unified7d = 0.5; self.quota.unified7dReset = Date.now() + 18 * H;
    self.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } };
    fableRoomOn(am.accounts.slice(1));
    am.applyResetGrants(0, listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), true, 'attempted');
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
    assert.equal(self._wallHold, undefined);
  } finally { restore(); }
});

test('R3-2: general wall HELD + a Fable WALL → nothing claimed (the account is benched by the general wall; a Fable reset buys nothing)', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H, isActive: true } };
  const grants = [G({}, now), G({ id: 'f1', clears: ['seven_day_overage_included'] }, now)];
  // real counter: peers that report NO Fable reading still carry the general wall
  // (unknown Fable binds nothing), so the general wall holds — and the Fable wall waits
  const am = pool(3, now);
  assert.equal(am.countPeersWithRoom(am.accounts[0], now), 2, 'precondition: the real counter finds 2 roomy peers');
  const real = () => am.countPeersWithRoom(am.accounts[0], now);
  for (const [name, peersWithRoom] of [['peers with no Fable reading (real counter)', real], ['room everywhere', () => 2]]) {
    const r = why(acct({ scoped, now }), listing({ grants, now }), { peersWithRoom }, now);
    assert.equal(r.action, null, `${name}: the Fable wall is not claimed (got ${r.action?.reason})`);
    assert.equal(r.reason, HOLD, name);
    assert.equal(r.heldScope, 'general', name);
  }
  // control: the general wall NOT held (one peer only) → the general grant is claimed, as today
  assert.equal(why(acct({ scoped, now }), listing({ grants, now }), peers(1), now).action?.reason, 'weekly at wall');
  // control: no general grant at all → the Fable wall claims as at cb969da
  assert.equal(why(acct({ scoped, now }), listing({ grants: [grants[1]], now }), peers(9), now).action?.reason, 'fable weekly at wall');
});

test('R3-2: general wall HELD + a DYING Fable grant → the Fable grant is claimed AND the general hold is still reported', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.5, resetAt: now + 3 * DAY, isActive: true } };
  const dyingFable = G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt: now + 10 * H }, now);
  const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), dyingFable], now }), peers(2), now);
  assert.equal(r.action?.grant?.id, 'f1');
  assert.equal(r.action?.reason, 'dying value');
  assert.equal(r.heldScope, 'general', 'the caller must still register the general hold');
  // control: nothing held → no heldScope on the same dying claim
  const c = why(acct({ wk: 0.5, resetIn: 3 * DAY, scoped, now }), listing({ grants: [G({}, now), dyingFable], now }), peers(2), now);
  assert.equal(c.action?.grant?.id, 'f1');
  assert.equal(c.heldScope ?? null, null);
});

test('R3-2/3 (sweep): a dying Fable claimed under a general hold registers the hold, and that Fable claim does not retire it', async () => {
  const am = pool(3);
  const self = am.accounts[0];
  const posts = [];
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H },
      scopedWeekly: { fable: { utilization: 0.5, resetAt: Date.now() + 3 * DAY, isActive: true } }, weeklyAbsent: false }),
    grantsFn: async () => listing({ grants: [G(), G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt: Date.now() + 10 * H })] }) });
  prober._now = () => Date.now() + 6 * 60_000;
  const restore = stubFetch(posts);
  try { await prober.probeOne(self); } finally { restore(); }
  assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'the dying Fable grant was claimed');
  assert.equal(am.isHoldingWall(self), true, 'the general hold is registered and still live');
});

test('R3-3: a general hold is retired only by a claim that clears the GENERAL weekly limit — never by a Fable claim', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(4);
    for (const a of am.accounts.slice(0, 2)) { a.quota.unified7d = 0.995; a.quota.unified7dReset = Date.now() + 18 * H; }
    am.applyResetGrants(0, listing({ grants: [G()] }));
    am.applyResetGrants(1, listing({ grants: [G()] }));
    const [c0, c1] = am.accounts;
    assert.equal(await am.tryReactiveClaim(c0, { kind: 'weekly', weeklyUtil: 1 }), false, 'c0 holds');
    const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null });
    const fable = G({ id: 'f1', clears: ['seven_day_overage_included'] });
    assert.equal(await prober._claimClaudeGrant(c0, { kind: 'grant', grant: fable, scope: 'fable', reason: 'dying value' }), true, 'precondition: Fable claimed');
    assert.equal(am.isHoldingWall(c0), true, 'a Fable claim leaves the general hold live');
    await am.tryReactiveClaim(c1, { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 2, 'c0 still holds → its budget is spent → c1 claims');
    const general = G({ id: 'g2' });
    assert.equal(await prober._claimClaudeGrant(c0, { kind: 'grant', grant: general, scope: 'general', reason: 'weekly at wall' }), true);
    assert.equal(am.isHoldingWall(c0), false, 'a general claim retires it');
  } finally { restore(); }
  // the fast path's own general claim retires it too
  const posts2 = [];
  const restore2 = stubFetch(posts2);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held');
    am.accounts[1].enabled = false;                                   // room gone → the next 429 claims
    await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
    assert.equal(posts2.filter(u => /reset_rate_limits/.test(u)).length, 1);
    assert.equal(am.isHoldingWall(self), false);
  } finally { restore2(); }
});

test('R3-4: a peer counts only if it shares a routable profile with the walled account (the router\'s _matchesProfile)', () => {
  const now = Date.now();
  const am = pool(3, now);
  am.accounts[1].profiles = ['team-b'];
  assert.equal(count(am, now), 1, 'a peer on another profile cannot take this account\'s traffic');
  am.accounts[1].profiles = ['all'];
  assert.equal(count(am, now), 1, 'r4 #5: a peer serving only "all" covers none of self\'s "claude" traffic — counted per profile, the thinnest decides');
  const split = pool(5, now);
  split.accounts[1].profiles = ['claude']; split.accounts[2].profiles = ['claude'];
  split.accounts[3].profiles = ['all']; split.accounts[4].profiles = ['all'];
  assert.equal(count(split, now), 2, 'two roomy peers for EACH of self\'s profiles → 2');
  split.accounts[4].profiles = ['team-x'];
  assert.equal(count(split, now), 1, '"all" now has one roomy peer → 1');
  const none = pool(3, now);
  none.accounts[0].profiles = [];
  assert.equal(count(none, now), 0, 'a self that serves no profile has no confirmed room (never an empty min)');
  const t = pool(3, now);
  t.accounts[0].profiles = ['team-a'];
  assert.equal(count(t, now), 0, 'self on a private profile: default peers share nothing');
  t.accounts[2].profiles = ['claude', 'team-a'];
  assert.equal(count(t, now), 1);
  // the router's own predicate decides (one definition of "can serve this traffic")
  const r = pool(3, now);
  r._matchesProfile = () => false;
  assert.equal(count(r, now), 0);
  // a self with no profiles set routes as the router's default (claude + all)
  const d = pool(3, now);
  delete d.accounts[0].profiles;
  assert.equal(count(d, now), 2);
});

test('R3-3 (boundary): a general claim stamped at the very millisecond of the hold retires it', () => {
  const now = Date.now();
  const am = pool(3, now);
  const self = am.accounts[0];
  am.noteWallHold(self, now - 1000);
  assert.equal(am.isHoldingWall(self, now), true, 'precondition: live');
  self.lastGeneralClaimAt = now - 1000;
  assert.equal(am.isHoldingWall(self, now), false);
  self.lastGeneralClaimAt = now - 1001;
  assert.equal(am.isHoldingWall(self, now), true, 'a general claim BEFORE the hold does not retire it');
  self.lastClaimAt = now;                                              // a later Fable claim
  assert.equal(am.isHoldingWall(self, now), true);
});

test('R3-3 (fast path): a Fable 429 claim on an account holding its general wall leaves the general hold live', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G(), G({ id: 'f1', clears: ['seven_day_overage_included'] })] }));
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'general wall held');
    self.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } };
    assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), true, 'precondition: the Fable 429 claims (as at cb969da)');
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
    assert.equal(am.isHoldingWall(self), true, 'the Fable claim refilled nothing the general hold waits on');
  } finally { restore(); }
});

// ── red-team round 4 (2026-11-13) ────────────────────────────────────────────
test('R4-1 (blocker): under the general hold a Fable WALL grant that would die before (or within a day after) the refill is still claimed', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H, isActive: true } };   // general refill: 18h (acct default)
  const fable = endsAt => G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt }, now);
  for (const [name, endsAt] of [['expires in 10h, before the refill', now + 10 * H], ['expires 12h after the refill', now + 18 * H + 12 * H]]) {
    const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), fable(endsAt)], now }), peers(2), now);
    assert.equal(r.action?.grant?.id, 'f1', `${name}: claimed (got ${r.reason})`);
    assert.equal(r.action?.reason, 'fable weekly at wall', name);
    assert.equal(r.heldScope, 'general', `${name}: the general hold is still reported`);
  }
  // it outlives the refill by a day or more (or never ends) → still skipped while held
  for (const [name, endsAt] of [['ends exactly a day after the refill', now + 18 * H + DAY], ['no end date', null]]) {
    const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), fable(endsAt)], now }), peers(2), now);
    assert.equal(r.action, null, name);
    assert.equal(r.reason, HOLD, name);
  }
});

test('R4-2 (major): after a Fable claim under the hold, a dark probe with no room left still claims the GENERAL reset (rescue and weekly 429)', async () => {
  for (const via of ['rescue', 'weekly 429']) {
    const am = pool(3);
    const self = am.accounts[0];
    const posts = [];
    const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
      probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.995, resetAt: Date.now() + 18 * H },
        scopedWeekly: { fable: { utilization: 0.5, resetAt: Date.now() + 3 * DAY, isActive: true } }, weeklyAbsent: false }),
      grantsFn: async () => listing({ grants: [G(), G({ id: 'f1', clears: ['seven_day_overage_included'], endsAt: Date.now() + 10 * H })] }) });
    prober._now = () => Date.now() + 6 * 60_000;
    const restore = stubFetch(posts);
    try {
      await prober.probeOne(self);
      assert.equal(posts.length, 1, `${via}: precondition — the dying Fable grant was claimed under the general hold`);
      assert.equal(am.isHoldingWall(self), true, `${via}: precondition — still holding`);
      for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;   // room can no longer be confirmed
      if (via === 'rescue') await failingProber(am, posts).probeOne(self);
      else await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 });
      assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 2, `${via}: the general reset is claimed`);
    } finally { restore(); }
  }
});

test('R4-2 (control): one claim per wall still holds for the general wall — a second weekly 429 after a general claim never re-claims', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G(), G({ id: 'g2' })] }));
    am.accounts[1].enabled = false;                                   // no room → the 429 claims
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), true);
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'no probe since the claim → no second claim');
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
  } finally { restore(); }
});

test('R4-3 (minor): a claim that spends a grant clearing the GENERAL weekly retires the hold, whatever the 429 kind or claim scope', async () => {
  const broad = () => G({ id: 'b1', clears: ['seven_day', 'seven_day_overage_included'] });
  // sweep: the model loop may pick a broad grant at scope 'fable'
  {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      const self = am.accounts[0];
      am.noteWallHold(self);
      assert.equal(am.isHoldingWall(self), true, 'precondition');
      const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null });
      assert.equal(await prober._claimClaudeGrant(self, { kind: 'grant', grant: broad(), scope: 'fable', reason: 'fable weekly at wall' }), true);
      assert.equal(am.isHoldingWall(self), false, 'sweep: a broad grant spent at a Fable wall refilled the general weekly');
    } finally { restore(); }
  }
  // fast path: a Fable 429 with only a broad grant left spends it
  {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      const self = am.accounts[0];
      am.applyResetGrants(0, listing({ grants: [broad()] }));
      assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'general wall held');
      self.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } };
      assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), true, 'precondition: the Fable 429 spends the broad grant');
      assert.equal(am.isHoldingWall(self), false, 'fast path: the broad grant refilled the general weekly');
    } finally { restore(); }
  }
});

test('R4-4 (minor): a hold is tied to the refill it waited for — a later weekly window is not the same hold', () => {
  const now = Date.now();
  const am = pool(3, now);
  const self = am.accounts[0];
  const refill = self.quota.unified7dReset;
  am.noteWallHold(self, now - 1000);
  assert.equal(self._wallHold.refillAt, refill, 'the hold records the refill it waits for');
  assert.equal(am.isHoldingWall(self, now), true, 'precondition: live');
  self.quota.unified7dReset = refill + 1000;                         // the same refill read with a second of jitter
  assert.equal(am.isHoldingWall(self, now), true, 'reading jitter is the same refill');
  self.quota.unified7dReset = refill + 7 * DAY;                      // the window rolled; a new wall
  assert.equal(am.isHoldingWall(self, now), false, 'a new weekly window is a new wall, not this hold');
  self.quota.unified7dReset = refill - H;                            // an earlier refill reading is still before the one held for
  assert.equal(am.isHoldingWall(self, now), true);
});

test('R4-6 (minor): a hold lets go before the stored listing ages past the 6h claim bound — never strands an unclaimable reset', async () => {
  for (const [name, ageMs, want] of [['listing 5h45m old', 5 * H + 45 * 60_000, 1], ['listing 1h old (control)', H, 0]]) {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const am = pool(3);
      am.applyResetGrants(0, listing({ grants: [G()] }), Date.now() - ageMs);
      await am.tryReactiveClaim(am.accounts[0], { kind: 'weekly', weeklyUtil: 1 });
      assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, want, `${name}: peers roomy`);
    } finally { restore(); }
  }
  // rescue: held while the listing was young; the endpoint stays dark; peers stay roomy
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    am.applyResetGrants(0, listing({ grants: [G()] }), Date.now() - 2 * H);
    assert.equal(await am.tryReactiveClaim(self, { kind: 'weekly', weeklyUtil: 1 }), false, 'held');
    await failingProber(am, posts).probeOne(self);
    assert.equal(posts.length, 0, 'listing 2h old → still held');
    self.resetGrants = { ...self.resetGrants, checkedAt: Date.now() - (5 * H + 45 * 60_000) };
    await failingProber(am, posts).probeOne(self);
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'listing near 6h → claimed while still claimable');
  } finally { restore(); }
});

test('R4-6 (boundary + sweep): the hold lets go at exactly 5h30m of listing age; the sweep applies the same rule; an unknown listing age claims', async () => {
  const bound = 6 * H - 30 * 60_000;
  for (const [name, age, want] of [['exactly 5h30m', bound, 1], ['1 ms younger', bound - 1, 0]]) {
    const posts = [];
    const restore = stubFetch(posts);
    try {
      const now = Date.now();
      const am = pool(3, now);
      am.applyResetGrants(0, listing({ grants: [G({}, now)], now }), now - age);
      await am.tryReactiveClaim(am.accounts[0], { kind: 'weekly', weeklyUtil: 1 }, now);
      assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, want, name);
    } finally { restore(); }
  }
  const now = Date.now();
  const l = { ...listing({ grants: [G({}, now)], now }), checkedAt: now - bound };
  assert.equal(why(acct({ now }), l, peers(9), now).action?.reason, 'weekly at wall', 'sweep: an aging listing claims too');
  const refill = now + 18 * H;
  assert.equal(policy.wallClaimHeld(refill, G({}, now), now, { peersWithRoom: () => 9, listingCheckedAt: null }), false, 'listing age unknown → claim');
  assert.equal(policy.wallClaimHeld(refill, G({}, now), now, { peersWithRoom: () => 9 }), true, 'no listing-age input → the rule does not apply');
});

test('R4-2 (control): one claim per wall still holds for a Fable wall — a second Fable 429 with no newer probe never re-claims', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    self.quota.unified7d = 0.5; self.quota.unified7dReset = Date.now() + 3 * DAY;
    const wall = () => { self.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } }; };
    am.applyResetGrants(0, listing({ grants: [G({ id: 'f1', clears: ['seven_day_overage_included'] }), G({ id: 'f2', clears: ['seven_day_overage_included'] })] }));
    wall();
    assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), true);
    wall();                                                         // the same wall reported again before any new probe
    assert.equal(await am.tryReactiveClaim(self, { kind: 'fable' }), false);
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1);
  } finally { restore(); }
});
