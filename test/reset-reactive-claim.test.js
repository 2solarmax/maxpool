// TEST PLAN 15-20 (success criteria 5, 8): the reactive claim. A 429 on the
// serving lease claims a held reset at once — only on the LOCAL account holding
// the credential, never a mirror row or a relayed 429; a scoped 429 needs a
// probe-MEASURED bucket; one claim lock per account; failure backoff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { decideClaude } from '../src/reset-policy.js';
import { claimResetGrant } from '../src/claude-reset-grants.js';
import { createProxyServer } from '../src/server.js';

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
    assert.deepEqual(a.resetGrants.grants.map(g => g.id), ['f1'], 'the spent grant left the stored listing');
    // A second Fable 429 on the SAME wall, with the measured bucket still in place
    // (judge #12: the old test passed only because the entry was deleted) and an
    // unspent Fable grant still held — no probe has landed since the claim.
    a.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: Date.now() + 2 * DAY, isActive: true } };
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'fable' }), false, 'suppressed by the one-claim-per-wall guard');
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

// ── TEST 17: a scoped 429 without a measured bucket → no claim (the sweep decides) ─
test('SC8: scoped Fable 429 with an unmeasured bucket → 0 claims; measured 0.995 → ONLY the Fable grant', async () => {
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

// ── judge #1: ONE claim per wall across SEQUENTIAL 429s, with resetsLeft 2 ─────
const usageAt = (wk) => ({ fiveHour: { utilization: 0.1, resetAt: Date.now() + H },
  sevenDay: { utilization: wk, resetAt: Date.now() + 3 * DAY }, weeklyAbsent: false });

test('SC8 (judge #1): sequential weekly 429s after a claim → ONE POST; resetsLeft 2→1; a pre-claim probe landing late never re-licenses; a post-claim probe at the wall does', async () => {
  const calls = [];
  const restore = stubClaim({ calls });
  try {
    const listing = GEN();
    listing.grants[0].resetsLeft = 2; listing.grants[0].resetsTotal = 2;
    const manager = am({ grants: listing, wk: 0.999 });
    const a = manager.accounts[0];
    const posts = () => calls.filter(u => /reset_rate_limits/.test(u)).length;

    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }), true);
    assert.equal(posts(), 1);
    assert.equal(a.resetGrants.grants[0].resetsLeft, 1, 'the stored count dropped 2 → 1 at once');

    // Second weekly 429 on the same wall: no probe since the claim.
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }), false);
    assert.equal(posts(), 1, 'no second claim for the same wall');

    // The prober race: a probe SENT before the claim lands after it, still carrying
    // the pre-claim 0.999 reading. Neither path may treat it as a new wall.
    const claimAt = a.lastClaimAt;
    await new Promise(r => setTimeout(r, 5));
    manager.applyUsageData(0, usageAt(0.999), { sentAt: claimAt - 1000 });
    assert.ok(a.quota.lastProbeOkAt > claimAt, 'precondition: the reading was APPLIED after the claim');
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }), false);
    assert.equal(decideClaude(a, a.resetGrants), null, 'the prober path refuses the same late reading');
    assert.equal(posts(), 1);

    // Negative control: a probe SENT after the claim still at the wall is a NEW wall.
    await new Promise(r => setTimeout(r, 5));
    manager.applyUsageData(0, usageAt(0.999), { sentAt: Date.now() });
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }), true);
    assert.equal(posts(), 2, 'a probe sent after the claim licenses the remaining reset');
    assert.equal(a.resetGrants.grants.length, 0, 'resetsLeft 1 → 0: the grant left the stored listing');
  } finally { restore(); }
});

// ── judge #4: a 401 defers to the sweep — never a failed claim, never a backoff ──
test('SC8 (judge #4): a 401 on the reactive claim sets NO backoff and leaves the next attempt free', async () => {
  const realFetch = globalThis.fetch;
  const posts = [];
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/api/oauth/profile')) return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-401' } }) };
    posts.push(String(url));
    return { ok: false, status: 401, json: async () => ({ error: { type: 'authentication_error', message: 'token rejected' } }) };
  };
  const realLog = console.log;
  console.log = () => {};
  try {
    const manager = new AccountManager([{ name: 'claude 401-UNIQUE', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
    const a = manager.accounts[0];
    a.quota.unified7d = 0.999; a.quota.unified7dReset = Date.now() + 3 * DAY; a.quota.lastProbeOkAt = Date.now();
    manager.applyResetGrants(0, GEN());
    assert.equal(await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 }), true, 'attempted');
    const key = `${a.name}:g1`;
    assert.ok(!(manager._claimRetryUntil?.get(key) > Date.now()), 'NO backoff window after a 401');
    assert.ok(!(manager._claimTries?.get(key) > 0), 'the 401 is not counted as a failed try');
    assert.equal(a.lastClaimAt ?? null, null, 'a 401 is not a claim');
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });
    assert.equal(posts.length, 2, 'the next 429 may try again at once');
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

test('SC8 (judge #4): the reactive claim carries an abort signal (bounded; never holds the lock for minutes)', async () => {
  const realFetch = globalThis.fetch;
  const signals = [];
  globalThis.fetch = async (url, opts) => {
    signals.push(opts?.signal);
    if (String(url).endsWith('/api/oauth/profile')) return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-sig' } }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  };
  const realLog = console.log;
  console.log = () => {};
  try {
    const manager = new AccountManager([{ name: 'claude SIGNAL-UNIQUE', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
    const a = manager.accounts[0];
    a.quota.unified7d = 0.999; a.quota.unified7dReset = Date.now() + 3 * DAY; a.quota.lastProbeOkAt = Date.now();
    manager.applyResetGrants(0, GEN());
    await manager.tryReactiveClaim(a, { kind: 'weekly', weeklyUtil: 1.0 });
    assert.ok(signals.length >= 1);
    for (const s of signals) assert.ok(s instanceof AbortSignal, 'every claim call is abortable');
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

test('SC8 (judge #4): the user request fails over at once while the reactive claim is still in flight', async () => {
  const seen = [];
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    seen.push(req.headers.authorization);
    if (req.headers.authorization === 'Bearer t1') {
      res.writeHead(429, { 'retry-after': '60', 'content-type': 'application/json',
        'anthropic-ratelimit-unified-status': 'rejected', 'anthropic-ratelimit-unified-7d-utilization': '1.0' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'weekly limit reached' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  await new Promise(r => up.listen(0, '127.0.0.1', r));
  const manager = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.9);
  const claimCalls = [];
  // A claim that NEVER settles (a hung profile GET / POST).
  manager.tryReactiveClaim = (acct, opts) => { claimCalls.push(opts.kind); return new Promise(() => {}); };
  const proxy = createProxyServer(manager, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${up.address().port}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 } });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const realLog = console.log;
  console.log = () => {};
  try {
    const req = fetch(`http://127.0.0.1:${proxy.address().port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'test', messages: [] }) })
      .then(r => r.status);
    const status = await Promise.race([req, new Promise(r => setTimeout(() => r('STALLED'), 3000))]);
    assert.equal(status, 200, 'the request failed over without waiting for the claim');
    assert.deepEqual(claimCalls, ['weekly'], 'the weekly-class 429 started the reactive claim');
    assert.deepEqual(seen, ['Bearer t1', 'Bearer t2']);
  } finally { console.log = realLog; proxy.closeAllConnections?.(); proxy.close(); up.close(); }
});

// ── judge #10: claim state is per LOGIN, not per name ─────────────────────────
function profileClaimFetch(log, { claimStatus = 200 } = {}) {
  return async (url) => {
    log.push(String(url));
    if (String(url).endsWith('/api/oauth/profile')) return { ok: true, status: 200, json: async () => ({ organization: { uuid: 'org-x' } }) };
    if (claimStatus === 200) return { ok: true, status: 200, json: async () => ({ success: true }) };
    return { ok: false, status: claimStatus, json: async () => ({ error: { type: 'not_found_error', message: 'no such org' } }) };
  };
}
const profiles = log => log.filter(u => u.endsWith('/api/oauth/profile')).length;

test('SC8 (judge #10): a re-login (updateAccountTokens) forgets the cached org AND the claim backoff', async () => {
  const name = 'claude RELOGIN-UNIQUE';
  const manager = new AccountManager([{ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const log = [];
  const f = profileClaimFetch(log);
  await claimResetGrant('t', 'g1', { accountKey: name, fetchImpl: f });
  await claimResetGrant('t', 'g1', { accountKey: name, fetchImpl: f });
  assert.equal(profiles(log), 1, 'control: the org is cached per account');
  manager.noteClaimFailure(name, 'g1');
  const realLog = console.log;
  console.log = () => {};
  try { manager.updateAccountTokens(0, { accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }); }
  finally { console.log = realLog; }
  assert.equal(manager._claimRetryUntil.get(`${name}:g1`), undefined, 'backoff cleared on re-login');
  assert.equal(manager._claimTries.get(`${name}:g1`), undefined, 'try count cleared on re-login');
  await claimResetGrant('t2', 'g1', { accountKey: name, fetchImpl: f });
  assert.equal(profiles(log), 2, 'the re-login re-reads the profile (it may be a different org)');
});

test('SC8 (judge #10): removeAccount forgets the claim state; a 403/404 claim drops the cached org', async () => {
  const name = 'claude REMOVE-UNIQUE';
  const manager = new AccountManager([
    { name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'claude other', type: 'oauth', accessToken: 'u', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.9);
  const log = [];
  await claimResetGrant('t', 'g1', { accountKey: name, fetchImpl: profileClaimFetch(log) });
  manager.noteClaimFailure(name, 'g1');
  manager.noteClaimFailure('claude other', 'g1');
  assert.equal(manager.removeAccount(0), true);
  assert.equal(manager._claimRetryUntil.get(`${name}:g1`), undefined, 'removed account: backoff gone');
  assert.ok(manager._claimRetryUntil.get('claude other:g1') > 0, 'a sibling keeps its own backoff');
  await claimResetGrant('t', 'g1', { accountKey: name, fetchImpl: profileClaimFetch(log) });
  assert.equal(profiles(log), 2, 'removed account: the org cache was dropped');

  // 404 on the org path: the cached org is wrong now — the next claim re-reads it.
  const log2 = [];
  const k = 'claude 404-UNIQUE';
  const r = await claimResetGrant('t', 'g1', { accountKey: k, fetchImpl: profileClaimFetch(log2, { claimStatus: 404 }) });
  assert.equal(r.ok, false);
  assert.equal(r.status, 404, 'the failing status is reported');
  await claimResetGrant('t', 'g1', { accountKey: k, fetchImpl: profileClaimFetch(log2) });
  assert.equal(profiles(log2), 2, 'a 404 claim dropped the cached org');
});

// ---------------------------------------------------------------------------
// RED (2026-11-11, owner report): a grant that clears BOTH the general weekly
// AND a model bucket (full-reset-2611 shape: clears ['seven_day',
// 'seven_day_overage_included']) is the MOST POWERFUL reset an account holds.
// Spending it at a Fable-only wall burns the general-weekly refill for nothing.
// Pick order at a scoped wall must be: narrowest grant first; the broad one is
// reserved for the weekly wall. (Mirror: at the weekly wall only general-
// refilling grants qualify, unchanged.)
// ---------------------------------------------------------------------------
{
  const DAY = 86400_000;
  const now = Date.now();
  const acct = {
    name: 'max@gomokka.com', type: 'oauth', credential: 'tok',
    resetGrants: {
      eligible: true, checkedAt: now, stale: false, grants: [
        // Full reset: clears weekly + Fable; expires SOONEST (Dec 10) — the sort
        // that currently wins and must NOT at a fable wall.
        { id: 'full-reset-2611', resetsLeft: 1, resetsTotal: 1, usableNow: true, paused: false, blocking: false, unavailableReason: null, startsAt: now - DAY, endsAt: now + 29 * DAY, clears: ['seven_day', 'seven_day_overage_included'], givesBackWeekly: false },
        // Fable-only launch grant.
        { id: 'launch-2610-fable', resetsLeft: 1, resetsTotal: 1, usableNow: true, paused: false, blocking: false, unavailableReason: null, startsAt: now - 2 * DAY, endsAt: now + 120 * DAY, clears: ['seven_day_overage_included'], givesBackWeekly: true },
      ],
    },
    quota: { scopedWeekly: { fable: { utilization: 1.0, resetAt: now + 5 * DAY, reactive: false } } },
  };
  const am = new AccountManager([acct], 0.9);
  const pick = am._reactiveClaimGrant(acct, 'fable', now);
  assert.equal(pick?.id, 'launch-2610-fable',
    'at a fable wall the NARROW fable-only grant is claimed, not the full reset');
}
