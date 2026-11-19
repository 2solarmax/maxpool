/* global Headers, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { findAccountConfigIndex, oauthTokensForDiskSync } from '../src/account-config.js';
import {
  listNativeCodexModels, loginNativeCodex, nativeCodexHeaders, parseNativeCodexCallback, refreshNativeCodexToken,
} from '../src/codex-native.js';
import { codexSpentWindows, parseCodexPlanType, parseCodexQuota } from '../src/codex-quota.js';
import { fetchCodexUsage, normalizeCodexUsagePayload } from '../src/codex-usage.js';
import { ResetCreditRedeemer, fetchResetCreditDetails, redeemableCredit } from '../src/codex-reset-credits.js';
import { decideClaudeWithReason, decideCodexWithReason, HOLD_POOL_HAS_ROOM } from '../src/reset-policy.js';
import { AccountManager } from '../src/account-manager.js';

const authKey = 'https://api.openai.com/auth';
const jwt = body => ['test', Buffer.from(JSON.stringify(body)).toString('base64url'), 'test'].join('.');
const exp = () => Math.floor(Date.now() / 1000) + 300;
const grants = (workspace = 'workspace-a') => ({
  access_token: jwt({ exp: exp(), [authKey]: { chatgpt_account_id: workspace } }),
  id_token: jwt({ sub: 'bare-sub', email: 'max@example.test',
    [authKey]: { chatgpt_account_id: workspace, chatgpt_user_id: 'user-a' } }),
  refresh_token: 'refresh-grant',
});
const account = (extra = {}) => ({
  name: 'fixture', provider: 'codex', codexAuth: 'native', credential: 'access-grant',
  codexAccountId: 'workspace-a', accountUuid: 'user-a', organizationUuid: 'workspace-a', index: 0, ...extra,
});
const json = (body, init) => new Response(JSON.stringify(body), init);

test('native OAuth checks callback state and exchanges the exact PKCE verifier for a user/workspace grant', async () => {
  let authorize;
  let browserResult;
  const login = await loginNativeCodex({
    port: 0, report() {},
    open(url, port) {
      authorize = new URL(url);
      browserResult = (async () => {
        const callback = `http://127.0.0.1:${port}/auth/callback`;
        const bad = await fetch(callback + '?code=wrong&state=other');
        assert.equal(bad.status, 400);
        const valid = new URL(callback);
        valid.search = new URLSearchParams({ code: 'native-code', state: authorize.searchParams.get('state') });
        assert.equal((await fetch(valid)).status, 200);
      })();
    },
    async fetchImpl(url, init) {
      assert.equal(url, 'https://auth.openai.com/oauth/token');
      const req = JSON.parse(init.body);
      assert.equal(req.code, 'native-code');
      assert.equal(req.redirect_uri, 'http://localhost:1455/auth/callback');
      assert.equal(req.client_id, authorize.searchParams.get('client_id'));
      assert.equal(createHash('sha256').update(req.code_verifier).digest('base64url'),
        authorize.searchParams.get('code_challenge'));
      return json(grants());
    },
  });
  await browserResult;
  assert.deepEqual(login.profile, {
    provider: 'codex', accountUuid: 'user-a', organizationUuid: 'workspace-a', email: 'max@example.test',
  });
  assert.equal(login.creds.codexAuth, 'native');
  assert.equal(login.creds.codexAccountId, 'workspace-a');
  assert.equal(login.creds.refreshToken, 'refresh-grant');
  assert.ok(login.creds.expiresAt > Date.now());
  assert.throws(() => parseNativeCodexCallback('https://invalid.test/auth/callback?code=x&state=expected', 'expected'));
});

test('native refresh keeps an unrotated refresh grant and rejects a different workspace', async () => {
  const start = account({ refreshToken: 'old-grant' });
  const refreshed = await refreshNativeCodexToken(start, { fetchImpl: async (_url, init) => {
    assert.equal(JSON.parse(init.body).refresh_token, 'old-grant');
    return json({ access_token: grants().access_token });
  } });
  assert.equal(refreshed.refreshToken, 'old-grant');
  await assert.rejects(refreshNativeCodexToken(start, {
    fetchImpl: async () => json(grants('workspace-b')),
  }), /different ChatGPT workspace/);
  await assert.rejects(refreshNativeCodexToken(start, {
    fetchImpl: async () => json({
      ...grants(),
      id_token: jwt({ [authKey]: { chatgpt_account_id: 'workspace-a', chatgpt_user_id: 'user-b' } }),
    }),
  }), /different ChatGPT user/);
  await assert.rejects(refreshNativeCodexToken(start, {
    fetchImpl: async () => json({ error: 'invalid_grant' }, { status: 400 }),
  }), { status: 400, retryable: false });
});

test('catalog reads the per-account native ETag and preserves supported model capabilities', async () => {
  let releaseChecks = 0;
  const fetchImpl = async (url, init) => {
    if (new URL(url).host === 'registry.npmjs.org') {
      assert.equal(url, 'https://registry.npmjs.org/%40openai%2Fcodex/latest');
      assert.equal(init.headers, undefined);
      releaseChecks++;
      return json({ version: '0.200.0' });
    }
    assert.equal(new URL(url).pathname, '/backend-api/codex/models');
    assert.equal(new URL(url).searchParams.get('client_version'), '0.200.0');
    assert.equal(init.headers['chatgpt-account-id'], 'workspace-a');
    assert.equal(init.headers.authorization, 'Bearer access-grant');
    assert.equal(init.redirect, 'error');
    if (init.headers['if-none-match'] === 'generation-a') return new Response(null, { status: 304 });
    assert.equal(init.headers['if-none-match'], undefined);
    return json({ models: [{
      slug: 'gpt-luna', visibility: 'list', display_name: 'Luna', priority: 4,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      default_reasoning_level: 'low', input_modalities: ['text', 'image'],
      supports_tools: true, supports_search_tool: true, context_window: 200000,
    }, { slug: 'private-model', visibility: 'hide' }] }, { headers: { etag: 'generation-a' } });
  };
  const actual = await listNativeCodexModels(account({ quota: { codexCatalogVersion: '0.170.0' } }), {
    etag: 'older-client-generation', fetchImpl,
  });
  assert.equal(actual.etag, 'generation-a');
  assert.equal(actual.version, '0.200.0');
  assert.deepEqual(actual.models, [{
    slug: 'gpt-luna', displayName: 'Luna', priority: 4, efforts: ['low', 'high'],
    defaultEffort: 'low', supportsTools: true, supportsToolSearch: true, supportsVision: true, contextWindow: 200000,
  }]);
  assert.deepEqual(await listNativeCodexModels(account({ quota: { codexCatalogVersion: actual.version } }), {
    etag: actual.etag, fetchImpl,
  }), { models: null, etag: 'generation-a', version: '0.200.0', notModified: true });
  assert.equal(releaseChecks, 1);
  assert.equal(nativeCodexHeaders(account({ credential: 'header\r\nInjection' })), null);
  assert.equal(nativeCodexHeaders({ codexAuth: 'siwc', organizationUuid: 'app-only', accessToken: 'access' }), null);
});

test('an unavailable release registry cannot roll the account back to the bundled catalog client version', async () => {
  const result = await listNativeCodexModels(account({ quota: { codexCatalogVersion: '0.210.0' } }), {
    etag: 'newer-cached-catalog', async fetchImpl(url, init) {
      if (new URL(url).host === 'registry.npmjs.org') throw new Error('offline');
      assert.equal(new URL(url).searchParams.get('client_version'), '0.210.0');
      assert.equal(init.headers['if-none-match'], 'newer-cached-catalog');
      return new Response(null, { status: 304 });
    },
  });
  assert.equal(result.notModified, true);
  assert.equal(result.version, '0.210.0');
});

test('native Codex quota maps windows by duration and keeps absent holdings distinct from zero', async () => {
  const rawHeaders = new Headers({
    'x-codex-primary-used-percent': '100',
    'x-codex-primary-window-minutes': '10080',
    'x-codex-primary-reset-at': '1800000000',
    'x-codex-secondary-used-percent': '21',
    'x-codex-secondary-window-minutes': '300',
    'x-codex-plan-type': 'pro',
    'x-codex-premium-primary-used-percent': '40',
    'x-codex-premium-primary-window-minutes': '10080',
    'x-codex-premium-limit-name': 'Premium',
  });
  assert.deepEqual(parseCodexQuota(rawHeaders), {
    unified7d: 1, unified7dReset: 1800000000000, unified5h: 0.21,
    modelBuckets: [{ slug: 'premium', name: 'Premium', utilization: 0.4, resetAt: null }],
  });
  assert.deepEqual(codexSpentWindows(rawHeaders), ['weekly']);
  assert.equal(parseCodexPlanType(rawHeaders), 'pro');
  assert.equal(normalizeCodexUsagePayload({ rate_limit_reset_credits: { available_count: null } }).resetCredits, null);
  const usage = await fetchCodexUsage(account(), { fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/backend-api/wham/usage');
    assert.equal(init.headers['chatgpt-account-id'], 'workspace-a');
    return json({ rate_limit: {
      primary_window: { used_percent: 80, limit_window_seconds: 604800, reset_at: 1800000000 },
    }, rate_limit_reset_credits: { available_count: 3, applicable_available_count: 0 } });
  } });
  assert.deepEqual(usage.sevenDay, { utilization: 0.8, resetAt: 1800000000000 });
  assert.equal(usage.fiveHour, null);
  assert.deepEqual(usage.resetCredits, { available: 3, applicable: 0 });
});

const minutes = 60000;
const resetNow = 1800000000000;
const creditId = 'banked-credit-live-id';
const availableCredit = { id: creditId, title: 'Free reset', status: 'available', supportedByPlan: true,
  expiresAt: resetNow + 24 * 60 * minutes };
function resetFixture() {
  let file = {};
  return {
    get value() { return file; },
    transactState: async update => {
      const { state, value } = update(structuredClone(file));
      file = structuredClone(state);
      return value;
    },
  };
}

test('reset redemption is opt-in and a race or reload cannot consume a second credit', async () => {
  let now = resetNow;
  const owner = account({ quota: { unified7d: 1, unified7dReset: now + 1440 * minutes,
    codexWeeklyReadingAt: now } });
  const manager = { accounts: [owner], ensureTokenFresh: async () => true };
  const fixture = resetFixture();
  const requests = [];
  const options = {
    transactState: fixture.transactState, now: () => now, log() {},
    detailsFn: async () => ({ credits: [availableCredit] }),
    usageFn: async () => ({ sevenDay: { utilization: 0.1, resetAt: now + 1440 * minutes } }),
    consumeFn: async (_account, attempt) => {
      requests.push(attempt);
      return { code: 'reset', windowsReset: 1 };
    },
  };
  const disarmed = new ResetCreditRedeemer(manager, options);
  assert.equal((await disarmed.maybeRedeemForPool([owner])).redeemed, false);
  assert.equal(requests.length, 0);

  owner.autoRedeemReset = true;
  const armed = options;
  const first = new ResetCreditRedeemer(manager, armed);
  const concurrently = new ResetCreditRedeemer(manager, armed);
  const outcomes = await Promise.all([first.maybeRedeemForPool([owner]), concurrently.manualRedeem(owner, creditId)]);
  assert.equal(outcomes.filter(outcome => outcome.redeemed).length, 1);
  assert.equal(requests.length, 1);
  assert.equal(JSON.stringify(fixture.value).includes(creditId), false);
  assert.equal(JSON.stringify(fixture.value).includes(owner.codexAccountId), false);
  assert.equal(fixture.value.ledger.length, 1);
  now += 61 * minutes;
  const afterReload = new ResetCreditRedeemer(manager, armed);
  const retry = await afterReload.manualRedeem(owner, creditId);
  assert.equal(retry.redeemed, false);
  assert.match(retry.reason, /already redeemed/);
  assert.equal(requests.length, 1);
});

test('uncertain reset attempts survive restart and replay their original idempotency key', async () => {
  let now = resetNow;
  const owner = account();
  const manager = { accounts: [owner], ensureTokenFresh: async () => true };
  const fixture = resetFixture();
  const requests = [];
  const options = {
    transactState: fixture.transactState, now: () => now, log() {},
    detailsFn: async () => ({ credits: [availableCredit] }),
    consumeFn: async (_account, attempt) => {
      requests.push(attempt);
      return requests.length === 1 ? { error: 'timeout' } : { code: 'already_redeemed', windowsReset: 1 };
    },
    usageFn: async () => ({}),
  };
  assert.equal((await new ResetCreditRedeemer(manager, options).manualRedeem(owner, creditId)).uncertain, true);
  assert.equal((await new ResetCreditRedeemer(manager, options).manualRedeem(owner, creditId)).redeemed, false);
  assert.equal(requests.length, 1);
  now += 31 * minutes;
  assert.equal((await new ResetCreditRedeemer(manager, options).manualRedeem(owner, creditId)).redeemed, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].redeemRequestId, requests[1].redeemRequestId);
});

test('banked-reset reads distinguish unavailable, expired, and malformed credits', async () => {
  const actual = await fetchResetCreditDetails(account(), { fetchImpl: async () => json({ credits: [
    { id: 'expired', status: 'available', expires_at: new Date(resetNow - 1).toISOString() },
    { id: 'unsupported', status: 'available', is_supported_by_plan: false },
    { id: 'malformed', status: 'available', expires_at: 'not-a-date' },
    { id: 'next', status: 'available', expires_at: new Date(resetNow + 2).toISOString() },
  ] }) });
  assert.equal(actual.availableCount, 3);
  assert.equal(redeemableCredit(actual.credits, resetNow).id, 'next');
});


test('Codex credits use the subscription weekly wall, expiry, and natural-refill holds', () => {
  const quota = { unified7d: 0.99, unified7dReset: resetNow + 23 * 60 * minutes,
    codexWeeklyReadingAt: resetNow, lastProbeOkAt: resetNow };
  const owner = account({ quota });
  const heldCredit = { ...availableCredit, expiresAt: resetNow + 60 * 60 * minutes };
  const sharedRoom = { listingCheckedAt: resetNow, peersWithRoom: () => 2, holdersInPool: () => 1 };
  const expected = decideClaudeWithReason(owner, { grants: [{ id: heldCredit.id,
    endsAt: heldCredit.expiresAt, clears: ['seven_day'] }], checkedAt: resetNow }, resetNow, sharedRoom);
  const held = decideCodexWithReason(owner, [heldCredit], resetNow, sharedRoom);
  assert.equal(held.action, null);
  assert.equal(held.reason, HOLD_POOL_HAS_ROOM);
  assert.equal(held.reason, expected.reason);
  assert.equal(decideCodexWithReason(owner, [heldCredit], resetNow, {
    ...sharedRoom, peersWithRoom: () => 1,
  }).action.reason, 'weekly at wall');

  owner.quota.unified7d = 0.3;
  const expiring = { ...availableCredit, expiresAt: resetNow + 2 * 60 * minutes };
  assert.equal(decideCodexWithReason(owner, [expiring], resetNow).reason, 'free refill <24h away');
  owner.quota.unified7dReset = resetNow + 28 * 60 * minutes;
  assert.equal(decideCodexWithReason(owner, [expiring], resetNow).action.reason, 'dying value');
  assert.equal(decideCodexWithReason(owner, [heldCredit], resetNow).action, null);
  owner.quota.codexWeeklyReadingAt = resetNow - 6 * minutes;
  assert.equal(decideCodexWithReason(owner, [expiring], resetNow).reason, 'probe not fresh');
});

test('banked Pro resets are held during low usage and claimed when the weekly policy calls for one', async () => {
  const summary = { available: 3, applicable: 0, checkedAt: resetNow };
  const owner = account({ autoRedeemReset: true, quota: {
    unified7d: 0.15, unified7dReset: resetNow + 48 * 60 * minutes,
    codexWeeklyReadingAt: resetNow, codexResetCredits: summary,
  } });
  const manager = { accounts: [owner], ensureTokenFresh: async () => true };
  const attempts = [];
  const redeemer = new ResetCreditRedeemer(manager, {
    now: () => resetNow, log() {}, transactState: resetFixture().transactState,
    detailsFn: async () => ({ credits: [availableCredit] }),
    usageFn: async () => ({ sevenDay: { utilization: 0, resetAt: owner.quota.unified7dReset } }),
    consumeFn: async (_account, attempt) => {
      attempts.push(attempt.creditId);
      return { code: 'reset', windowsReset: 1 };
    },
  });
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, false);
  owner.quota.unified7d = 0.99;
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, false);
  assert.equal(summary.available, 3);
  assert.deepEqual(attempts, []);
  summary.applicable = 3;
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, true);
  assert.deepEqual(attempts, [availableCredit.id]);
});

test('Codex automatic expiry redemption uses the sweep while a request only reacts to the weekly wall', async () => {
  const owner = account({ autoRedeemReset: true, quota: { unified7d: 0.4,
    unified7dReset: resetNow + 30 * 60 * minutes, codexWeeklyReadingAt: resetNow } });
  const expiring = { ...availableCredit, expiresAt: resetNow + 60 * minutes };
  const manager = { accounts: [owner], ensureTokenFresh: async () => true };
  let consumed = 0;
  let listed = 0;
  const redeemer = new ResetCreditRedeemer(manager, {
    now: () => resetNow, log() {}, usageFn: async () => ({}),
    detailsFn: async () => { listed++; return { credits: [expiring] }; },
    consumeFn: async () => { consumed++; return { code: 'reset', windowsReset: 1 }; },
  });
  assert.equal((await redeemer.maybeRedeemForPool([owner], { reactive: true })).redeemed, false);
  assert.equal(listed, 0);
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, true);
  assert.equal(listed, 1);
  assert.equal(consumed, 1);
});


test('Codex revalidates weekly usage after reserving and before consuming a credit', async () => {
  const owner = account({ autoRedeemReset: true, quota: { unified7d: 1,
    unified7dReset: resetNow + 30 * 60 * minutes, codexWeeklyReadingAt: resetNow } });
  const manager = { accounts: [owner], ensureTokenFresh: async () => true };
  const fixture = resetFixture();
  let consumed = 0;
  const redeemer = new ResetCreditRedeemer(manager, {
    now: () => resetNow, log() {},
    detailsFn: async () => ({ credits: [availableCredit] }),
    transactState: async update => {
      const value = await fixture.transactState(update);
      if (fixture.value.pending) {
        // A concurrent probe observed that the provider had already refilled.
        owner.quota.unified7d = 0;
      }
      return value;
    },
    consumeFn: async () => { consumed++; return { code: 'reset', windowsReset: 1 }; },
  });
  const result = await redeemer.maybeRedeemForPool([owner], { reactive: true });
  assert.equal(result.redeemed, false);
  assert.match(result.reason, /eligibility changed/);
  assert.equal(consumed, 0);
  assert.equal(fixture.value.pending, null);
});

test('Codex can hold for natural refill only when a fresh, entitled Codex peer has room', () => {
  const plan = slug => [{ slug }];
  const accounts = ['self', 'same', 'other-model'].map((name, index) => account({
    name, accountUuid: name, organizationUuid: name, codexAccountId: name,
    type: 'oauth', accessToken: `fixture-grant-${name}`, codexModels: plan(index === 2 ? 'gpt-6.2-sol' : 'gpt-6.2-astra'),
  }));
  accounts.push({ name: 'claude-peer', accountUuid: 'claude-peer', type: 'oauth', accessToken: 'other-provider' });
  const manager = new AccountManager(accounts);
  const weekly = { sevenDay: { utilization: 0.15, resetAt: resetNow + 25 * 60 * minutes } };
  for (let index = 0; index < 3; index++) manager.applyCodexUsageData(index, weekly, { sentAt: resetNow });
  manager.applyUsageData(3, { fiveHour: { utilization: 0.1 }, ...weekly });
  const [self, same] = manager.accounts;
  assert.equal(manager.countPeersWithRoom(self, resetNow), 1);
  same.quota.codexWeeklyReadingAt = resetNow - 6 * minutes;
  assert.equal(manager.countPeersWithRoom(self, resetNow), 0);
});

test('disk sync racing a Codex refresh keeps the replacement and accepts a separate reauthorization', async () => {
  const old = { accessToken: 'old-access', refreshToken: 'consumed', expiresAt: Date.now() - 1000 };
  const fresh = { accessToken: 'new-access', refreshToken: 'rotated', expiresAt: Date.now() + 3_600_000 };
  const am = new AccountManager([{ name: 'fixture', type: 'oauth', provider: 'codex', codexAuth: 'native', ...old }],
    0.9, {}, { refreshNativeCodexToken: async () => fresh });
  let release;
  let started;
  const saving = new Promise(resolve => { started = resolve; });
  const persisted = new Promise(resolve => { release = resolve; });
  am.onTokenRefresh(() => { started(); return persisted; });
  const refresh = am.ensureTokenFresh(0);
  await saving;
  let served = false;
  const concurrent = am.ensureTokenFresh(0).then(() => { served = true; });
  try {
    await Promise.resolve();
    assert.equal(served, false, 'another request must await the ongoing durable write');
    // Capture the race independent of which token has the longer lifetime.
    assert.deepEqual(oauthTokensForDiskSync(am.accounts[0], old), fresh);
    assert.deepEqual(oauthTokensForDiskSync(am.accounts[0], { ...old, expiresAt: fresh.expiresAt + 1000 }), fresh);
    const unrotated = { ...am.accounts[0], refreshToken: old.refreshToken };
    assert.deepEqual(oauthTokensForDiskSync(unrotated, { ...old, expiresAt: fresh.expiresAt + 1000 }),
      { ...fresh, refreshToken: old.refreshToken });
    const reauthorized = { ...old, accessToken: 'reauthorized-access', refreshToken: 'different-grant', expiresAt: fresh.expiresAt - 1000 };
    assert.deepEqual(oauthTokensForDiskSync(am.accounts[0], reauthorized), reauthorized);
  } finally {
    release();
    assert.equal(await refresh, true);
    await concurrent;
  }
});

test('native config lookup follows an owner rename and ignores other accounts with its old name', () => {
  const owner = account();
  const differentUser = account({ accountUuid: 'unrelated-user' });
  const differentWorkspace = account({ codexAccountId: 'different-workspace' });
  const legacy = { ...owner, codexAuth: null };
  const renamed = { ...owner, name: 'renamed' };
  assert.equal(findAccountConfigIndex([differentUser, differentWorkspace, legacy, renamed], owner), 3);
  assert.equal(findAccountConfigIndex([differentUser, differentWorkspace, legacy], owner), -1);
  assert.equal(findAccountConfigIndex([owner], legacy), -1);
});

test('native refresh persists to the original owner after an earlier row is removed', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const fresh = { accessToken: 'fresh-owner-access', refreshToken: 'fresh-owner-refresh', expiresAt: Date.now() + 3600000 };
  const am = new AccountManager([
    { name: 'removed', type: 'apikey', apiKey: 'removed-key' },
    account({ type: 'oauth', accessToken: 'expired-owner', refreshToken: 'old-owner', expiresAt: 1 }),
    { name: 'other', type: 'apikey', apiKey: 'unrelated-key' },
  ], 0.9, {}, { refreshNativeCodexToken: () => pending });
  const owner = am.accounts[1];
  const saved = [];
  am.onTokenRefresh((index, tokens) => saved.push([am.accounts[index], tokens]));
  const refresh = am.ensureTokenFresh(owner.index);
  am.removeAccount(0);
  finish(fresh);
  assert.equal(await refresh, true);
  assert.equal(saved[0]?.[0], owner);
  assert.deepEqual(saved[0]?.[1], fresh);
  assert.equal(owner.refreshToken, fresh.refreshToken);
  assert.equal(am.accounts[1].credential, 'unrelated-key');
});

test('a refresh rejection cannot bench the replacement occupying a deleted account’s index', async () => {
  let fail;
  const pending = new Promise((_resolve, reject) => { fail = reject; });
  const am = new AccountManager([
    account({ type: 'oauth', accessToken: 'expired-owner', refreshToken: 'old-owner', expiresAt: 1 }),
    { name: 'other', type: 'apikey', apiKey: 'unrelated-key' },
  ], 0.9, {}, { refreshNativeCodexToken: () => pending });
  const refresh = am.ensureTokenFresh(0);
  assert.equal(am.removeAccount(0), true);
  fail(Object.assign(new Error('Rejected fixture grant'), { status: 401 }));
  assert.equal(await refresh, false);
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].lastError, null);
});
