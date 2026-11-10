// TEST PLAN 1 + 10 (success criteria 7, 11, 8): grant scope classification and the
// grants-call pacing. Scope comes from Anthropic's own `clears` field via the one
// shared appliesTo(); missing fields fail CLOSED; the first listing per process
// logs the raw key set once; grants are listed at most once per 5 min per account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeGrant, appliesTo, listResetGrants, GRANT_SCOPE_BY_KEY, _resetGrantKeyLogForTest } from '../src/claude-reset-grants.js';
import { AccountManager } from '../src/account-manager.js';
import { Prober, GRANTS_EVERY_MS } from '../src/prober.js';

const DAY = 86400_000;
const now = Date.now();

// ── the committed redacted fixture: the observed field names parse ────────────
const fixture = JSON.parse(readFileSync(new URL('./fixtures/cedar-ember-listing.json', import.meta.url), 'utf8'));

test('fixture grants normalize with every observed field name (SC 7)', () => {
  const grants = fixture.cedar_ember.grants.map(g => normalizeGrant(g, now));
  assert.equal(grants.filter(Boolean).length, 2);
  // every measured grant clears seven_day_overage_included → model-scoped (fable);
  // grant 2 also clears five_hour (session)
  for (const g of grants) {
    assert.ok(appliesTo(g).includes('fable'), 'launch-2610-fable shape is Fable-scoped');
    assert.equal(g.usableNow, true);
    assert.equal(g.givesBackWeekly, false);
    assert.equal(g.blocking, false);
    assert.equal(g.unavailableReason, null);
    assert.equal(g.percentUsed, 0);
    assert.equal(g.requiresLimit, false, 'use_requires_limit:false parses');
  }
  assert.deepEqual(appliesTo(grants[0]), ['fable'], 'grant 1: fable only');
  assert.deepEqual(appliesTo(grants[1]), ['session', 'fable'], 'grant 2: fable + session');
});

// ── appliesTo: general / fable / session / unknown (SC 11) ────────────────────
test('appliesTo maps each clears key to its scope (D1)', () => {
  assert.deepEqual(appliesTo({ clears: ['seven_day'] }), ['general']);
  assert.deepEqual(appliesTo({ clears: ['five_hour'] }), ['session']);
  assert.deepEqual(appliesTo({ clears: ['seven_day_overage_included'] }), ['fable']);
  assert.deepEqual(appliesTo({ clears: ['five_hour', 'seven_day'] }), ['session', 'general']);
  assert.deepEqual(appliesTo({ clears: [] }), [], 'no keys → no scope');
  assert.deepEqual(appliesTo({}), [], 'no clears at all → no scope');
  assert.deepEqual(appliesTo(null), []);
});

test('unmapped clears key = no claim, no lift — never invented scope (SC 8)', () => {
  assert.deepEqual(appliesTo({ clears: ['seven_day_plus_v2'] }), [], 'unknown key contributes nothing');
  assert.equal(GRANT_SCOPE_BY_KEY['seven_day_plus_v2'], undefined, 'the map has no invented entries');
});

test('gives_back_weekly counts as general (the client OR rule)', () => {
  assert.deepEqual(appliesTo({ clears: ['seven_day_overage_included'], gives_back_weekly: true }), ['fable', 'general']);
  assert.deepEqual(appliesTo({ clears: [], gives_back_weekly: true }), ['general']);
});

// ── fail-closed normalizer (mutant: the old ['five_hour','seven_day'] default) ─
test('missing clears gives [] — scope unknown, shown never claimed (A1)', () => {
  const g = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, ends_at: now + 10 * DAY }, now);
  assert.deepEqual(g.clears, []);
  assert.deepEqual(appliesTo(g), []);
});

test('missing usable_now is FALSE (fail closed; A1)', () => {
  const g = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: ['seven_day'] }, now);
  assert.equal(g.usableNow, false, 'absence is not consent');
  const g2 = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: ['seven_day'], usable_now: false }, now);
  assert.equal(g2.usableNow, false);
  const g3 = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: ['seven_day'], usable_now: true }, now);
  assert.equal(g3.usableNow, true);
});

test('missing gives_back_weekly is false; present parses', () => {
  const g = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: ['seven_day'] }, now);
  assert.equal(g.givesBackWeekly, false);
  const g2 = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: [], gives_back_weekly: true }, now);
  assert.equal(g2.givesBackWeekly, true);
});

test('blocking / unavailable_reason / percent_used survive the normalizer', () => {
  const g = normalizeGrant({ id: 'x', resets_total: 1, resets_left: 1, clears: ['seven_day'],
    blocking: true, unavailable_reason: 'cooldown', percent_used: 42, usable_now: true }, now);
  assert.equal(g.blocking, true);
  assert.equal(g.unavailableReason, 'cooldown');
  assert.equal(g.percentUsed, 42);
});

// ── first listing per process logs the raw grant key set once (SC 3/2) ───────
test('the first listing logs the raw grant key set ONCE (keys only, no values)', async () => {
  _resetGrantKeyLogForTest();
  const logs = [];
  const realLog = console.log;
  console.log = m => logs.push(m);
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(fixture)) });
  try {
    await listResetGrants('tok', { fetchImpl });
    await listResetGrants('tok', { fetchImpl });
  } finally { console.log = realLog; }
  const keyLines = logs.filter(l => /cedar_ember grant keys:/.test(l));
  assert.equal(keyLines.length, 1, 'exactly one key-set line per process');
  assert.match(keyLines[0], /usable_now/, 'the observed key names appear');
  assert.ok(!/[0-9a-f-]{20,}/.test(keyLines[0]) || !fixture.cedar_ember.grants[0].id, 'no grant VALUE leaked (ids are placeholders here anyway)');
  assert.ok(!/Bearer|tok/.test(keyLines[0]), 'never a token');
});

// ── TEST 10: grants listed at most once per GRANTS_EVERY_MS per account (SC 8) ─
function amN(n = 3) {
  return new AccountManager(Array.from({ length: n }, (_, i) => ({
    name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
  })), 0.9);
}
const GOOD = () => ({ grants: [{ id: 'g1', usableNow: true, paused: false, resetsLeft: 1, resetsTotal: 1,
  endsAt: now + 119 * DAY, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null }], eligible: true });

test('grants are listed at most once per 5 min per account (A2)', async () => {
  const am = amN(2);
  let grantsCalls = 0;
  let clock = 1_700_000_000_000;
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.2 }, weeklyAbsent: false }),
    now: () => clock,
    grantsFn: async () => { grantsCalls++; return GOOD(); } });
  const sweep = () => { clock += 60_000; return prober.probeOne(am.accounts[0]); };
  await sweep(); await sweep(); await sweep(); await sweep();
  assert.equal(grantsCalls, 1, `back-to-back sweeps within the window → ONE listing call (got ${grantsCalls})`);
  clock += GRANTS_EVERY_MS;
  await sweep();
  assert.equal(grantsCalls, 2, 'a new 5-min window lists again');
});

test('a STALE listing retries at the short cadence, not 5 min (A2)', async () => {
  const am = amN(1);
  let mode = 'ok';
  let grantsCalls = 0;
  let clock = 1_700_000_000_000;
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ status: 500, error: 'x' }), now: () => clock,
    grantsFn: async () => { grantsCalls++; return mode === 'ok' ? GOOD() : { error: 'HTTP 502' }; } });
  await prober.probeOne(am.accounts[0]);
  assert.equal(grantsCalls, 1, 'first sweep lists');
  clock += 60_000;
  await prober.probeOne(am.accounts[0]);
  assert.equal(grantsCalls, 1, 'inside the window, a fresh listing is not re-listed');
  clock += GRANTS_EVERY_MS + 1000;
  mode = 'fail';
  await prober.probeOne(am.accounts[0]);
  assert.equal(grantsCalls, 2, 'a new window lists — and fails, marking the listing stale');
  clock += 60_000;                    // only 60s later, NOT 5 min
  await prober.probeOne(am.accounts[0]);
  assert.equal(grantsCalls, 3, 'a stale listing retries at the short cadence');
});

test('usage probe still fires every sweep (calls per sweep never exceed the old count)', async () => {
  const am = amN(1);
  let grantsCalls = 0, usageCalls = 0;
  let clock = 1_700_000_000_000;
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => { usageCalls++; return { fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.2 }, weeklyAbsent: false }; },
    now: () => clock,
    grantsFn: async () => { grantsCalls++; return GOOD(); } });
  for (let i = 0; i < 5; i++) { clock += 60_000; await prober.probeOne(am.accounts[0]); }
  assert.equal(usageCalls, 5, 'usage probe every sweep');
  assert.equal(grantsCalls, 1, 'grants at the 5-min cadence only');
  assert.ok(usageCalls + grantsCalls <= 5 * 2, 'total /api/oauth/usage calls never exceed the pre-change per-sweep count (2/account)');
});

// ── found in the judge-fix pass: the OR rule must hold for STORED (normalized) grants ──
test('gives-back-weekly counts as general on a NORMALIZED grant too (every stored grant is normalized)', async () => {
  const { decideClaude } = await import('../src/reset-policy.js');
  const raw = { id: 'gb', resets_total: 1, resets_left: 1, usable_now: true, use_requires_limit: true,
    clears: ['seven_day_overage_included'], gives_back_weekly: true, ends_at: new Date(Date.now() + 30 * DAY).toISOString() };
  const g = normalizeGrant(raw, Date.now());
  assert.deepEqual(appliesTo(g).sort(), ['fable', 'general'], 'normalized give-back grant applies to the general weekly');
  // And the policy claims it at the GENERAL weekly wall, as a give-back claim.
  const a = { name: 'a', enabled: true, lastClaimAt: null,
    quota: { unified7d: 0.995, unified7dReset: Date.now() + 3 * DAY, lastProbeOkAt: Date.now() } };
  const act = decideClaude(a, { grants: [g], eligible: true, stale: false, cooldownUntil: null });
  assert.ok(act, 'claimed at the general weekly wall');
  assert.equal(act.scope, 'general');
  assert.equal(act.giveBack, true, 'snapshotted as a give-back claim (measures the drop)');
});

// ── judge #11: an unmapped clears key is logged ONCE per process ──────────────
test('an unmapped clears key logs once per key per process (keys only, never values)', async () => {
  _resetGrantKeyLogForTest();
  const body = { cedar_ember: { eligible: true, grants: [
    { id: 'u1', resets_total: 1, resets_left: 1, usable_now: true, clears: ['seven_day', 'mystery_limit'], ends_at: new Date(Date.now() + 9 * DAY).toISOString() },
  ] } };
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => body });
  const logs = [];
  const realLog = console.log;
  console.log = m => logs.push(String(m));
  try {
    await listResetGrants('tok', { fetchImpl });
    await listResetGrants('tok', { fetchImpl });
  } finally { console.log = realLog; }
  const unmapped = logs.filter(l => /unmapped clears key/.test(l));
  assert.equal(unmapped.length, 1, `exactly one line across two listings (got ${unmapped.length})`);
  assert.match(unmapped[0], /"mystery_limit"/);
  assert.ok(!logs.some(l => /unmapped clears key "seven_day"/.test(l)), 'a mapped key never logs');
});

// ── judge #9 (A3): the token is refreshed BEFORE the grants listing ───────────
test('A3: probeOne refreshes the token before listing grants (the listing uses the fresh token)', async () => {
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 'old-tok', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }], 0.9);
  const a = am.accounts[0];
  const order = [];
  am.ensureTokenFresh = async () => { order.push('refresh'); a.credential = 'new-tok'; };
  const seen = [];
  const prober = new Prober(am, { intervalMs: 0, log: () => {}, providerProbeFn: async () => null,
    probeFn: async () => ({ fiveHour: { utilization: 0.1 }, sevenDay: { utilization: 0.2 }, weeklyAbsent: false }),
    grantsFn: async (cred) => { order.push('list'); seen.push(cred === 'new-tok' ? 'fresh' : 'stale'); return { grants: [], eligible: true }; } });
  await prober.probeOne(a);
  assert.deepEqual(order.slice(0, 2), ['refresh', 'list'], `refresh first (got ${order.join(',')})`);
  assert.deepEqual(seen, ['fresh'], 'the listing carried the refreshed token');
});
