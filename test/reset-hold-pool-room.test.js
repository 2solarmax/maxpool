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
const count = (am, scope = 'general', now = Date.now()) => am.countPeersWithRoom(am.accounts[0], scope, now);

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
  assert.equal(count(am, 'general', now), 1);
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
  assert.equal(count(am, 'general', now), 2);
  const am2 = pool(3, now);
  am2.accounts[1].quota.unified5h = 0.65;                         // exactly switchThreshold - holdPeerSessionRoom
  assert.equal(count(am2, 'general', now), 2);
});

// ── red-team round 1 (2026-11-13) ────────────────────────────────────────────
test('RT1 (blocker): a GENERAL hold never leans on peers whose model limit is exhausted or full — Fable would have no route', () => {
  const now = Date.now();
  const exhausted = { fable: { utilization: 1.0, resetAt: now + DAY, isActive: true } };
  const am = pool(3, now);
  am.accounts[1].quota.scopedWeekly = structuredClone(exhausted);
  am.accounts[2].quota.scopedWeekly = structuredClone(exhausted);
  assert.equal(count(am, 'general', now), 0, 'Fable-exhausted peers cannot carry the walled account');
  const cases = {
    'fable measured full (0.80, no room)': { fable: { utilization: 0.80, resetAt: now + DAY } },
    'fable reactive 429 mark': { fable: { utilization: 1.0, resetAt: now + DAY, reactive: true } },
    'opus exhausted': { opus: { utilization: 0.999, resetAt: now + DAY } },
  };
  for (const [name, sw] of Object.entries(cases)) {
    const a = pool(3, now);
    a.accounts[1].quota.scopedWeekly = sw;
    assert.equal(count(a, 'general', now), 1, name);
  }
  // A peer with a roomy model bucket (or none reported) still counts for the general hold.
  const ok = pool(3, now);
  ok.accounts[1].quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: now + DAY } };
  assert.equal(count(ok, 'general', now), 2);
  // An INACTIVE model limit binds nothing (same rule as the router's _scopedExhausted).
  const inactive = pool(3, now);
  inactive.accounts[1].quota.scopedWeekly = { fable: { utilization: 1.0, resetAt: now + DAY, isActive: false } };
  assert.equal(count(inactive, 'general', now), 2);
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

test('RT2 (blocker): general held + a Fable WALL with no Fable room on peers → the Fable grant is claimed', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H, isActive: true } };
  const fableG = G({ id: 'f1', clears: ['seven_day_overage_included'] }, now);
  const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), fableG], now }),
    { peersWithRoom: s => (s === 'general' ? 2 : 0) }, now);
  assert.equal(r.action?.grant?.id, 'f1');
  assert.equal(r.action?.reason, 'fable weekly at wall');
  // both held → the reason is still the hold
  const h = why(acct({ scoped, now }), listing({ grants: [G({}, now), fableG], now }), { peersWithRoom: () => 2 }, now);
  assert.equal(h.action, null);
  assert.equal(h.reason, HOLD);
});

test('RT2 (fall-through, model loop): a held model wall does not stop a LATER model\'s wall from being claimed', () => {
  // Only `fable` maps from the grant keys today; inject a second family so the
  // model loop's own hold must fall through rather than return.
  const now = Date.now();
  const famOf = g => (g.id === 'f1' ? ['fable'] : g.id === 'o1' ? ['opus'] : []);
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H }, opus: { utilization: 0.995, resetAt: now + 18 * H } };
  const r = decideClaudeWithReason(acct({ wk: 0.5, resetIn: 3 * DAY, scoped, now }),
    listing({ grants: [G({ id: 'f1' }, now), G({ id: 'o1', endsAt: now + 40 * DAY }, now)], now }), now,
    { now, appliesTo: famOf, peersWithRoom: s => (s === 'fable' ? 2 : 0) });
  assert.equal(r.action?.grant?.id, 'o1', `opus has no room elsewhere → claimed (got ${r.reason})`);
  assert.equal(r.action?.reason, 'opus weekly at wall');
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

test('RT2-1 (major): a sweep-held FABLE wall is rescued the same way once Fable room can no longer be confirmed', async () => {
  const posts = [];
  const restore = stubFetch(posts);
  try {
    const am = pool(3);
    const self = am.accounts[0];
    self.quota.unified7d = 0.5; self.quota.unified7dReset = Date.now() + 3 * DAY;
    for (const p of am.accounts.slice(1)) p.quota.scopedWeekly = { fable: { utilization: 0.2, resetAt: Date.now() + DAY } };
    const okProber = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
      probeFn: async () => ({ fiveHour: { utilization: 0.2, resetAt: Date.now() + H }, sevenDay: { utilization: 0.5, resetAt: Date.now() + 3 * DAY },
        scopedWeekly: { fable: { utilization: 0.995, resetAt: Date.now() + 18 * H, isActive: true } }, weeklyAbsent: false }),
      grantsFn: async () => listing({ grants: [G({ clears: ['seven_day_overage_included'] })] }) });
    okProber._now = () => Date.now() + 6 * 60_000;
    await okProber.probeOne(self);
    assert.equal(posts.length, 0, 'held by the sweep');
    const prober = failingProber(am, posts);
    await prober.probeOne(self);
    assert.equal(posts.length, 0, 'Fable room still confirmed → still held');
    for (const p of am.accounts.slice(1)) p.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
    await prober.probeOne(self);
    assert.equal(posts.filter(u => /reset_rate_limits/.test(u)).length, 1, 'Fable capacity unknown → claimed');
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
  assert.equal(await secondWallHolds(a => { a.lastClaimAt = Date.now() + 1000; }), true, 'c0 claimed since its hold → not holding');
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
  assert.equal(self._wallHold?.scope, 'general', 'precondition: the sweep held and registered it');
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

test('RT2-1 (register): both the weekly and a model wall held → the WEEKLY hold is registered (it covers every model)', () => {
  const now = Date.now();
  const scoped = { fable: { utilization: 0.995, resetAt: now + 18 * H } };
  const r = why(acct({ scoped, now }), listing({ grants: [G({}, now), G({ id: 'f1', clears: ['seven_day_overage_included'] }, now)], now }), peers(5), now);
  assert.equal(r.reason, HOLD);
  assert.equal(r.heldScope, 'general');
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
  assert.equal(count(wk, 'general', now), 1, 'weekly: cap 0.70 at 0.64 → not counted');
  const ses = pool(3, now);
  ses.accounts[1].capUtilization = 0.70; ses.accounts[1].quota.unified7d = 0.30; ses.accounts[1].quota.unified5h = 0.50;
  assert.equal(count(ses, 'general', now), 1, '5h: cap 0.70 at 0.50 → 0.20 to the cap < 0.25');
  const ok = pool(3, now);
  ok.accounts[1].capUtilization = 0.80; ok.accounts[1].quota.unified7d = 0.40; ok.accounts[1].quota.unified5h = 0.50;
  assert.equal(count(ok, 'general', now), 2, 'cap 0.80: 0.40 weekly / 0.30 5h room → counts');
});

test('RT6 (minor): two local names for ONE account count once', () => {
  const now = Date.now();
  const am = pool(4, now);
  am.accounts[1].accountUuid = 'u-dup';
  am.accounts[2].accountUuid = 'u-dup';
  assert.equal(count(am, 'general', now), 2, 'u-dup once + the fourth account');
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
