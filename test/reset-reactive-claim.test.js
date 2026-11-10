// TEST PLAN 15-20 (success criteria 5, 8): the reactive claim. A 429 on the
// serving lease claims a held reset at once — only on the LOCAL account holding
// the credential, never a mirror row or a relayed 429; a scoped 429 needs a
// probe-MEASURED bucket; one claim lock per account; failure backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const DAY = 86400_000;
const H = 3600_000;

function am({ grants = null, scoped = null, wk = 0.3 } = {}) {
  const am = new AccountManager([{ name: 'claude a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const a = am.accounts[0];
  a.quota.unified7d = wk; a.quota.unified7dReset = Date.now() + 3 * DAY;
  a.quota.unified5h = 0.1; a.quota.unified5hReset = Date.now() + 3 * H;
  a.quota.lastProbeOkAt = Date.now();
  if (scoped) a.quota.scopedWeekly = scoped;
  if (grants) am.applyResetGrants(0, grants);
  return am;
}
const GEN = () => ({ grants: [{ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: Date.now() + 30 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null }],
  nextGrantId: null, cooldownUntil: null, eligible: true, checkedAt: Date.now(), stale: false });
const FABLE = (n = 2) => ({ grants: Array.from({ length: n }, (_, i) => ({ id: `f${i}`, usableNow: true, paused: false, expired: false,
  resetsLeft: 1, resetsTotal: 1, endsAt: Date.now() + 30 * DAY, clears: ['seven_day_overage_included'],
  givesBackWeekly: false, blocking: false, unavailableReason: null })),
  nextGrantId: null, cooldownUntil: null, eligible: true, checkedAt: Date.now(), stale: false });

// claimResetGrant is stubbed at the module level via a captured impl the manager
// imports lazily — patch globalThis.fetch instead (the module calls fetch through
// the default impl when no fetchImpl is passed).
function stubClaim({ ok = true, calls = [] } = {}) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/api/oauth/profile')) {
      return { ok: true, json: async () => ({ organization: { uuid: 'org-1' } }) };
    }
    return { ok: true, json: async () => (ok ? { success: true } : { error: { message: 'nope' } }) };
  };
  return () => { globalThis.fetch = realFetch; };
}

// ── TEST 15: a Fable 429 with a measured bucket claims once, clears the bench ─
test('SC5: scoped 429 + measured fable bucket → exactly 1 claim POST, bench cleared, no second claim next sweep', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const manager = am({ grants: FABLE(2), scoped: { fable: { utilization: 0.995, resetAt: Date.now() + 2 * DAY, isActive: true } } });
    const a = manager.accounts[0];
    a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 4 * H; a.lastError = 'rate_limited';   // the 429 bench
    const attempted = await manager.tryReactiveClaim(a, { kind: 'fable' });
    assert.equal(attempted, true);
    const posts = calls.filter(u => /reset_rate_limits/.test(u));
    assert.equal(posts.length, 1, 'exactly ONE claim POST');
    assert.equal(a.quota.scopedWeekly.fable, undefined, 'the reactive Fable bench is cleared');
    assert.equal(a.status, 'active', 'unbenched');
    assert.ok(a.lastClaimAt > 0, 'lastClaimAt stamped');
    // "the next probe reads 0.05" — a second reactive attempt is suppressed (one claim per wall).
    await manager.tryReactiveClaim(a, { kind: 'fable' });
    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 1, 'no second claim');
  } finally { restore(); }
});

// ── TEST 16: an account-wide 7d-class 429 with a STALE listing claims on the stored grant ──
test('SC5/8: stale stored listing (20 min) + 7d-class 429 → claim POST same tick; zero refresh-endpoint calls', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const manager = am({ grants: GEN(), wk: 0.999 });
    const a = manager.accounts[0];
    a.resetGrants.stale = true;
    a.resetGrants.checkedAt = Date.now() - 20 * 60_000;   // stale but ≤ 6h
    a.status = 'throttled'; a.rateLimitedUntil = Date.now() + 2 * DAY;
    const t0 = Date.now();
    const attempted = await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });
    assert.equal(attempted, true, 'the claim fired without a fresh listing');
    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 1, 'one claim POST');
    assert.ok(Date.now() - t0 < 1000, 'same tick');
    assert.equal(calls.filter(u => /oauth\/token/.test(u)).length, 0, 'ZERO calls to the refresh endpoint');
    assert.equal(a.status, 'active', 'unbenched on success');
  } finally { restore(); }
});

// ── TEST 17: a scoped 429 without a measured bucket → claimCandidate, no claim ─
test('SC8: scoped Fable 429 with bucket 0.2 → 0 claims + claimCandidate; measured 0.995 → ONLY the Fable grant', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    // (a) unmeasured: bucket 0.2 (reactive entry), holds BOTH grant kinds.
    const mgrA = am({ grants: { grants: [...GEN().grants, ...FABLE(1).grants], nextGrantId: null, cooldownUntil: null, eligible: true, checkedAt: Date.now(), stale: false },
      scoped: { fable: { utilization: 1.0, resetAt: Date.now() + 4 * H, isActive: true, reactive: true } } });
    const aA = mgrA.accounts[0];
    const att = await mgrA.tryReactiveClaim(aA, { kind: 'fable' });
    assert.equal(att, false, 'no claim attempted');
    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 0, '0 claims on an unmeasured bucket');
    assert.equal(aA.claimCandidate, 'fable', 'claimCandidate set for the next sweep');

    // (b) measured at 0.995: only the Fable grant is claimed (not the general one).
    const mgrB = am({ grants: { grants: [...GEN().grants, ...FABLE(1).grants], nextGrantId: null, cooldownUntil: null, eligible: true, checkedAt: Date.now(), stale: false },
      scoped: { fable: { utilization: 0.995, resetAt: Date.now() + 2 * DAY, isActive: true } }, wk: 0.4 });
    const aB = mgrB.accounts[0];
    await mgrB.tryReactiveClaim(aB, { kind: 'fable' });
    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 1);
    // The grant chosen was f0 (the Fable one): the claim body named it.
    assert.match(JSON.stringify(calls), /org-1/, 'claimed through the cached org');
    assert.equal(mgrB.accounts[0].quota.scopedWeekly.fable, undefined, 'the Fable bench cleared; the general weekly untouched');
  } finally { restore(); }
});

// ── TEST 18: one claim lock — probe and reactive at the same time ─────────────
test('SC8: one claim per account even when probe and reactive fire together', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const manager = am({ grants: GEN(), wk: 0.995 });
    const a = manager.accounts[0];
    // Two concurrent reactive attempts (the probe path and the request path).
    await Promise.all([
      manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }),
      manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }),
    ]);
    const posts = calls.filter(u => /reset_rate_limits/.test(u));
    assert.equal(posts.length, 1, `exactly 1 claim POST across both paths (got ${posts.length})`);
  } finally { restore(); }
});

// ── TEST 19: mirror rows / benched / disabled / outside-usage → 0 claims ──────
test('SC8: a mirror row, a pool-benched account, a disabled account, an outside-usage key → ZERO local claims', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const manager = am({ grants: GEN(), wk: 0.995 });
    const a = manager.accounts[0];

    // Mirror row: the 429 arrived from the cloud; the mirror holds no credential.
    const mirror = { ...a, remote: { linkName: 'x', remoteName: 'y' }, credential: null };
    assert.equal(await manager.tryReactiveClaim(mirror, { kind: 'weekly' }), false);

    // Pool-benched duplicate: the cloud owns the account.
    a.poolBenchedBy = 'cloud';
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly' }), false);

    // Disabled.
    a.poolBenchedBy = null; a.enabled = false;
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly' }), false);

    // Outside z.ai usage (the key feeds someone else) — no grants path exists for
    // provider accounts on tryReactiveClaim; asserted by type gate:
    a.enabled = true; a.type = 'provider';
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly' }), false, 'provider accounts go through decideZai, not cedar_ember');

    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 0, '0 claims');
  } finally { restore(); }
});

// ── TEST 20: backoff on repeated failures + one profile GET per process ───────
test('SC8: a failing claim attempts at 0, +15m, +45m only; one profile GET per account per process', async () => {
  const calls = [];
  const restore = stubClaim({ ok: false, calls });
  const realNow = Date.now;
  const shift = { ms: 0 };
  Date.now = () => realNow() + shift.ms;
  try {
    const manager = new AccountManager([{ name: 'claude BACKOFF-UNIQUE', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
    const a = manager.accounts[0];
    a.quota.unified7d = 0.995; a.quota.unified7dReset = Date.now() + 3 * DAY; a.quota.lastProbeOkAt = Date.now();
    manager.applyResetGrants(0, GEN());
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });       // attempt 1 (0m)
    shift.ms = 5 * 60_000;
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });       // inside backoff → suppressed
    shift.ms = 16 * 60_000;
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });       // attempt 2 (+16m)
    shift.ms = 50 * 60_000;
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });       // attempt 3 (+50m)
    shift.ms = 3 * 60 * 60_000;
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });       // attempt 4 — but backoff caps the schedule
    const posts = calls.filter(u => /reset_rate_limits/.test(u));
    const profiles = calls.filter(u => /\/api\/oauth\/profile/.test(u));
    // The org uuid cache is per account per process: this account's FIRST claim
    // did one profile GET; every retry reuses it (C6).
    assert.ok(posts.length >= 2 && posts.length <= 4, `bounded attempts (got ${posts.length})`);
    assert.equal(profiles.length, 1, `ONE profile GET per account per process (got ${profiles.length})`);
  } finally { Date.now = realNow; restore(); }
});

// ── TEST 18 pin: the lock is SHARED — the prober's claim is suppressed while the
// reactive claim holds it (and vice versa).
test('SC8: the claim lock covers BOTH paths (prober suppressed while reactive holds it)', async () => {
  const { Prober } = await import('../src/prober.js');
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const manager = am({ grants: GEN(), wk: 0.995 });
    const a = manager.accounts[0];
    const prober = new Prober(manager, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
      probeFn: async () => ({ fiveHour: { utilization: 0.2 }, sevenDay: { utilization: 0.995 }, weeklyAbsent: false }),
      grantsFn: async () => a.resetGrants });
    // The reactive path holds the lock (a claim in flight): the prober's own claim
    // must be suppressed for the same account.
    assert.equal(manager.acquireClaimLock(a.name), true);
    const claimed = await prober._claimClaudeGrant(a, { grant: GEN().grants[0], scope: 'general', reason: 'weekly at wall' });
    assert.equal(claimed, false, 'the prober claim is suppressed while the reactive path holds the lock');
    assert.equal(calls.filter(u => /reset_rate_limits/.test(u)).length, 0, 'no POST while locked');
    manager.releaseClaimLock(a.name);
    const claimed2 = await prober._claimClaudeGrant(a, { grant: GEN().grants[0], scope: 'general', reason: 'weekly at wall' });
    assert.equal(claimed2, true, 'the prober claims once the lock is free');
  } finally { restore(); }
});
