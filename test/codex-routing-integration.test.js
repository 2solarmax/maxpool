import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { codexModelFor } from '../src/codex-model-routing.js';
import { Prober } from '../src/prober.js';

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}

const model = (slug, efforts = ['low', 'high']) => ({ slug, efforts });
const models = [model('gpt-6.2-astra'), model('gpt-6-luna'), model('gpt-6.2-sol')];

function native(name, upstream, codexModels = models) {
  return { name, type: 'oauth', provider: 'codex', codexAuth: 'native',
    codexAccountId: 'workspace-' + name, accessToken: 'fake-' + name, upstream, codexModels };
}

function request(url, modelName, session, prompt, extra = {}, headers = {}) {
  return fetch(url + '/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'fixture', 'x-maxpool-profile': 'all', ...headers },
    body: JSON.stringify({ model: modelName, stream: true, metadata: { user_id: JSON.stringify({ session_id: session }) },
      messages: [{ role: 'user', content: prompt }], ...extra }),
  });
}

test('newest compatible Codex model follows class and effort, while exact selections stay exact', () => {
  const account = native('one', '', [
    ...models,
    model('gpt-6.9-sol', ['low']),
    model('gpt-6.10-sol', ['high']),
    model('gpt-8-sol-preview'),
    model('gpt-8-new-family'),
  ]);
  assert.equal(codexModelFor({ model: 'claude-fable-5-2' }, account), 'gpt-6.2-astra');
  assert.equal(codexModelFor({ model: 'claude-opus-5-5' }, account), 'gpt-6.2-astra');
  assert.equal(codexModelFor({ model: 'claude-haiku-5' }, account), 'gpt-6-luna');
  assert.equal(codexModelFor({ model: 'claude-sonnet-5-2', reasoningEffort: 'high' }, account), 'gpt-6.10-sol');
  assert.equal(codexModelFor({ model: 'claude-sonnet-5-2', reasoningEffort: 'low' }, account), 'gpt-6.9-sol');
  assert.equal(codexModelFor({ openAIModel: 'gpt-6.10-sol', reasoningEffort: 'low' }, account), null);
});

test('native requests, quota, attribution and provider affinity survive compaction and account rotation', async t => {
  const hits = [];
  const ordinaryUpstream = await listen(t, http.createServer((req, res) => {
    hits.push({ provider: 'claude' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_011-claude","model":"claude-sonnet-5-2"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n');
  }));
  const reset = Math.floor(Date.now() / 1000) + 9000;
  const codexUpstream = await listen(t, http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    hits.push({ provider: 'codex', workspace: req.headers['chatgpt-account-id'], body: parsed });
    res.writeHead(200, { 'x-codex-primary-used-percent': '52',
      'x-codex-primary-window-minutes': '10080', 'x-codex-primary-reset-at': String(reset) });
    const frames = [
      { type: 'response.created', response: { id: 'resp_' + hits.length, model: parsed.model } },
      { type: 'response.output_text.delta', item_id: 'item', delta: 'native fixture completed' },
      { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } },
    ];
    res.end(frames.map(frame => 'event: '+frame.type+'\ndata: '+JSON.stringify(frame)+'\n\n').join(''));
  }));
  const am = new AccountManager([
    { name: 'healthy Claude', type: 'apikey', apiKey: 'fake-claude', upstream: ordinaryUpstream },
    native('one', codexUpstream + '/v1/responses'),
    native('two', codexUpstream + '/v1/responses'),
  ], 0.95, { routingMode: 'balance' });
  const url = await listen(t, createProxyServer(am, { proxy: { apiKey: 'fixture' }, queue: { enabled: false } }));
  const session = 'thread-0001';
  const first = await request(url, 'claude-fable-5-2', session, 'first', {
    output_config: { effort: 'high' },
    tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
  }, { 'x-maxpool-provider': 'codex' });
  assert.equal(first.status, 200);
  const firstText = await first.text();
  assert.match(firstText, /native fixture completed/);
  assert.match(firstText, /"model":"claude-fable-5-2"/);
  const id = /"id":"(msg_maxpool_codex_[^"]+)"/.exec(firstText)?.[1];
  assert.ok(id);
  const routeURL = url + '/maxpool/last-route?messageId=' + encodeURIComponent(id);
  assert.deepEqual(await (await fetch(routeURL, { headers: { 'x-api-key': 'fixture' } })).json(),
    { provider: 'codex', model: 'gpt-6.2-astra' });
  assert.equal((await fetch(routeURL)).status, 401);
  const firstAccount = am.accounts.find(account => 'workspace-' + account.name === hits[0].workspace);
  assert.equal(firstAccount.quota.unified7d, 0.52);
  assert.equal(firstAccount.quota.unified7dReset, reset * 1000);
  assert.deepEqual(hits[0].body.reasoning, { effort: 'high' });
  assert.equal(hits[0].body.tools[0].type, 'function');
  const saved = am.exportSessionProviders();
  am.conversationProvider.clear();
  am.restoreSessionProviders(saved);

  firstAccount.enabled = false;
  const second = await request(url, 'claude-haiku-5', session, 'compacted replacement history');
  assert.equal(second.status, 200);
  assert.match(await second.text(), /native fixture completed/);
  assert.equal(hits[1].body.model, 'gpt-6-luna');
  assert.notEqual(hits[1].workspace, hits[0].workspace);
  am.accounts.filter(account => account.provider === 'codex').forEach(account => { account.enabled = false; });
  const blocked = await request(url, 'claude-haiku-5', session, 'another turn');
  assert.equal(blocked.status, 429);
  assert.match(await blocked.text(), /No Codex account can serve this request/);
  assert.equal(hits.length, 2, 'the healthy Claude account must not serve an OpenAI-origin session');
  const newThread = await request(url, 'claude-sonnet-5-2', 'thread-0002', 'new session');
  assert.equal(newThread.status, 200);
  await newThread.text();
  assert.equal(hits[2].provider, 'claude');
});

test('Codex quota sweep refreshes ETag catalog without trying Anthropic endpoints', async () => {
  const am = new AccountManager([native('one', null)]);
  const original = am.accounts[0];
  original.quota.codexCatalogEtag = 'prior';
  let catalogCalls = 0;
  const prober = new Prober(am, { usageGapMs: 0,
    probeFn: async () => { assert.fail('Codex must not hit Anthropic'); },
    codexProbeFn: async () => ({ sevenDay: { utilization: 0.5, resetAt: Date.now() + 50000 },
      modelBuckets: [], resetCredits: { available: 3, applicable: 0 } }),
    codexCatalogFn: async (_account, { etag }) => {
      assert.equal(etag, 'prior');
      catalogCalls++;
      return { models: [model('gpt-6.3-sol')], etag: 'new', version: '0.200.0' };
    },
  });
  await prober.probeAll();
  await prober.probeAll();
  assert.equal(catalogCalls, 1);
  assert.equal(original.quota.codexCatalogEtag, 'new');
  assert.equal(original.quota.codexCatalogVersion, '0.200.0');
  assert.equal(original.quota.codexResetCredits.available, 3);
  assert.equal(codexModelFor({ model: 'claude-sonnet-5-2' }, original), 'gpt-6.3-sol');
});

test('browser account screen shows native quota and banked reset inventory', async t => {
  const { runInNewContext } = await import('node:vm');
  const am = new AccountManager([native('codex screen fixture', null)]);
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.45, resetAt: Date.now() + 1800000 },
    modelBuckets: [], resetCredits: { available: 3, applicable: 0 } });
  const url = await listen(t, createProxyServer(am, { proxy: { apiKey: 'fixture' }, queue: { enabled: false } }));
  const doc = await (await fetch(url + '/maxpool/screen')).text();
  const script = /<script>([\s\S]+)<\/script>/.exec(doc)?.[1];
  assert.ok(script);
  const app = {};
  let ready;
  const finished = new Promise(resolve => { ready = resolve; });
  runInNewContext(script, {
    document: { getElementById(id) { if (id === 'out') ready(); return id === 'app' ? app : {}; } },
    localStorage: { getItem() { return 'fixture'; } },
    fetch: (path, options) => fetch(url + path, options),
    setTimeout() { return 0; },
    clearTimeout() {},
    setInterval() { return 0; },
    clearInterval() {},
  });
  await finished;
  assert.match(app.innerHTML, /codex screen fixture/);
  assert.match(app.innerHTML, /class="sub">Codex/);
  assert.match(app.innerHTML, /45%/);
  assert.match(app.innerHTML, /Weekly reset/);
  assert.match(app.innerHTML, /3 banked · 0 eligible/);
  assert.match(app.innerHTML, /Automatic resets off/);
});

test('a native model-specific limit follows the account’s selected effort-compatible model', () => {
  const account = native('fixture', null, [model('gpt-6.3-astra', ['low']), model('gpt-6.2-astra', ['high'])]);
  const am = new AccountManager([account], 0.95, { routingMode: 'balance' });
  const stamp = Date.now() + 100000;
  am.applyCodexUsageData(0, { modelBuckets: [{ slug: 'premium', utilization: 1, resetAt: stamp }] });
  am.accounts[0].quota.codexLimitByModel = { 'gpt-6.3-astra': 'premium' };
  const info = { profile: 'all', path: '/v1/messages', model: 'claude-fable-5-2', codexCompatible: true };
  assert.equal(am.hasAvailableRoute({ ...info, reasoningEffort: 'low' }), false);
  assert.equal(am.hasAvailableRoute({ ...info, reasoningEffort: 'high' }), true);
});

test('a named pin cannot override a sticky Codex provider on the same caller and session', () => {
  const am = new AccountManager([native('codex', null), { name: 'claude', type: 'apikey', apiKey: 'fake' }]);
  const info = { clientThreadId: 'session-1', caller: 'sam', profile: 'all',
    path: '/v1/messages', model: 'claude-sonnet-5-2', codexCompatible: true };
  am.noteConversationServed(info, am.accounts[0]);
  assert.equal(am.getActiveAccount({ ...info, pinAccount: 'claude' }), null);
  assert.equal(am.getActiveAccount({ ...info, caller: 'bleu', pinAccount: 'claude' })?.name, 'claude');
});

test('linked pool accepts a native grant and advertises routing and reset metadata to the edge', async t => {
  const { mkdtemp, readFile, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { PoolLink } = await import('../src/pool-link.js');
  const { sendLoginToPool } = await import('../src/cloud-login.js');
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-linked-codex-'));
  const oldConfig = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'config.json');
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = oldConfig;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(process.env.MAXPOOL_CONFIG, JSON.stringify({ accounts: [] }));
  const am = new AccountManager([]);
  const cloud = await listen(t, createProxyServer(am, { proxy: { clients: [{ name: 'edge', key: 'fixture' }] } }));
  const prepared = await fetch(cloud + '/maxpool/chatgpt-login?native=1', { headers: { 'x-api-key': 'fixture' } });
  assert.equal((await prepared.json()).nativeCodex, true);
  const profile = { provider: 'codex', accountUuid: 'user-fixture', organizationUuid: 'workspace-fixture' };
  const creds = { codexAuth: 'native', codexAccountId: 'workspace-fixture',
    accessToken: 'fake-access', refreshToken: 'fake-refresh', expiresAt: Date.now() + 60000, codexModels: models };
  const result = await sendLoginToPool({ url: cloud, key: 'fixture', name: 'Team Codex', profile, creds });
  assert.equal(result.ok, true);
  const saved = JSON.parse(await readFile(process.env.MAXPOOL_CONFIG, 'utf8')).accounts[0];
  assert.equal(saved.codexAccountId, profile.organizationUuid);
  assert.equal(saved.codexAuth, 'native');
  am.applyCodexUsageData(0, { sevenDay: { utilization: 0.24, resetAt: Date.now() + 900000 },
    modelBuckets: [], resetCredits: { available: 2, applicable: 1 } });
  am.accounts[0].autoRedeemReset = true;
  const link = new PoolLink({ name: 'team', url: cloud, key: 'fixture' });
  await link.poll();
  const edge = new AccountManager([]);
  edge.syncRemoteMirrors(link);
  const mirror = edge.accounts[0];
  assert.equal(mirror.name, 'Team Codex ☁');
  assert.equal(mirror.credential, null);
  assert.equal(mirror.refreshToken, null);
  assert.equal(mirror.codexResetCredits.available, 2);
  assert.equal(edge.getStatus().accounts[0].autoRedeemReset, true);
  assert.equal(mirror.quota.unified7d, 0.24);
  assert.equal(codexModelFor({ model: 'claude-fable-5-2' }, mirror), 'gpt-6.2-astra');
});

test('an opted-in banked reset can release a dry Codex-only request without rerouting it', async t => {
  const upstream = await listen(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain input */ }
    res.writeHead(200);
    res.end('data: {"type":"response.output_text.delta","item_id":"m1","delta":"after the reset"}\n\n' +
      'data: {"type":"response.completed","response":{}}\n\n');
  }));
  const am = new AccountManager([native('dry', upstream), { name: 'other-provider', type: 'apikey', apiKey: 'fake' }]);
  const resetAt = Date.now() + 3600000;
  am.applyCodexUsageData(0, { sevenDay: { utilization: 1, resetAt }, modelBuckets: [] });
  let redeemed = 0;
  const hooks = { redeemCodexForRequest(info) {
    assert.equal(info.onlyProvider, 'codex');
    redeemed++;
    am.applyCodexUsageData(0, { sevenDay: { utilization: 0, resetAt: resetAt + 3600000 }, modelBuckets: [] });
    return { redeemed: true };
  } };
  const url = await listen(t, createProxyServer(am, { proxy: { apiKey: 'fixture' }, queue: { enabled: false } }, hooks));
  const result = await request(url, 'claude-sonnet-5-2', 'thread-reset-1', 'use the eligible account',
    {}, { 'x-maxpool-provider': 'codex' });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /after the reset/);
  assert.equal(redeemed, 1);
  assert.equal(am.accounts[0].completedRequests, 1);
  assert.equal(am.accounts[1].completedRequests, 0);
});

test('a running quota probe cannot apply an old grant’s response to another account', async () => {
  const am = new AccountManager([native('old', null), native('replacement', null)]);
  const [old, replacement] = am.accounts;
  let start;
  const started = new Promise(resolve => { start = resolve; });
  let answer;
  const pending = new Promise(resolve => { answer = resolve; });
  const probe = new Prober(am, { usageGapMs: 0,
    codexProbeFn: account => {
      if (account === old) { start(); return pending; }
      return { modelBuckets: [] };
    },
    codexCatalogFn: () => ({ notModified: true }),
  });
  const sweep = probe.probeAll();
  await started;
  am.removeAccount(old.index);
  assert.equal(replacement.index, 0);
  answer({ sevenDay: { utilization: 0.9, resetAt: Date.now() + 3000000 }, resetCredits: { available: 5 } });
  await sweep;
  assert.equal(replacement.quota.unified7d, null);
  assert.equal(replacement.quota.codexResetCredits, undefined);
});
