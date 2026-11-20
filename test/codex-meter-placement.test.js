import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { normalizeCodexUsagePayload } from '../src/codex-usage.js';
import { parseCodexQuota, codexRateLimit, codexSpentWindows } from '../src/codex-quota.js';
import { ResetCreditRedeemer } from '../src/codex-reset-credits.js';

const hour = 3600_000;
const model = 'gpt-6.2-sol';
const spark = 'gpt-6.2-astra';
const config = name => ({ name, type: 'oauth', provider: 'codex', codexAuth: 'native',
  codexAccountId: 'workspace-' + name, accountUuid: 'user-' + name,
  accessToken: 'fixture-' + name, codexModels: [model, spark].map(slug => ({ slug, efforts: ['high'] })) });
const manager = () => new AccountManager([config('one'), config('two')], 0.98, { routingMode: 'balance' });
const request = (session, openAIModel = model) => ({ model: 'claude-sonnet-5-2', openAIModel, profile: 'all',
  path: '/v1/messages', sessionKey: session, affinityKey: session, codexCompatible: true });
const window = (used_percent, seconds, resetAt) => ({ used_percent, limit_window_seconds: seconds, reset_at: resetAt / 1000 });
const headers = (used, resetAt) => new globalThis.Headers({
  'x-codex-premium-primary-used-percent': String(used),
  'x-codex-premium-primary-window-minutes': '300',
  'x-codex-premium-primary-reset-at': String(resetAt / 1000),
  'x-codex-premium-limit-name': spark,
  'x-codex-active-limit': 'premium',
});

test('a named five-hour limit is scoped consistently across probe, headers, 429, saved state and mirrors', () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const reset = now + 4 * hour;
  const source = manager();
  const data = normalizeCodexUsagePayload({
    rate_limit: { primary_window: window(20, 604800, now + 2 * 24 * hour) },
    additional_rate_limits: [{ metered_feature: 'codex_premium', limit_name: spark,
      rate_limit: { primary_window: window(100, 18000, reset) } }],
  });
  assert.equal(data.fiveHour, null);
  assert.deepEqual(data.modelFiveHourBuckets, parseCodexQuota(headers(100, reset)).modelFiveHourBuckets);
  assert.deepEqual(codexSpentWindows(headers(100, reset)), [spark + ' 5h']);
  source.applyCodexUsageData(0, data, { sentAt: now });
  const account = source.accounts[0];
  assert.equal(account.quota.unified5h, null);
  assert.equal(source._scopedExhausted(account, model), null);
  assert.equal(source._scopedExhausted(account, spark)?.session, true);
  const raw = headers(100, reset);
  const limit = codexRateLimit(raw, spark, now);
  assert.equal(limit.modelWindow, '5h');
  assert.equal(limit.modelScope, 'premium');
  assert.equal(limit.retryAfter, 4 * 3600);
  source.markRateLimited(0, limit.retryAfter, limit);
  source.applyCodexUsageData(0, { ...data, modelFiveHourBuckets: [] }, { sentAt: now + 1 });
  assert.equal(account.quota.codexScopedFiveHour.premium.reactive, true);
  assert.equal(account.quota.scopedWeekly.premium, undefined);
  assert.equal(account.rateLimitedUntil, null);

  const saved = source.exportQuotaState();
  const restored = manager();
  restored.restoreQuotaState(saved);
  assert.equal(restored._scopedExhausted(restored.accounts[0], spark)?.session, true);
  const edge = new AccountManager([]);
  edge.syncRemoteMirrors({ name: 'test', url: 'http://example.invalid', lastOkAt: now, status: source.getStatus() });
  assert.equal(edge.accounts[0].quota.codexScopedFiveHour.premium.reactive, true);
  assert.equal(edge._scopedExhausted(edge.accounts[0], model), null);
  const legacy = structuredClone(saved);
  delete legacy[0].quota.codexSharedFiveHourVerified;
  legacy[0].quota.unified5h = 1;
  legacy[0].quota.unified5hReset = reset;
  const boot = manager();
  boot.restoreQuotaState(legacy);
  assert.equal(boot.accounts[0].quota.unified5h, null);
  assert.equal(boot.accounts[0].quota.unified7d, 0.2);
});

test('general wall takes precedence without inheriting the longer named retry and two models sharing a meter both gate', () => {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const raw = headers(100, now + 4 * hour);
  raw.set('x-codex-primary-used-percent', '100');
  raw.set('x-codex-primary-window-minutes', '10080');
  raw.set('x-codex-primary-reset-at', String((now + hour) / 1000));
  assert.deepEqual(codexRateLimit(raw, spark, now), { scope: 'account', modelScope: null, retryAfter: 3600 });
  const am = manager();
  am.applyCodexQuotaHeaders(0, headers(99, now + 5 * hour), now, spark);
  am.applyCodexQuotaHeaders(0, headers(99, now + 5 * hour), now, model);
  assert.ok(am._scoreTerms(am.accounts[0], request('s')).scopedPace > 0);
  assert.equal(am._scoreTerms(am.accounts[1], request('s')).scopedPace, 0);
  am.applyCodexQuotaHeaders(0, headers(100, now + 5 * hour), now, model);
  assert.ok(am._scopedExhausted(am.accounts[0], model));
  assert.ok(am._scopedExhausted(am.accounts[0], spark));
  const general = parseCodexQuota(raw);
  assert.equal(general.unified7d, 1);
  assert.equal(general.unified5h, undefined);
});

test('first-placement shadow measures feasible, same-model alternatives and never changes placement or follows a warm turn', () => {
  const am = manager();
  const now = Date.now();
  for (const account of am.accounts) am.applyCodexUsageData(account.index, {
    sevenDay: { utilization: 0.2, resetAt: now + 24 * hour },
  }, { sentAt: now });
  am.capacityTank = (i) => ({ source: 'cycles', exact: 2, bounded: 0, recent: i === 0 ? 1000 : 2000 });
  const alternatives = [];
  am.routingCapacity.noteAlternative = evidence => alternatives.push(evidence);
  const info = request('new');
  const lease = am.acquireAccount(info);
  assert.equal(lease.account.index, 0);
  assert.deepEqual(am.placementComparison(), { since: am.placementComparison().since,
    observed: 1, comparable: 1, disagreed: 1, successful: 0, failed: 0 });
  am.releaseAccount(lease, { success: true, status: 200 });
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].owner, am._localCacheKeys(am.accounts[1])[0]);
  assert.equal(alternatives[0].window, 'wk');
  assert.equal(alternatives[0].resetAt, now + 24 * hour);
  const warm = am.acquireAccount(request('new'));
  am.releaseAccount(warm, { success: true, status: 200 });
  assert.equal(am.placementComparison().observed, 1);
  assert.equal(am.placementComparison().successful, 1);
  const unknown = manager();
  unknown.acquireAccount(request('no-measured-tank'));
  assert.equal(unknown.placementComparison().comparable, 0);
});

for (const phase of ['acquire', 'release']) {
  test(`a throwing capacity ledger during ${phase} preserves the selected route and frees its slot`, () => {
    const am = manager();
    const now = Date.now();
    for (const a of am.accounts) am.applyCodexUsageData(a.index, {
      sevenDay: { utilization: 0.2, resetAt: now + 24 * hour },
    }, { sentAt: now });
    let faults = 0;
    const fail = () => { faults++; throw new Error('fixture ledger failure'); };
    am.capacityTank = phase === 'acquire' ? fail
      : index => ({ source: 'cycles', exact: 2, bounded: 0, recent: index ? 2000 : 1000 });
    if (phase === 'release') am.routingCapacity.noteAlternative = fail;

    const lease = am.acquireAccount({ ...request('new'), weight: 3 });
    assert.equal(lease.account.index, 0);
    assert.equal(lease.account.inFlight, 1);
    assert.equal(lease.account.activeWeight, 3);
    am.releaseAccount(lease, { success: true, status: 200 });
    assert.equal(faults, 1);
    assert.equal(lease.account.inFlight, 0);
    assert.equal(lease.account.activeWeight, 0);
    assert.equal(lease.account.completedRequests, 1);
  });
}

test('a compacted Messages conversation with a new prefix keeps its original first-placement count', () => {
  const am = manager();
  const makeTurn = affinityKey => ({ ...request('unused'), sessionKey: '', caller: 'test-client',
    clientThreadId: 'stable-client-thread', affinityKey });
  const first = makeTurn('first-prefix');
  const lease = am.acquireAccount(first);
  am.noteConversationServed(first, lease.account);
  am.releaseAccount(lease, { status: 200, success: true });
  assert.equal(am.placementComparison().observed, 1);
  const compacted = am.acquireAccount(makeTurn('compacted-prefix'));
  assert.ok(compacted);
  assert.equal(am.placementComparison().observed, 1);
  am.releaseAccount(compacted, { status: 200, success: true });
});

test('unsuccessful comparable attempts never book served-elsewhere evidence', () => {
  const am = manager();
  const now = Date.now();
  for (const a of am.accounts) am.applyCodexUsageData(a.index, {
    sevenDay: { utilization: 0.2, resetAt: now + 24 * hour },
  }, { sentAt: now });
  am.capacityTank = index => ({ source: 'cycles', exact: 3, bounded: 0, recent: index ? 2000 : 1000 });
  am.routingCapacity.noteAlternative = () => assert.fail('incomplete/error response counted as served');
  const req = { ...request('incomplete'), _service: { terminal: 'incomplete' } };
  const lease = am.acquireAccount(req);
  am.releaseAccount(lease, { success: true, status: 200 });
  assert.equal(am.placementComparison().failed, 1);
  assert.equal(am.placementComparison().successful, 0);
});

test('expiring credit shadow needs fresh detail, opted-in ownership and a current redemption decision', async () => {
  const am = manager();
  const account = am.accounts[0];
  const now = Date.now();
  const expiresAt = now + hour;
  account.quota.unified7d = 0.76;
  account.quota.unified7dReset = now + 72 * hour;
  account.quota.codexWeeklyReadingAt = now;
  account.quota.codexResetCredits = { available: 2, checkedAt: now };
  let calls = 0;
  const redeemer = new ResetCreditRedeemer(am, { now: () => now, detailsFn: async () => {
    calls++;
    return { credits: [{ id: 'not-spendable', status: 'available', supportedByPlan: false, expiresAt: now + 3000 },
      { id: 'usable', status: 'available', supportedByPlan: true, expiresAt }] };
  }, consumeFn: () => assert.fail('a shadow observation must not spend') });
  account.autoRedeemReset = true;
  assert.equal(redeemer.expiringOpportunity(account, now), null);
  await redeemer.readDetails(account);
  assert.equal(redeemer.expiringOpportunity(account, now)?.expiresAt, expiresAt);
  assert.equal(redeemer.expiringOpportunity(account, now + hour), null);
  account.quota.unified7dReset = now + 2 * hour;
  assert.equal(redeemer.expiringOpportunity(account, now), null);
  account.quota.unified7dReset = now + 72 * hour;
  account.autoRedeemReset = false;
  assert.equal(redeemer.expiringOpportunity(account, now), null);
  assert.equal(calls, 1);
});
