import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A blank weekly bar had TWO meanings and no way to tell them apart:
//   (a) this plan has no weekly cap   — healthy, nothing to show
//   (b) we could not read one yet     — a real gap worth worrying about
// Measured live 2026-08-06 against /api/oauth/usage:
//   mk@gomokka          limits=[session, weekly_all(48%), weekly_scoped/Fable] , seven_day set
//   privacy@gomokka.com limits=[session, weekly_scoped/Fable(inactive)]        , seven_day null
// and against z.ai's monitor endpoint on the `max` plan:
//   limits=[TIME_LIMIT(unit 5), TOKENS_LIMIT(unit 3 = 5h)] — no unit-6 weekly at all.

const acct = () => [{ name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }];

test('a probe reporting NO weekly marks the account uncapped, not unread', () => {
  const am = new AccountManager(acct(), 0.90);
  // The exact shape fetchUsage returns for privacy@gomokka.com.
  am.applyUsageData(0, { fiveHour: { utilization: 0.04, resetAt: Date.now() + 3600_000 }, sevenDay: null, scopedWeekly: {}, weeklyAbsent: true });
  assert.equal(am.accounts[0].quota.weeklyAbsent, true);
  assert.equal(am.accounts[0].quota.unified7d, null, 'no weekly reading is invented');
});

test('a probe carrying a weekly clears the uncapped flag', () => {
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, { fiveHour: null, sevenDay: null, scopedWeekly: {}, weeklyAbsent: true });
  assert.equal(am.accounts[0].quota.weeklyAbsent, true);
  // mk@gomokka's shape — a real weekly_all at 48%.
  am.applyUsageData(0, { fiveHour: null, sevenDay: { utilization: 0.48, resetAt: Date.now() + 5 * 86400_000 }, scopedWeekly: {}, weeklyAbsent: false });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false, 'must not stay "uncapped" once a cap appears');
  assert.equal(am.accounts[0].quota.unified7d, 0.48);
});

test('a HEADER update never claims an account is uncapped', () => {
  // Headers cannot see the limits[] array, so they must not be able to assert absence —
  // otherwise one header-driven update would mislabel a capped account as uncapped.
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, { fiveHour: null, sevenDay: { utilization: 0.5, resetAt: Date.now() + 1000 }, scopedWeekly: {}, weeklyAbsent: false });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false);
  // No weeklyAbsent key at all (the header path) — the flag must be left alone.
  am.applyUsageData(0, { fiveHour: { utilization: 0.1, resetAt: Date.now() + 1000 } });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false, 'a partial update must not flip the flag');
});

test('an uncapped account is NEVER benched by the weekly gate', () => {
  // The safety half: "no weekly cap" must not read as "weekly at 0%" in any gate,
  // nor accidentally bench the account. Drives real selection, not the predicate.
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, { fiveHour: { utilization: 0.04, resetAt: Date.now() + 3600_000 }, sevenDay: null, scopedWeekly: {}, weeklyAbsent: true });
  const lease = am.acquireAccount({ profile: 'claude' }, new Set());
  assert.ok(lease?.account, 'an uncapped account must still be routable');
  assert.equal(lease.account.name, 'a1');
});

// ── the display half: "none" vs "—" ──────────────────────────────────────────

test('z.ai plan with no weekly window sets the uncapped flag on a SUCCESSFUL poll', () => {
  const am = new AccountManager([
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
  // Exactly what classifyZaiLimit yields for the live `max` plan: a ses bucket, no wk.
  am.applyProviderUsage(0, { ses: { utilization: 0.01, resetAt: Date.now() + 4 * 3600_000 }, wk: null, source: 'zai' });
  assert.equal(am.accounts[0].quota.providerWk, null);
  assert.equal(am.accounts[0].quota.weeklyAbsent, true, 'a clean poll with no weekly means the plan has none');
});

test('a z.ai plan that DOES report a weekly clears the flag', () => {
  const am = new AccountManager([
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
  am.applyProviderUsage(0, { ses: { utilization: 0.01, resetAt: null }, wk: null, source: 'zai' });
  assert.equal(am.accounts[0].quota.weeklyAbsent, true);
  am.applyProviderUsage(0, { ses: { utilization: 0.01, resetAt: null }, wk: { utilization: 0.24, resetAt: Date.now() + 6 * 86400_000 }, source: 'zai' });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false);
  assert.equal(am.accounts[0].quota.providerWk, 0.24);
});

test('a FAILED provider poll must not claim the plan is uncapped', () => {
  const am = new AccountManager([
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
  am.applyProviderUsage(0, { ses: { utilization: 0.5, resetAt: null }, wk: { utilization: 0.3, resetAt: null }, source: 'zai' });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false);
  // A transient error returns early — the previous reading must survive untouched.
  am.applyProviderUsage(0, { error: 'HTTP 500' });
  assert.equal(am.accounts[0].quota.weeklyAbsent, false, 'an error must never assert absence');
  assert.equal(am.accounts[0].quota.providerWk, 0.3, 'and must not blank the last-known reading');
});

test('probe freshness: staleness is measured against the probe interval, not wall time', () => {
  const am = new AccountManager(acct(), 0.90);
  am.quotaProbeIntervalMs = 60_000;
  const q = am.accounts[0].quota;
  const now = Date.now();
  q.lastProbeOkAt = now;
  assert.equal(am._quotaProbeStale(am.accounts[0], now), false, 'just-probed is fresh');
  assert.equal(am._quotaProbeStale(am.accounts[0], now + 120_000), false, '2 min is within the window');
  assert.equal(am._quotaProbeStale(am.accounts[0], now + 200_000), true, 'past 3x interval is stale');
  // Never probed = "no data", not "stale".
  q.lastProbeOkAt = null;
  assert.equal(am._quotaProbeStale(am.accounts[0], now + 10 * 60_000), false);
});

// ── the SOURCE of the flag: derive it from the REAL captured payloads ─────────
//
// The tests above hand-feed `weeklyAbsent`, so oauth.js's derivation was unpinned:
// making it always-false survived the whole file. These replay the exact bodies
// captured from /api/oauth/usage on 2026-08-06 through the real fetchUsage.

import { fetchUsage } from '../src/oauth.js';

const PRIVACY_BODY = {           // no weekly_all, seven_day null → genuinely uncapped
  limits: [
    { kind: 'session', group: 'session', percent: 4, severity: 'normal', resets_at: '2026-08-06T23:19:59.062217+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
  ],
  five_hour: { utilization: 4, resets_at: '2026-08-06T23:19:59.062217+00:00' },
  seven_day: null,
};
const MK_BODY = {                // weekly_all present at 48%
  limits: [
    { kind: 'session', group: 'session', percent: 5, severity: 'normal', resets_at: '2026-08-06T23:19:59.461358+00:00', scope: null, is_active: false },
    { kind: 'weekly_all', group: 'weekly', percent: 48, severity: 'normal', resets_at: '2026-08-12T16:00:00.461382+00:00', scope: null, is_active: true },
    { kind: 'weekly_scoped', group: 'weekly', percent: 0, severity: 'normal', resets_at: null, scope: { model: { id: null, display_name: 'Fable' } }, is_active: false },
  ],
  five_hour: { utilization: 5, resets_at: '2026-08-06T23:19:59.461358+00:00' },
  seven_day: { utilization: 48, resets_at: '2026-08-12T16:00:00.461382+00:00' },
};

async function withStubbedFetch(body, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => body });
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('fetchUsage DERIVES weeklyAbsent from the real privacy@ payload', async () => {
  const usage = await withStubbedFetch(PRIVACY_BODY, () => fetchUsage('token'));
  assert.equal(usage.weeklyAbsent, true, 'no weekly_all + seven_day null ⇒ uncapped');
  assert.equal(usage.sevenDay, null);
  assert.equal(usage.fiveHour.utilization, 0.04, 'session still read correctly');
});

test('fetchUsage DERIVES weeklyAbsent=false from the real mk@gomokka payload', async () => {
  const usage = await withStubbedFetch(MK_BODY, () => fetchUsage('token'));
  assert.equal(usage.weeklyAbsent, false, 'weekly_all present ⇒ capped');
  assert.equal(usage.sevenDay.utilization, 0.48);
});

test('end-to-end: the real payloads drive the flag through applyUsageData', async () => {
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, await withStubbedFetch(PRIVACY_BODY, () => fetchUsage('t')));
  assert.equal(am.accounts[0].quota.weeklyAbsent, true);
  am.applyUsageData(0, await withStubbedFetch(MK_BODY, () => fetchUsage('t')));
  assert.equal(am.accounts[0].quota.weeklyAbsent, false, 'a later capped read must correct it');
  assert.equal(am.accounts[0].quota.unified7d, 0.48);
});

test('a FAILED usage read never asserts absence', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'boom' });
  try {
    const usage = await fetchUsage('token');
    assert.ok(usage.error, 'an error result is returned');
    assert.equal(usage.weeklyAbsent, undefined, 'an error must carry NO absence claim');
    // And an error must not flip an existing flag — asserted for BOTH the shape the
    // prober actually delivers (it returns early on error) and a direct delivery, so
    // the guard holds if any future caller stops filtering.
    for (const errShape of [usage, { error: 'boom' }, { error: 'boom', weeklyAbsent: true }]) {
      const am = new AccountManager(acct(), 0.90);
      am.applyUsageData(0, await withStubbedFetch(MK_BODY, () => fetchUsage('t')));
      am.applyUsageData(0, errShape);
      assert.equal(am.accounts[0].quota.weeklyAbsent, false,
        `an error result must never assert absence: ${JSON.stringify(errShape).slice(0, 60)}`);
      assert.equal(am.accounts[0].quota.unified7d, 0.48, 'nor blank the last-known reading');
    }
  } finally { globalThis.fetch = real; }
});

// ── the RENDER: what the user actually sees ──────────────────────────────────

import { TUI, __tuiTest } from '../src/tui.js';
const { strip } = __tuiTest;

test('RENDER: an uncapped account shows "none" in the Wk column, not a bare dash', async () => {
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, await withStubbedFetch(PRIVACY_BODY, () => fetchUsage('t')));
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /none/, 'the user must see WHY the bar is blank');
});

test('RENDER: an account whose weekly is merely UNREAD still shows a dash, not "none"', () => {
  // The distinction the whole change exists to make: never claim "no cap" for an
  // account we simply have not read yet.
  const am = new AccountManager(acct(), 0.90);
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.doesNotMatch(line, /none/, 'unread must NOT read as uncapped');
});

test('RENDER: a capped account shows its percentage, never "none"', async () => {
  const am = new AccountManager(acct(), 0.90);
  am.applyUsageData(0, await withStubbedFetch(MK_BODY, () => fetchUsage('t')));
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /48%/);
  assert.doesNotMatch(line, /none/);
});

test('RENDER: a z.ai provider with no weekly window shows "none"', () => {
  const am = new AccountManager([
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
  am.applyProviderUsage(0, { ses: { utilization: 0.01, resetAt: Date.now() + 4 * 3600_000 }, wk: null, source: 'zai' });
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /none/, 'GLM genuinely has no weekly window — say so');
});
