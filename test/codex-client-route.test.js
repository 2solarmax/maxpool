/* global Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import { ReadableStream } from 'node:stream/web';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const path = '/maxpool/codex/v1';
const native = (name, models = [{ slug: 'gpt-6.2-sol' }]) => ({
  name, type: 'oauth', provider: 'codex', codexAuth: 'native',
  accountUuid: `user-${name}`, organizationUuid: `workspace-${name}`, codexAccountId: `workspace-${name}`,
  accessToken: `upstream-grant-${name}`, codexModels: models,
});

async function createFixture(t, { config = {}, accounts = [native('a'), native('b')], upstream, hooks = {} } = {}) {
  const am = new AccountManager(accounts);
  const calls = [];
  const server = createProxyServer(am, {
    proxy: { apiKey: 'owner-key', host: '127.0.0.1', clients: [{ name: 'team', key: 'team-key' }], ...config },
  }, { ...hooks, async fetchNativeCodex(url, init) {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: init.body });
    if (upstream) return upstream(String(url), init, calls);
    return new Response(null, { status: 503 });
  } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { am, calls, server, url: `http://127.0.0.1:${server.address().port}${path}` };
}

const body = { model: 'gpt-6.2-sol', store: false, stream: true, input: [{ role: 'user', content: 'test only' }] };

function response(url, data = body, headers = {}) {
  return fetch(url + '/responses', {
    method: 'POST', body: JSON.stringify(data),
    headers: { authorization: 'Bearer owner-key', 'content-type': 'application/json', 'x-client-request-id': 'session-a', ...headers },
  });
}

function streamed({ input = 8, cacheRead = 3, cacheWrite = 2, output = 4 } = {}) {
  return new Response('data: {"type":"response.output_text.delta","delta":"hello"}\n\n' +
    `data: ${JSON.stringify({ type: 'response.completed', response: { id: 'resp_a', usage: {
      input_tokens: input, output_tokens: output,
      input_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
    } } })}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', 'x-codex-primary-used-percent': '42',
    'x-codex-primary-window-minutes': '10080', 'set-cookie': 'never-forward', 'x-codex-turn-state': 'continuation-state' } });
}

test('native client routes require the owner bearer and a dedicated loopback listener', async t => {
  const { url, calls } = await createFixture(t);
  for (const headers of [{ authorization: '' }, { authorization: 'Bearer team-key' },
    { origin: 'https://website.example' }, { 'x-forwarded-for': '192.0.2.4' }]) {
    assert.equal((await response(url, body, headers)).status, 401);
  }
  const rebindingStatus = await new Promise((resolve, reject) => {
    const req = http.request(url + '/responses', { method: 'POST',
      headers: { host: 'unexpected.example', authorization: 'Bearer owner-key' } },
    res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.equal(rebindingStatus, 401);
  const wildcard = await createFixture(t, { config: { host: '0.0.0.0' } });
  assert.equal((await response(wildcard.url)).status, 404);
  assert.equal((await fetch(url + '/responses/deadbeef', { headers: { authorization: 'Bearer owner-key' } })).status, 404);
  assert.equal(calls.length, 0);
  assert.equal(wildcard.calls.length, 0);
});

test('native Responses preserve the wire and report cache-aware usage to the serving account', async t => {
  const { url, calls, am } = await createFixture(t, { upstream: () => streamed() });
  const requestBody = { ...body, prompt_cache_key: 'native-cache-scope' };
  const responseBody = await response(url, requestBody, { 'x-api-key': 'never-forward',
    'chatgpt-account-id': 'spoofed', 'session-id': 'native-cache-scope' });
  assert.equal(responseBody.status, 200);
  assert.match(await responseBody.text(), /"response.completed"/);
  assert.equal(responseBody.headers.get('set-cookie'), null);
  assert.equal(responseBody.headers.get('x-codex-turn-state'), 'continuation-state');
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/responses');
  assert.deepEqual(JSON.parse(calls[0].body), requestBody);
  assert.equal(calls[0].headers.authorization, 'Bearer upstream-grant-a');
  assert.equal(calls[0].headers['chatgpt-account-id'], 'workspace-a');
  assert.equal(calls[0].headers['x-api-key'], undefined);
  assert.equal(calls[0].headers['session-id'], 'native-cache-scope');
  assert.equal(am.accounts[0].quota.unified7d, 0.42);
  assert.equal(am.accounts[0].completedRequests, 1);
  assert.equal(am.accounts[0].usage.totalRequests, 1);
  assert.ok(Number.isFinite(Date.parse(am.accounts[0].usage.lastUsed)));
  assert.equal(am.callerStats.get('local-codex').total.tok, 12);
  const { cr, cc, promptTokens, hit } = am.efficiencyOverall().codex;
  assert.deepEqual({ cr, cc, promptTokens, hit }, { cr: 3, cc: 2, promptTokens: 8, hit: 0.375 });
  assert.deepEqual(am.accountCacheWindows(am.accounts[0]).windows.all,
    { input: 3, cacheRead: 3, cacheWrite: 2, output: 4, hit: 3 / 8, partial: false });
  const service = am.routingService.snapshot();
  assert.deepEqual([service.requests, service.completed, service.timelyCompleted, service.inputTokens, service.cachedInputTokens],
    [1, 1, 1, 8, 3]);
  const saved = am.exportNativeCodexConversationOwners();
  const restored = new AccountManager([native('a'), native('b')]);
  restored.restoreNativeCodexConversationOwners(saved);
  assert.equal(restored.nativeCodexOwner(saved[0][0]), saved[0][1]);
  assert.equal(JSON.stringify(saved).includes('session-a'), false);
  assert.equal(JSON.stringify(saved).includes('upstream-grant'), false);
});

test('Codex clients that close after response.completed still record success and usage once', async t => {
  let released;
  const closed = new Promise(resolve => { released = resolve; });
  const { url, am } = await createFixture(t, { upstream() {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(Buffer.from('data: {"type":"response.completed","response":{"usage":{"input_tokens":8,"output_tokens":4}}}\n\n'));
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const releaseAccount = am.releaseAccount.bind(am);
  am.releaseAccount = (lease, outcome) => {
    releaseAccount(lease, outcome);
    released();
  };
  await new Promise((resolve, reject) => {
    const req = http.request(url + '/responses', { method: 'POST', headers: {
      authorization: 'Bearer owner-key', 'content-type': 'application/json', 'session_id': 'completion-before-close',
    } }, res => {
      let data = '';
      res.on('data', chunk => {
        data += chunk;
        if (data.includes('response.completed')) {
          res.destroy();
          resolve();
        }
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  await closed;
  assert.equal(am.accounts[0].completedRequests, 1);
  assert.equal(am.accounts[0].failedRequests, 0);
  assert.equal(am.callerStats.get('local-codex').total.tok, 12);
  const observed = am.providerCacheWindows().codex.windows.all;
  assert.equal(observed.input, 8);
  assert.equal(observed.output, 4);
});

test('native Codex rotates before starting a turn but keeps encrypted state on its exact owner', async t => {
  const { url, calls } = await createFixture(t, { upstream(_url, init, observed) {
    if (observed.length === 1 || observed.length === 3) {
      return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: { 'retry-after': '5' } });
    }
    assert.equal(init.headers.authorization, 'Bearer upstream-grant-b');
    return streamed();
  } });
  assert.equal((await response(url)).status, 200);
  const continueBody = { ...body, input: [{ type: 'reasoning', encrypted_content: 'opaque' }] };
  assert.equal((await response(url, continueBody)).status, 429);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].headers.authorization, 'Bearer upstream-grant-b');
  assert.equal((await response(url, continueBody, { 'x-client-request-id': 'unknown-thread' })).status, 409);
  assert.equal(calls.length, 3);
});

test('catalog and compact use exact native operations and retain the listed Codex metadata', async t => {
  const accounts = [
    native('a'),
    { ...native('b'), codexAuth: 'siwc' },
    { name: 'anthropic', type: 'oauth', accessToken: 'other-provider' },
  ];
  const model = { slug: 'gpt-6.3-sol', display_name: 'Sol preview metadata', visibility: 'list',
    supported_reasoning_levels: [{ effort: 'high', description: 'full client metadata' }],
    context_window: 500000 };
  const compacted = { output: [{ type: 'compaction', encrypted_content: 'owned-state' }], usage: { input_tokens: 15, output_tokens: 5 } };
  const { url, calls, am } = await createFixture(t, { accounts, upstream(pathname) {
    if (pathname.includes('/models?')) return new Response(JSON.stringify({ models: [model, { ...model, slug: 'hidden', visibility: 'hide' }] }));
    if (pathname.endsWith('/responses/compact')) return new Response(JSON.stringify(compacted));
    return streamed();
  } });
  const response = await fetch(url + '/models?client_version=0.170.0&unknown=ignored', {
    headers: { authorization: 'Bearer owner-key' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { models: [model] });
  assert.equal(am.accounts[0].quota.codexModels, undefined, 'a client version catalog does not replace the shared quota catalog');
  assert.equal(am.accounts[0].usage.totalRequests, 0);
  assert.equal(calls[0].url, 'https://chatgpt.com/backend-api/codex/models?client_version=0.170.0');
  assert.equal(calls[0].headers.authorization, 'Bearer upstream-grant-a');
  assert.equal(calls.length, 1, 'only locally owned native ChatGPT credentials read the model catalog');

  const requestBody = { model: model.slug, input: [{ role: 'user', content: 'compact me' }] };
  const headers = { authorization: 'Bearer owner-key', 'x-client-request-id': 'compact-session', 'content-type': 'application/json' };
  const compactResponse = await fetch(url + '/responses/compact', {
    method: 'POST', headers, body: JSON.stringify(requestBody),
  });
  assert.equal(compactResponse.status, 200);
  assert.deepEqual(await compactResponse.json(), compacted);
  const measured = am.routingService.snapshot();
  assert.deepEqual([measured.arrivals, measured.requests, measured.completed, measured.inputTokens], [1, 1, 1, 15]);
  assert.equal(calls[1].url, 'https://chatgpt.com/backend-api/codex/responses/compact');
  assert.deepEqual(JSON.parse(calls[1].body), requestBody);
  assert.equal(am.accounts[0].usage.totalRequests, 1, 'the headerless compact response is still counted');
  assert.equal(am.callerStats.get('local-codex').total.tok, 20);
  assert.equal(am.accounts[1].completedRequests, 0);
  assert.equal(am.accounts[2].completedRequests, 0);
});

test('standalone search posts the native tool wire only on the exact conversation owner', async t => {
  const searchOutput = { encrypted_output: 'opaque-tool-state', output: 'Result', results: [{ type: 'text_result' }] };
  const { url, calls, am } = await createFixture(t, { upstream(pathname, init, observed) {
    if (observed.length === 1) return new Response(null, { status: 429 });
    assert.equal(init.headers.authorization, 'Bearer upstream-grant-b');
    if (pathname.endsWith('/alpha/search')) return new Response(JSON.stringify(searchOutput));
    return streamed();
  } });
  const search = { id: 'shared-session', model: body.model, commands: { search_query: [{ q: 'OpenAI Codex docs' }] } };
  const headers = { authorization: 'Bearer owner-key', 'content-type': 'application/json',
    'x-client-request-id': 'shared-session', 'thread-id': 'different-transport-thread',
    'x-codex-turn-metadata': JSON.stringify({ thread_id: 'specific-thread', session_id: 'shared-session' }) };
  const runSearch = () => fetch(url + '/alpha/search', { method: 'POST', headers, body: JSON.stringify(search) });
  assert.equal((await runSearch()).status, 409);
  assert.equal(calls.length, 0);
  const turn = await response(url, body, { 'thread-id': 'specific-thread', 'session-id': 'shared-session' });
  assert.equal(turn.status, 200);
  await turn.arrayBuffer();
  const result = await runSearch();
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), searchOutput);
  assert.equal(calls[2].url, 'https://chatgpt.com/backend-api/codex/alpha/search');
  assert.deepEqual(JSON.parse(calls[2].body), search);
  assert.equal(am.accounts[1].completedRequests, 2);
});

test('the shared reactive reset can unbench an opted-in native owner before retry', async t => {
  let resets = 0;
  const { url, calls, am } = await createFixture(t, {
    accounts: [{ ...native('a'), autoRedeemReset: true }, native('b')],
    upstream(_pathname, _init, observed) {
      if (observed.length === 2) return new Response(JSON.stringify({ error: { code: 'rate_limit_exceeded' } }), { status: 429, headers: {
        'x-codex-primary-used-percent': '100', 'x-codex-primary-window-minutes': '10080',
        'x-codex-primary-reset-at': String(Math.ceil(Date.now() / 1000) + 60),
      } });
      return streamed();
    },
    hooks: { redeemCodexForRequest(info) {
      resets++;
      const candidates = am.accounts.filter(account => account.autoRedeemReset && am._isRequestCompatible(account, info.profile, info));
      assert.deepEqual(candidates.map(account => account.name), ['a']);
      candidates[0].lastClaimAt = Date.now();
      am.applyCodexUsageData(0, { sevenDay: { utilization: 0, resetAt: Date.now() + 3600000 }, modelBuckets: [] });
      return { redeemed: true, accountName: 'a' };
    } },
  });
  const refused = [];
  am.codexReactiveReset = accounts => { refused.push(...accounts.map(a => a.name)); return false; };
  await (await response(url)).text();
  const next = await response(url, { ...body, input: [{ type: 'reasoning', encrypted_content: 'previous-turn' }] });
  assert.equal(next.status, 200);
  await next.text();
  assert.deepEqual(refused, ['a']);
  assert.equal(resets, 1);
  assert.deepEqual(calls.map(call => call.headers.authorization), Array(3).fill('Bearer upstream-grant-a'));
  assert.equal(am.accounts[0].usage.totalRequests, 3);
  assert.equal(am.accounts[0].completedRequests, 2);
});

test('a re-provisioned workspace cannot receive encrypted state from the old workspace', async t => {
  const { url, calls, am } = await createFixture(t, { upstream: () => streamed() });
  await (await response(url)).text();
  am.accounts[0].codexAccountId = 'replacement-workspace';
  am.accounts[0].organizationUuid = 'replacement-workspace';
  am.accounts[0].credential = 'replacement-grant';
  const next = await response(url, { ...body, previous_response_id: 'old-owner-state' });
  assert.equal(next.status, 429);
  assert.match(await next.text(), /owning local Codex account/);
  assert.equal(calls.length, 1);
});

for (const [minutes, field] of [['300', 'codexScopedFiveHour'], ['10080', 'scopedWeekly']]) {
  test(`a named ${minutes}-minute Codex cap preserves the reset error and keeps other models usable`, async t => {
    const resetAt = Math.ceil(Date.now() / 1000) + 1800;
    const quotaError = { error: { type: 'usage_limit_reached', resets_at: resetAt, plan_type: 'pro' } };
    const { url, calls, am } = await createFixture(t, {
      accounts: [native('a', [{ slug: body.model }, { slug: 'gpt-6-luna' }])],
      upstream(_pathname, _init, observed) {
        if (observed.length === 1) return new Response(JSON.stringify(quotaError), { status: 429, headers: {
          'x-codex-active-limit': 'premium', 'x-codex-premium-primary-used-percent': '100',
          'x-codex-premium-primary-window-minutes': minutes, 'x-codex-premium-primary-reset-at': String(resetAt),
        } });
        return streamed();
      },
    });
    const capped = await response(url);
    assert.equal(capped.status, 429);
    assert.deepEqual(await capped.json(), quotaError);
    assert.ok(Number(capped.headers.get('retry-after')) >= 1800);
    assert.equal(am.accounts[0].quota[field].premium.utilization, 1);
    assert.equal((await response(url)).status, 429);
    assert.equal(calls.length, 1);
    const other = await response(url, { ...body, model: 'gpt-6-luna' });
    assert.equal(other.status, 200);
    await other.text();
    assert.equal(calls.length, 2);
  });
}

test('a linked native mirror, disabled account, and unsupported model never receive raw native turns', async t => {
  const { url, calls, am } = await createFixture(t, { accounts: [native('cloud'), native('disabled'), native('wrong-model', [{ slug: 'gpt-luna' }])] });
  am.accounts[0].remote = { remoteName: 'cloud account' };
  am.accounts[1].enabled = false;
  assert.equal((await response(url)).status, 429);
  assert.equal(calls.length, 0);
  assert.equal((await response(url, { ...body, store: true })).status, 400);
  assert.equal((await response(url, { ...body, background: true })).status, 400);
  assert.equal(calls.length, 0);
});

test('concurrent initial native turns cannot establish conflicting owners for the same conversation', async t => {
  let unblock;
  const pause = new Promise(resolve => { unblock = resolve; });
  let entered;
  const active = new Promise(resolve => { entered = resolve; });
  const { url, calls } = await createFixture(t, { async upstream() { entered(); await pause; return streamed(); } });
  const first = response(url);
  try {
    await active;
    assert.equal((await response(url)).status, 409);
    assert.equal(calls.length, 1);
  } finally {
    unblock();
  }
  assert.equal((await first).status, 200);
});

test('a seamless handoff preserves the old worker owner before the first upstream byte', async t => {
  for (const oldStatus of [200, 429]) {
    let respond;
    const pendingResponse = new Promise(resolve => { respond = resolve; });
    let started;
    const forwarding = new Promise(resolve => { started = resolve; });
    const old = await createFixture(t, { async upstream() { started(); return pendingResponse; } });
    const next = await createFixture(t, { accounts: [native('b'), native('a')], upstream: () => streamed() });
    const first = response(old.url);
    try {
      await forwarding;
      old.server.maxpoolBeginDrain();
      const stale = ['codex-wire:' + 'f'.repeat(64), 'e'.repeat(64)];
      next.am.restoreNativeCodexConversationOwners([stale]);
      next.am.restoreNativeCodexConversationOwners(old.am.exportNativeCodexConversationOwners());
      assert.equal(next.am.nativeCodexOwner(stale[0]), null);
      assert.equal((await response(old.url, body, { 'x-client-request-id': 'later' })).status, 503);
    } finally {
      respond(oldStatus === 200 ? streamed() : new Response(null, { status: 429 }));
    }
    const initial = await first;
    assert.equal(initial.status, oldStatus);
    await initial.text();
    assert.equal(old.calls.length, 1, 'an outgoing worker cannot rotate its first-attempt reservation');
    const continuation = await response(next.url, { ...body, input: [{ type: 'reasoning', encrypted_content: 'owner-state' }] });
    assert.equal(continuation.status, 200);
    await continuation.text();
    assert.equal(next.calls[0].headers.authorization, 'Bearer upstream-grant-a');
  }
});

test('an uncertain first response keeps retries with the account that may have accepted the turn', async t => {
  const { url, calls } = await createFixture(t, { upstream(_target, _options, observed) {
    if (observed.length === 1) throw new Error('transport disconnected after accepting the body');
    return streamed();
  } });
  assert.equal((await response(url)).status, 502);
  const retry = await response(url, { ...body, previous_response_id: 'possibly-accepted' });
  assert.equal(retry.status, 200);
  await retry.text();
  assert.deepEqual(calls.map(call => call.headers.authorization), ['Bearer upstream-grant-a', 'Bearer upstream-grant-a']);
});

test('a delayed 401 retries the new authorization without refreshing its grant', async t => {
  let rejectOld;
  const oldResponse = new Promise(resolve => { rejectOld = resolve; });
  let started;
  const attempted = new Promise(resolve => { started = resolve; });
  let rotations = 0;
  const { url, calls, am } = await createFixture(t, {
    accounts: [{ ...native('a'), refreshToken: 'old-refresh', expiresAt: Date.now() + 3600000 }],
    async upstream(_target, _options, observed) {
      if (observed.length !== 1) return streamed();
      started();
      return oldResponse;
    },
  });
  am._refreshNativeCodexToken = async () => {
    rotations++;
    throw new Error('the new grant must not be refreshed by an old response');
  };
  const turn = response(url);
  await attempted;
  try {
    am.updateAccountTokens(0, {
      accessToken: 'browser-reauthorized', refreshToken: 'browser-refresh', expiresAt: Date.now() + 3600000,
    }, { persist: false });
  } finally {
    rejectOld(new Response(null, { status: 401 }));
  }
  const accepted = await turn;
  assert.equal(accepted.status, 200);
  await accepted.text();
  assert.equal(rotations, 0);
  assert.deepEqual(calls.map(call => call.headers.authorization), ['Bearer upstream-grant-a', 'Bearer browser-reauthorized']);
});

test('native inference analytics classify terminal errors, incomplete frames and a premature EOF independently of HTTP 200', async t => {
  const frames = ['response.failed', 'response.incomplete', 'response.created'];
  const { url, am } = await createFixture(t, { upstream() {
    return new Response('data: ' + JSON.stringify({ type: frames.shift(), response: {} }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  } });
  for (let i = 0; i < 3; i++) await (await response(url, body, { 'thread-id': 'analytics-thread-' + i })).text();
  const row = am.routingService.snapshot();
  assert.deepEqual([row.requests, row.completed, row.failed, row.incomplete, row.cancelled], [3, 0, 1, 2, 0]);
});
