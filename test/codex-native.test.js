/* global Headers, Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canPersistOAuthRefresh, findAccountConfigIndex, oauthTokensForDiskSync } from '../src/account-config.js';
import {
  listNativeCodexModels, loginNativeCodex, nativeCodexHeaders, parseNativeCodexCallback, refreshNativeCodexToken,
} from '../src/codex-native.js';
import { codexSpentWindows, parseCodexPlanType, parseCodexQuota } from '../src/codex-quota.js';
import { fetchCodexUsage, normalizeCodexUsagePayload } from '../src/codex-usage.js';
import { ResetCreditRedeemer, fetchResetCreditDetails, redeemableCredit } from '../src/codex-reset-credits.js';
import {
  decideClaudeWithReason, decideCodexWithReason, HOLD_POOL_HAS_ROOM,
} from '../src/reset-policy.js';
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

test('an explicit off keeps resets unspent, and a race or reload cannot consume a second credit', async () => {
  let now = resetNow;
  const owner = account({ quota: { unified7d: 1, unified7dReset: now + 1440 * minutes,
    codexWeeklyReadingAt: now } });
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
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
  // Automatic redemption is ON unless the owner turned it off; an explicit off wins.
  owner.autoRedeemReset = false;
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
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
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


test('Codex credits use the subscription weekly wall (100%), and the natural-refill hold applies only there', () => {
  // Final contract (owner, 2026-11-27): the wall is 100% — the router's bench. 0.99 and
  // 0.999 used to BE the wall and claim a credit; both are below the limit now.
  for (const used of [0.99, 0.999]) {
    const below = account({ quota: { unified7d: used, unified7dReset: resetNow + 23 * 60 * minutes,
      codexWeeklyReadingAt: resetNow, lastProbeOkAt: resetNow } });
    assert.equal(decideCodexWithReason(below, [availableCredit], resetNow).action, null, `${used} is under the limit`);
  }
  const quota = { unified7d: 1, unified7dReset: resetNow + 23 * 60 * minutes,
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

  // BELOW 100% an expiring credit is NEVER spent (the "dying value" precaution is gone):
  // 2h left on the credit, 23h to the refill — it dies unused rather than reset a 30% account.
  owner.quota.unified7d = 0.3;
  const expiring = { ...availableCredit, expiresAt: resetNow + 2 * 60 * minutes };
  assert.equal(decideCodexWithReason(owner, [expiring], resetNow).action, null, 'a credit dying in 2h at 30%: kept');
  for (const used of [0.3, 0.45, 0.8, 0.99]) {
    owner.quota.unified7d = used;
    assert.equal(decideCodexWithReason(owner, [expiring], resetNow).action, null, `${used} used, credit dying in 2h: kept`);
  }
  owner.quota.unified7d = 1;

  // AT 100% the hold reads the refill and the credit's life:
  // Refill 6h out. A credit with 60h left outlives it: held while the pool has room.
  owner.quota.unified7dReset = resetNow + 6 * 60 * minutes;
  const after = hours => ({ ...availableCredit, expiresAt: resetNow + 6 * 60 * minutes + hours * 60 * minutes });
  assert.equal(decideCodexWithReason(owner, [heldCredit], resetNow, sharedRoom).reason, HOLD_POOL_HAS_ROOM);
  // One that dies 3h BEFORE the refill is spent now: a hold would lose it.
  assert.equal(decideCodexWithReason(owner, [after(-3)], resetNow, sharedRoom).action.reason, 'weekly at wall');
  // Boundaries around the refill: a credit that expires AT it, or within a day after it,
  // cannot wait (it would sit at ~0% used and expire unspent) — spent now. One that keeps
  // POLICY.dyingWindowMs (24h) of life after the refill waits.
  assert.equal(decideCodexWithReason(owner, [after(0)], resetNow, sharedRoom).action.reason, 'weekly at wall');
  assert.equal(decideCodexWithReason(owner, [after(10 / 60)], resetNow, sharedRoom).action.reason, 'weekly at wall',
    'a credit dying 10 minutes after the refill is spent before it');
  assert.equal(decideCodexWithReason(owner, [{ ...after(24), expiresAt: after(24).expiresAt - 1000 }],
    resetNow, sharedRoom).action.reason, 'weekly at wall');
  assert.equal(decideCodexWithReason(owner, [after(24)], resetNow, sharedRoom).reason, HOLD_POOL_HAS_ROOM);
  // Refill 28h out (past a day): with room the long-lived credit is still held (R8).
  owner.quota.unified7dReset = resetNow + 28 * 60 * minutes;
  assert.equal(decideCodexWithReason(owner, [heldCredit], resetNow, sharedRoom).reason, HOLD_POOL_HAS_ROOM);
  // Control: a credit with 60h left at 30% used is not spent, room or not.
  owner.quota.unified7d = 0.3;
  assert.equal(decideCodexWithReason(owner, [heldCredit], resetNow).action, null);
  // Freshness still gates a 100% reading.
  owner.quota.unified7d = 1;
  owner.quota.codexWeeklyReadingAt = resetNow - 6 * minutes;
  assert.equal(decideCodexWithReason(owner, [expiring], resetNow).reason, 'probe not fresh');
});

test('banked Pro resets are held during low usage and claimed when the weekly policy calls for one', async () => {
  const summary = { available: 3, applicable: 0, checkedAt: resetNow };
  const owner = account({ autoRedeemReset: true, quota: {
    unified7d: 0.15, unified7dReset: resetNow + 48 * 60 * minutes,
    codexWeeklyReadingAt: resetNow, codexResetCredits: summary,
  } });
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
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
  assert.equal(summary.available, 3);
  assert.deepEqual(attempts, []);
  owner.quota.unified7d = 1;
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, true);
  assert.deepEqual(attempts, [availableCredit.id]);
  assert.equal(owner.quota.codexResetCredits, null);
  assert.equal(owner.codexResetCredits, null);
  assert.equal(owner.codexQuotaSentAt, owner.lastClaimAt);
});

test('Codex sweep may list an expiring credit below 100%, but neither path spends it', async () => {
  const owner = account({ autoRedeemReset: true, quota: { unified7d: 0.4,
    unified7dReset: resetNow + 30 * 60 * minutes, codexWeeklyReadingAt: resetNow,
    codexResetCredits: { available: 1, checkedAt: resetNow } } });
  const expiring = { ...availableCredit, expiresAt: resetNow + 60 * minutes };
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
  let consumed = 0;
  let listed = 0;
  const redeemer = new ResetCreditRedeemer(manager, {
    now: () => resetNow, log() {}, transactState: resetFixture().transactState,
    usageFn: async () => ({ sevenDay: { utilization: 0, resetAt: owner.quota.unified7dReset } }),
    detailsFn: async () => { listed++; return { credits: [expiring] }; },
    consumeFn: async () => { consumed++; return { code: 'reset', windowsReset: 1 }; },
  });
  assert.equal((await redeemer.maybeRedeemForPool([owner], { reactive: true })).redeemed, false);
  assert.equal(listed, 0);
  assert.equal((await redeemer.maybeRedeemForPool([owner])).redeemed, false);
  assert.equal(listed, 1);
  assert.equal(consumed, 0);
  owner.quota.unified7d = 1;
  assert.equal((await redeemer.maybeRedeemForPool([owner], { reactive: true })).redeemed, true);
  assert.equal(consumed, 1);
});


test('Codex revalidates weekly usage after reserving and before consuming a credit', async () => {
  const owner = account({ autoRedeemReset: true, quota: { unified7d: 1,
    unified7dReset: resetNow + 30 * 60 * minutes, codexWeeklyReadingAt: resetNow } });
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
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

// A credit that does not expire for a long time: only reaching the limit can spend it.
const longCredit = { ...availableCredit, id: 'banked-credit-long', expiresAt: resetNow + 90 * 60 * minutes };

// EXACT LIMIT (owner, 2026-11-27): the sweep takes no "early" inputs any more. A manager
// that still supplies them is accepted and ignored, which these tests prove.
function limitSweep(owner, { inputs = { weeklyCap: null, peerReturnAt: null }, rows = [longCredit], consumed = [] } = {}) {
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, codexResetEarlyInputs: () => inputs,
    noteWallHold() {}, countPeersWithRoom: () => 0, clearRateLimited: () => false };
  const redeemer = new ResetCreditRedeemer(manager, {
    now: () => resetNow, log() {}, transactState: resetFixture().transactState,
    detailsFn: async () => ({ credits: rows }),
    usageFn: async () => ({ sevenDay: { utilization: 0.05, resetAt: owner.quota.unified7dReset } }),
    consumeFn: async (_account, attempt) => { consumed.push(attempt.creditId); return { code: 'reset', windowsReset: 1 }; },
  });
  return { redeemer, consumed };
}
const nearOwner = (extra = {}, quota = {}) => account({ quota: { unified7d: 0.97,
  unified7dReset: resetNow + 5 * 60 * minutes, codexWeeklyReadingAt: resetNow,
  codexResetCredits: { available: 2, applicable: 1, checkedAt: resetNow }, ...quota }, ...extra });

test('a sweep spends a confirmed credit only at the limit; enrolled by default, and an explicit off wins', async () => {
  const off = nearOwner({ autoRedeemReset: false }, { unified7d: 1 });
  const declined = limitSweep(off);
  assert.equal((await declined.redeemer.maybeRedeemForPool([off])).redeemed, false);
  assert.deepEqual(declined.consumed, [], 'an explicit off is never overridden');

  // 97% used — the reading the old rule spent at. Nothing is spent, with or without the
  // old early inputs.
  const near = nearOwner();                       // autoRedeemReset unset = on
  assert.equal(near.autoRedeemReset, undefined);
  const kept = limitSweep(near);
  assert.equal((await kept.redeemer.maybeRedeemForPool([near])).redeemed, false);
  assert.deepEqual(kept.consumed, [], 'under the limit: the credit is kept');

  const owner = nearOwner({}, { unified7d: 1 });
  const spent = limitSweep(owner);
  const result = await spent.redeemer.maybeRedeemForPool([owner]);
  assert.equal(result.redeemed, true);
  assert.equal(result.reason, 'weekly at wall');
  assert.deepEqual(spent.consumed, [longCredit.id]);

  // The count says credits exist, the rows say none can be spent: nothing is redeemed.
  const countOnly = nearOwner({}, { unified7d: 1 });
  const none = limitSweep(countOnly, { rows: [] });
  assert.equal((await none.redeemer.maybeRedeemForPool([countOnly])).redeemed, false);
  assert.deepEqual(none.consumed, []);
});

test('a sweep never spends because the OPERATOR cap binds, and never acts on the request-refusal path below the wall', async () => {
  // 68% of a week used, held at a 70% cap. The old rule spent here "to keep the
  // reservation". A cap is a reservation, not provider exhaustion: nothing is spent for it.
  const capped = nearOwner({}, { unified7d: 0.68 });
  const atCap = limitSweep(capped, { inputs: { weeklyCap: 0.7, peerReturnAt: null } });
  assert.equal((await atCap.redeemer.maybeRedeemForPool([capped])).redeemed, false, 'a cap that binds is not the limit');
  assert.deepEqual(atCap.consumed, []);
  // Past its cap, still under the limit: still nothing.
  const over = nearOwner({}, { unified7d: 0.72 });
  const pastCap = limitSweep(over, { inputs: { weeklyCap: 0.7, peerReturnAt: null } });
  assert.equal((await pastCap.redeemer.maybeRedeemForPool([over])).redeemed, false);
  // The same account WITH a credit that dies in 2h is NOT spent either (final contract,
  // 2026-11-27): expiry is not a reason to reset an account that is not full.
  const dying = { ...availableCredit, id: 'banked-credit-dying', expiresAt: resetNow + 2 * 60 * minutes };
  const keptDying = limitSweep(capped, { inputs: { weeklyCap: 0.7, peerReturnAt: null }, rows: [dying] });
  assert.equal((await keptDying.redeemer.maybeRedeemForPool([capped])).redeemed, false, 'a dying credit below 100%: kept');
  assert.deepEqual(keptDying.consumed, []);

  // A request refusal acts at the weekly wall only (unchanged).
  const refused = nearOwner();
  const reactive = limitSweep(refused);
  assert.equal((await reactive.redeemer.maybeRedeemForPool([refused], { reactive: true })).redeemed, false,
    'a refusal acts at the weekly wall only');
  const refusedAtWall = nearOwner({}, { unified7d: 1 });
  const reactiveWall = limitSweep(refusedAtWall);
  assert.equal((await reactiveWall.redeemer.maybeRedeemForPool([refusedAtWall], { reactive: true })).redeemed, true,
    'at the wall a refusal spends');
});

test('through the sweep: the old "wait for a compatible account" inputs change nothing below the limit', async () => {
  // 97.5% used, the week's refill 40h away — the exact shape the old rule held, then spent.
  const owner = () => nearOwner({}, { unified7d: 0.975, unified7dReset: resetNow + 40 * 60 * minutes });
  for (const peerReturnAt of [resetNow + 30 * minutes, resetNow + 90 * minutes, resetNow + 4 * 60 * minutes]) {
    const o = owner();
    const run = limitSweep(o, { inputs: { weeklyCap: null, peerReturnAt } });
    assert.equal((await run.redeemer.maybeRedeemForPool([o])).redeemed, false, `peer in ${Math.round((peerReturnAt - resetNow) / 60000)}m: under the limit, kept`);
    assert.deepEqual(run.consumed, []);
  }
});


test('the expiry the table shows is counts and times only, distinguishes unknown from non-expiring, and is refreshed by a sweep', async () => {
  const owner = account({ quota: { unified7d: 0.1, unified7dReset: resetNow + 40 * 60 * minutes,
    codexWeeklyReadingAt: resetNow, codexResetCredits: { available: 2, checkedAt: resetNow } } });
  const lifts = [];
  const manager = { accounts: [owner], ensureTokenFresh: async () => true, clearRateLimited: i => { lifts.push(i); return true; } };
  let rows = [
    { id: 'secret-credit-a', title: 'Private title', status: 'available', supportedByPlan: true, expiresAt: resetNow + 5 * 60 * minutes },
    { id: 'secret-credit-b', status: 'available', supportedByPlan: true, expiresAt: null },
    { id: 'secret-spent', status: 'redeemed', supportedByPlan: true, expiresAt: resetNow + 60 * minutes },
    { id: 'secret-unsupported', status: 'available', supportedByPlan: false, expiresAt: resetNow + 60 * minutes },
  ];
  let reads = 0;
  const make = () => new ResetCreditRedeemer(manager, { now: () => resetNow, log() {}, usageFn: async () => ({}),
    transactState: resetFixture().transactState,
    detailsFn: async () => { reads++; return { credits: rows }; },
    consumeFn: () => assert.fail('refreshing the table must not spend') });
  const redeemer = make();
  assert.equal(redeemer.expirySummary(owner), null, 'unknown before any read');
  await redeemer.maybeRedeemForPool([owner]);     // 10% used: nothing to decide, the table still learns the dates
  assert.equal(reads, 1);
  const summary = redeemer.expirySummary(owner);
  assert.deepEqual(summary, { checkedAt: resetNow, count: 2, earliestExpiresAt: resetNow + 5 * 60 * minutes });
  assert.equal(JSON.stringify(summary).includes('secret'), false);
  await redeemer.maybeRedeemForPool([owner]);
  assert.equal(reads, 1, 'a fresh reading is not read again');
  assert.equal(redeemer.expirySummary(owner, resetNow + 16 * minutes), null, 'an old reading is unknown again');

  rows = [{ id: 'secret-never', status: 'available', supportedByPlan: true, expiresAt: null }];
  const never = make();
  await never.maybeRedeemForPool([owner]);
  assert.deepEqual(never.expirySummary(owner), { checkedAt: resetNow, count: 1, earliestExpiresAt: null },
    'confirmed non-expiring is a fact, not an unknown');
  rows = [];
  const empty = make();
  await empty.maybeRedeemForPool([owner]);
  assert.deepEqual(empty.expirySummary(owner), { checkedAt: resetNow, count: 0, earliestExpiresAt: null });

  // No count of banked resets, no read; a failed read is retried later, not on every sweep.
  const quiet = account({ quota: { ...owner.quota, codexResetCredits: { available: 0, checkedAt: resetNow } } });
  let quietReads = 0;
  const unread = new ResetCreditRedeemer({ accounts: [quiet], ensureTokenFresh: async () => true }, {
    now: () => resetNow, log() {}, transactState: resetFixture().transactState,
    detailsFn: async () => { quietReads++; return { credits: rows }; }, consumeFn: () => assert.fail('no spend') });
  await unread.maybeRedeemForPool([quiet]);
  assert.equal(quietReads, 0);
  assert.equal(unread.expirySummary(quiet), null);
  const failing = account({ quota: { ...owner.quota } });
  let failures = 0;
  const flaky = new ResetCreditRedeemer({ accounts: [failing], ensureTokenFresh: async () => true }, {
    now: () => resetNow, log() {}, transactState: resetFixture().transactState,
    detailsFn: async () => { failures++; return { error: 'HTTP 500' }; }, consumeFn: () => assert.fail('no spend') });
  await flaky.maybeRedeemForPool([failing]);
  await flaky.maybeRedeemForPool([failing]);
  assert.equal(failures, 1);
  assert.equal(flaky.expirySummary(failing), null);
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
  const claude = { name: 'same display name', provider: 'anthropic', accountUuid: 'claude-owner' };
  assert.equal(findAccountConfigIndex([{ ...claude, accountUuid: 'different-user' }], claude), -1);
  assert.equal(findAccountConfigIndex([{ ...claude, organizationUuid: 'learned-org' }], claude), 0);
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

test('a failed persist followed by another native rotation keeps the older disk grant from becoming live', async () => {
  const old = { accessToken: 'access-a', refreshToken: 'refresh-a', expiresAt: 1 };
  const intermediate = { accessToken: 'access-b', refreshToken: 'refresh-b', expiresAt: Date.now() + 3600000 };
  const latest = { accessToken: 'access-c', refreshToken: 'refresh-c', expiresAt: Date.now() + 3600000 };
  const newAuth = { accessToken: 'browser-access', refreshToken: 'browser-refresh', expiresAt: latest.expiresAt - 1000 };
  const afterBrowser = { accessToken: 'access-d', refreshToken: 'refresh-d', expiresAt: Date.now() + 3600000 };
  const am = new AccountManager([account({ type: 'oauth', ...old })], 0.9, {}, {
    refreshNativeCodexToken: async target => ({
      [old.refreshToken]: intermediate, [intermediate.refreshToken]: latest, [newAuth.refreshToken]: afterBrowser,
    })[target.refreshToken],
  });
  let disk = account(old);
  let latestRotation;
  am.onTokenRefresh(async (_index, tokens, rotation) => {
    if (tokens === intermediate) throw new Error('fixture disk temporarily unavailable');
    if (canPersistOAuthRefresh(disk, tokens, rotation)) disk = { ...disk, ...tokens };
    latestRotation = rotation;
  });
  assert.equal(await am.ensureTokenFresh(0), true);
  assert.equal(disk.refreshToken, old.refreshToken);
  assert.equal(await am.ensureTokenFresh(0, true), true);
  assert.equal(disk.refreshToken, latest.refreshToken);
  assert.deepEqual(oauthTokensForDiskSync(am.accounts[0], old), latest);
  const wrongWorkspace = account({ ...old, codexAccountId: 'other-workspace', organizationUuid: 'other-workspace' });
  assert.equal(canPersistOAuthRefresh(wrongWorkspace, latest, latestRotation), false);
  assert.equal(canPersistOAuthRefresh(account({ ...old, accountUuid: 'other-owner' }), latest, latestRotation), false);
  assert.equal(canPersistOAuthRefresh(account({ ...old, accessToken: 'another-access' }), latest, latestRotation), false);
  assert.equal(canPersistOAuthRefresh(account(newAuth), latest, latestRotation), false);
  assert.deepEqual(oauthTokensForDiskSync(am.accounts[0], newAuth), newAuth);

  am.updateAccountTokens(0, newAuth, { persist: false });
  disk = account(newAuth);
  assert.equal(await am.ensureTokenFresh(0, true), true);
  assert.equal(disk.refreshToken, afterBrowser.refreshToken);
  assert.equal(canPersistOAuthRefresh(account(old), afterBrowser, latestRotation), false, 'browser authorization starts a new lineage');
});

// A reset that dies BEFORE the free refill is spent at 100% — not held for a refill it
// will never see. BELOW 100% the same dying reset is never spent (final contract,
// 2026-11-27: no automatic reset below 100%, even if expiring).
test('a Codex credit dying before the free refill: kept below 100%, claimed at 100%; one that outlives the refill waits for it', () => {
  const owner = account({ quota: { unified7d: 0.3, unified7dReset: resetNow + 23 * 60 * minutes,
    codexWeeklyReadingAt: resetNow, lastProbeOkAt: resetNow } });
  const diesBeforeRefill = { ...availableCredit, expiresAt: resetNow + 2 * 60 * minutes };
  assert.equal(decideCodexWithReason(owner, [diesBeforeRefill], resetNow).action, null, '30% used, dies in 2h: kept');
  for (const used of [0.29, 0.8, 0.99, 0.999]) {
    owner.quota.unified7d = used;
    assert.equal(decideCodexWithReason(owner, [diesBeforeRefill], resetNow).action, null, `${used} used, dies in 2h: kept`);
  }
  // With the free refill far away nothing changes below 100% either.
  owner.quota.unified7dReset = resetNow + 3 * 86400000;
  assert.equal(decideCodexWithReason(owner, [diesBeforeRefill], resetNow).action, null);
  // At 100%: a credit that dies before the refill (23h out) is claimed, peers or not.
  owner.quota.unified7dReset = resetNow + 23 * 60 * minutes;
  owner.quota.unified7d = 1;
  const room = { listingCheckedAt: resetNow, peersWithRoom: () => 5, holdersInPool: () => 1 };
  assert.equal(decideCodexWithReason(owner, [diesBeforeRefill], resetNow, room).action?.reason, 'weekly at wall');
  // ...and one that OUTLIVES the refill waits for it while the pool has room.
  const survives = { ...availableCredit, expiresAt: resetNow + 3 * 86400000 };
  assert.equal(decideCodexWithReason(owner, [survives], resetNow, room).reason, HOLD_POOL_HAS_ROOM);
});

test('a Claude general grant dying before the free weekly refill: kept below 100%, claimed at 100%', () => {
  const now = 1800000000000;
  const base = { name: 'a', enabled: true,
    quota: { unified7d: 0.5, unified7dReset: now + 18 * 60 * minutes, unified5h: 0.2, lastProbeOkAt: now } };
  const grant = ends => ({ id: 'g1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
    endsAt: ends, clears: ['seven_day'], givesBackWeekly: false, blocking: false, unavailableReason: null, requiresLimit: false });
  const listing = g => ({ grants: [g], nextGrantId: null, cooldownUntil: null, eligible: true, stale: false, checkedAt: now });
  // 50% used: nothing is claimed, dying in 10h or outliving the refill by a day.
  assert.equal(decideClaudeWithReason(base, listing(grant(now + 10 * 60 * minutes)), now).action, null, 'dies before the refill, 50% used: kept');
  assert.equal(decideClaudeWithReason(base, listing(grant(now + 42 * 60 * minutes)), now).action, null);
  // At 100%: the one dying before the refill is claimed now; the long-lived one waits
  // for the free refill while the pool has room.
  const full = { ...base, quota: { ...base.quota, unified7d: 1 } };
  assert.equal(decideClaudeWithReason(full, listing(grant(now + 10 * 60 * minutes)), now).action?.reason, 'weekly at wall');
  assert.equal(decideClaudeWithReason(full, listing(grant(now + 42 * 60 * minutes)), now, { peersWithRoom: () => 2 }).reason, HOLD_POOL_HAS_ROOM);
});

test('a Fable grant dying before the Fable refill: kept below 100%, claimed at 100%', () => {
  const now = 1800000000000;
  const base = { name: 'a', enabled: true,
    quota: { unified7d: 0.4, unified7dReset: now + 4 * 86400000, unified5h: 0.2, lastProbeOkAt: now,
      scopedWeekly: { fable: { utilization: 0.5, resetAt: now + 18 * 60 * minutes, isActive: true } } } };
  const grant = ends => ({ id: 'f1', usableNow: true, paused: false, expired: false, resetsLeft: 1, resetsTotal: 1,
    endsAt: ends, clears: ['seven_day_overage_included'], givesBackWeekly: false, blocking: false, unavailableReason: null, requiresLimit: false });
  const listing = g => ({ grants: [g], nextGrantId: null, cooldownUntil: null, eligible: true, stale: false, checkedAt: now });
  assert.equal(decideClaudeWithReason(base, listing(grant(now + 10 * 60 * minutes)), now).action, null, '50% Fable bucket: kept');
  assert.equal(decideClaudeWithReason(base, listing(grant(now + 42 * 60 * minutes)), now).action, null);
  // At 100%: the model wall claims (a model wall is never held on its own).
  const full = { ...base, quota: { ...base.quota, scopedWeekly: { fable: { utilization: 1, resetAt: now + 18 * 60 * minutes, isActive: true } } } };
  assert.equal(decideClaudeWithReason(full, listing(grant(now + 10 * 60 * minutes)), now).action?.reason, 'fable weekly at wall');
  assert.equal(decideClaudeWithReason(full, listing(grant(now + 42 * 60 * minutes)), now).action?.reason, 'fable weekly at wall');
});

// Live 2026-11-27: the Codex path called clearRateLimited(), which did not exist, so a
// spent credit never lifted a "rate limited" bench. Through a REAL AccountManager.
test('a spent Codex credit puts a rate-limited account back in service', async () => {
  const owner = account({ autoRedeemReset: true });
  const am = new AccountManager([{ ...owner, type: 'oauth', accessToken: 't' }], 0.95);
  const real = am.accounts[0];
  am.autoRedeemReset = true; real.autoRedeemReset = true;
  real.quota.unified7d = 1;
  real.quota.unified7dReset = Date.now() + 20 * 60 * minutes;
  real.quota.codexWeeklyReadingAt = Date.now();
  am.markRateLimited(0, 24 * 60 * minutes, { status: 429 });
  assert.equal(real.status, 'throttled');
  const redeemer = new ResetCreditRedeemer(am, {
    transactState: resetFixture().transactState, log() {},
    detailsFn: async () => ({ credits: [availableCredit] }),
    consumeFn: async () => ({ code: 'reset', windowsReset: 1 }),
    usageFn: async () => ({ sevenDay: { utilization: 0.05, resetAt: Date.now() + 1440 * minutes } }),
  });
  const result = await redeemer.maybeRedeemForPool([real]);
  assert.equal(result.redeemed, true, result.reason);
  assert.notEqual(real.status, 'throttled', 'the bench is lifted by the real method');
  assert.ok(real.quota.unified7d < 0.1, `usage re-read after the reset (wk=${real.quota.unified7d})`);
  assert.equal(am._isAvailable(real, { model: 'gpt-6.2-sol' }), true, 'the account can serve again');
});
