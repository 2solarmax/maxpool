import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// The scoring and availability gates read unified7d/unified5h — Anthropic-only fields.
// Provider accounts (GLM/Kimi) carry quota in providerSes/providerWk, which were invisible:
// a Kimi at 83% weekly read as "unknown" = healthy, so the scheduler kept piling onto it
// instead of spreading to GLM. Measured 2026-08-08: Kimi at Wk 83%, GLM at Ses 26%,
// distribution heavily skewed to GLM-only after Kimi's 429 because sessions bound to GLM
// and never rebalanced back to Kimi (which appeared "healthy" = unknown).

const fleet = () => new AccountManager([
  { name: 'glm', type: 'provider', provider: 'zai', authToken: 'k1', upstream: 'https://api.z.ai/api/anthropic' },
  { name: 'kimi', type: 'provider', provider: 'kimi', authToken: 'k2', upstream: 'https://api.kimi.com/coding' },
], 0.90, { crossProviderFallbackPolicy: 'always' });

test('_weeklyRawState reads PROVIDER quota (was always "unknown")', () => {
  const am = fleet();
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  // Low usage → normal
  kimi.quota.providerWk = 0.3;
  assert.equal(am._weeklyRawState(kimi), 'normal');
  // 70% → soft
  kimi.quota.providerWk = 0.70;
  assert.equal(am._weeklyRawState(kimi), 'soft');
  // 83% → still soft (under reserve 0.85)
  kimi.quota.providerWk = 0.83;
  assert.equal(am._weeklyRawState(kimi), 'soft');
  // 90% → reserve
  kimi.quota.providerWk = 0.90;
  assert.equal(am._weeklyRawState(kimi), 'reserve');
  // 99.9% → exhausted (benched)
  kimi.quota.providerWk = 0.999;
  assert.equal(am._weeklyRawState(kimi), 'exhausted');
});

test('_weeklyRawState reads providerSes for a plan with no weekly', () => {
  const am = fleet();
  const glm = am.accounts.find(a => a.provider === 'zai');
  // GLM at 95% of its 5h session, no weekly
  glm.quota.providerSes = 0.95;
  glm.quota.providerWk = null;
  assert.equal(am._weeklyRawState(glm), 'critical');
  glm.quota.providerSes = 0.999;
  assert.equal(am._weeklyRawState(glm), 'exhausted');
});

test('_weeklyPaceState reads provider quota (the rebalance trigger)', () => {
  const am = fleet();
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerWk = 0.90;
  assert.equal(am._weeklyPaceState(kimi), 'reserve', 'pace state must see provider quota');
});

test('_isAvailable benches a provider at exhaustion', () => {
  const am = fleet();
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerWk = 0.999;
  assert.equal(am._isAvailable(kimi), false, 'exhausted provider must be benched');
  kimi.quota.providerWk = 0.50;
  assert.equal(am._isAvailable(kimi), true, 'healthy provider stays available');
});

test('_isSessionQuotaUnavailable sees providerSes (the session cap)', () => {
  const am = fleet();
  const glm = am.accounts.find(a => a.provider === 'zai');
  glm.quota.providerSes = 0.95;
  assert.equal(am._isSessionQuotaUnavailable(glm), true, '95% of 5h session is unavailable');
  glm.quota.providerSes = 0.50;
  assert.equal(am._isSessionQuotaUnavailable(glm), false);
});

test('_accountScarcity includes provider quota in the scoring', () => {
  const am = fleet();
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerWk = 0.83;
  kimi.quota.providerWkReset = Date.now() + 5 * 86400_000;
  const scarcity = am._accountScarcity(kimi);
  assert.ok(scarcity > 0, 'an 83%-used provider must have positive scarcity (was 0)');
  kimi.quota.providerWk = 0.10;
  assert.ok(am._accountScarcity(kimi) < scarcity, 'lower usage → lower scarcity');
});

test('_scoreAccount de-prefers a high-quota provider over a low-quota one', () => {
  const am = fleet();
  const glm = am.accounts.find(a => a.provider === 'zai');
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  glm.quota.providerSes = 0.10;
  kimi.quota.providerWk = 0.83;
  kimi.quota.providerWkReset = Date.now() + 5 * 86400_000;
  const glmScore = am._scoreAccount(glm, { profile: 'all' });
  const kimiScore = am._scoreAccount(kimi, { profile: 'all' });
  assert.ok(kimiScore > glmScore, `Kimi at 83% should score higher than GLM at 10% (${kimiScore} > ${glmScore})`);
});

test('the scheduler PREFERS the less-used provider at RESERVE level (90%+)', () => {
  // At 83% the score gap is small and round-robin still alternates — correct, since
  // 17% headroom is real. The scoring matters at 90%+ (reserve): Kimi is still
  // available (not benched) but carries a large reserveCost, so GLM should dominate.
  const am = fleet();
  const glm = am.accounts.find(a => a.provider === 'zai');
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  glm.quota.providerSes = 0.10;
  kimi.quota.providerWk = 0.91;   // reserve band
  kimi.quota.providerWkReset = Date.now() + 5 * 86400_000;
  const counts = {};
  for (let i = 0; i < 20; i++) {
    const lease = am.acquireAccount({ profile: 'all' }, new Set());
    const n = lease?.account?.name;
    counts[n] = (counts[n] || 0) + 1;
    am.releaseAccount(lease, { status: 200 });
  }
  assert.ok(counts['glm'] > counts['kimi'],
    `GLM should get more traffic when Kimi is at 91%: ${JSON.stringify(counts)}`);
});

test('a provider at exhaustion is REMOVED from selection (not just scored higher)', () => {
  const am = fleet();
  const kimi = am.accounts.find(a => a.provider === 'kimi');
  kimi.quota.providerWk = 0.999;
  for (let i = 0; i < 10; i++) {
    const lease = am.acquireAccount({ profile: 'all' }, new Set());
    assert.equal(lease?.account?.name, 'glm', 'exhausted Kimi must never be selected');
    am.releaseAccount(lease, { status: 200 });
  }
});

test('an Anthropic account is unaffected by the provider quota change', () => {
  // The fix must be scoped to provider accounts only — unified7d still drives OAuth.
  const am = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const cc = am.accounts[0];
  cc.quota.unified7d = 0.83;
  cc.quota.unified7dReset = Date.now() + 5 * 86400_000;
  assert.equal(am._weeklyRawState(cc), 'soft', 'Anthropic accounts use unified7d unchanged');
  cc.quota.providerSes = 0.95;   // must NOT affect an OAuth account
  assert.equal(am._weeklyRawState(cc), 'soft', 'provider fields are invisible to OAuth scoring');
});

// ── session rebalancing for providers (the 92% GLM stuck-on-one bug) ──────────
//
// A GLM session bound to an account at 92% weekly stayed there forever because
// _migrationSafeForRequest returned false: it requires bodyThinkingScanned === true
// (an Anthropic safety gate), but provider requests never set that flag (no Anthropic
// thinking blocks to scan). A same-provider migration (GLM→GLM) is always safe —
// the thinking format is identical on both sides.

test('a provider session at 92% weekly rebalances to a healthier provider', () => {
  const am = new AccountManager([
    { name: 'glm max', type: 'provider', provider: 'zai', authToken: 'k1', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'glm glm1', type: 'provider', provider: 'zai', authToken: 'k2', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90, { crossProviderFallbackPolicy: 'always' });
  const glmMax = am.accounts[0], glm1 = am.accounts[1];
  glm1.quota.providerWk = 0.92;
  glm1.quota.providerWkReset = Date.now() + 4 * 86400_000;
  // Bind a session to glm1 (the hot one)
  am._bindSession('sess1', glm1, null);
  // The session should migrate to glm max, not stay on glm1
  const lease = am.acquireAccount({ profile: 'all', sessionKey: 'sess1' }, new Set());
  assert.equal(lease?.account?.name, 'glm max', 'session must leave the 92%-used account');
});

test('a Claude session still requires body scan before migration (unchanged)', () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3.6e6 },
    { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3.6e6 },
  ], 0.90);
  am._bindSession('s', am.accounts[0], null);
  // No bodyThinkingScanned → migration NOT safe (same as before the fix)
  assert.equal(am._migrationSafeForRequest({ sessionKey: 's' }), false);
  // With bodyThinkingScanned → migration IS safe
  assert.equal(am._migrationSafeForRequest({ sessionKey: 's', bodyThinkingScanned: true }), true);
});

test('a session bound to a HEALTHY provider stays put (no unnecessary churn)', () => {
  const am = new AccountManager([
    { name: 'glm max', type: 'provider', provider: 'zai', authToken: 'k1', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'glm glm1', type: 'provider', provider: 'zai', authToken: 'k2', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90, { crossProviderFallbackPolicy: 'always' });
  // Both healthy
  am.accounts[0].quota.providerSes = 0.10;
  am.accounts[1].quota.providerSes = 0.15;
  am._bindSession('s', am.accounts[1], null);
  const lease = am.acquireAccount({ profile: 'all', sessionKey: 's' }, new Set());
  assert.equal(lease?.account?.name, 'glm glm1', 'a healthy bound session stays bound');
});
