/* global Headers, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  listNativeCodexModels, loginNativeCodex, nativeCodexHeaders, parseNativeCodexCallback, refreshNativeCodexToken,
} from '../src/codex-native.js';
import { codexSpentWindows, parseCodexPlanType, parseCodexQuota } from '../src/codex-quota.js';
import { fetchCodexUsage, normalizeCodexUsagePayload } from '../src/codex-usage.js';
import { ResetCreditRedeemer, fetchResetCreditDetails, redeemableCredit } from '../src/codex-reset-credits.js';

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
    fetchImpl: async () => json({ error: 'invalid_grant' }, { status: 400 }),
  }), { status: 400, retryable: false });
});

test('catalog reads the per-account native ETag and preserves supported model capabilities', async () => {
  const actual = await listNativeCodexModels(account(), { fetchImpl: async (url, init) => {
    assert.equal(new URL(url).pathname, '/backend-api/codex/models');
    assert.match(url, /client_version=\d/);
    assert.equal(init.headers['chatgpt-account-id'], 'workspace-a');
    assert.equal(init.headers.authorization, 'Bearer access-grant');
    assert.equal(init.redirect, 'error');
    return json({ models: [{
      slug: 'gpt-luna', visibility: 'list', display_name: 'Luna', priority: 4,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }],
      default_reasoning_level: 'low', input_modalities: ['text', 'image'],
      supports_tools: true, supports_search_tool: true, context_window: 200000,
    }, { slug: 'private-model', visibility: 'hide' }] }, { headers: { etag: 'generation-a' } });
  } });
  assert.equal(actual.etag, 'generation-a');
  assert.deepEqual(actual.models, [{
    slug: 'gpt-luna', displayName: 'Luna', priority: 4, efforts: ['low', 'high'],
    defaultEffort: 'low', supportsTools: true, supportsToolSearch: true, supportsVision: true, contextWindow: 200000,
  }]);
  assert.deepEqual(await listNativeCodexModels(account(), { etag: actual.etag, fetchImpl: async (_url, init) => {
    assert.equal(init.headers['if-none-match'], 'generation-a');
    return new Response(null, { status: 304 });
  } }), { models: null, etag: 'generation-a', notModified: true });
  assert.equal(nativeCodexHeaders(account({ credential: 'header\r\nInjection' })), null);
  assert.equal(nativeCodexHeaders({ codexAuth: 'siwc', organizationUuid: 'app-only', accessToken: 'access' }), null);
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
  const owner = account({ quota: { unified7d: 1, unified7dReset: now + 1440 * minutes } });
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

  const armed = { ...options, config: { codexAutoRedeemResets: true } };
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
