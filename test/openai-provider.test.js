import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { sendLoginToPool } from '../src/cloud-login.js';
import { loginOpenAI } from '../src/openai-login.js';
import { PoolLink } from '../src/pool-link.js';

/* global Response */

async function start(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const codex = (extra = {}) => ({ name: 'chatgpt', type: 'oauth', provider: 'codex', model: 'gpt-test',
  oauthClientId: 'oaiapp_test', accessToken: 'dummy-openai-token', ...extra });

function event(res, value) {
  res.write(`event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`);
}
function client(url, data, session = 'session') {
  return fetch(url + '/v1/messages', {
    method: 'POST', headers: { 'content-type': 'application/json',
      'x-maxpool-profile': 'all', 'x-maxpool-session': session, 'x-api-key': 'test-client' },
    body: JSON.stringify({ model: 'claude-test', stream: true, ...data }),
  });
}
const user = { role: 'user', content: 'Run the local tool.' };
const tool = { name: 'Bash', description: 'Run a command',
  input_schema: { type: 'object', properties: { command: { type: 'string' } } } };

test('Claude Code Messages route falls back to ChatGPT and replays a full tool round trip', async t => {
  const seen = [];
  const upstream = await start(t, http.createServer(async (req, res) => {
    let data = '';
    for await (const c of req) data += c;
    const body = JSON.parse(data);
    seen.push({ path: req.url, headers: req.headers, body });
    res.writeHead(200, { 'set-cookie': 'upstream-only=1', 'x-codex-turn-state': 'upstream-only' });
    event(res, { type: 'response.created', response: { id: 'resp_openai' } });
    if (seen.length === 1) {
      const item = { id: 'fc_1', type: 'function_call', name: 'Bash', namespace: 'claude_code', call_id: 'call_x' };
      event(res, { type: 'response.output_item.added', item });
      event(res, { type: 'response.function_call_arguments.delta', item_id: item.id, delta: '{"command":"pwd"}' });
      event(res, { type: 'response.output_item.done', item: { ...item, arguments: '{"command":"pwd"}' } });
    } else {
      event(res, { type: 'response.output_text.delta', item_id: 'msg_1', delta: 'Tool finished.' });
    }
    event(res, { type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 3 } } });
    res.end();
  }));
  const am = new AccountManager([
    { name: 'claude', type: 'apikey', apiKey: 'dummy', enabled: false },
    { name: 'glm', type: 'provider', provider: 'zai', apiKey: 'dummy', enabled: false },
    codex({ upstream: upstream + '/v1/responses' }),
  ], 0.9);
  const base = await start(t, createProxyServer(am, { proxy: { apiKey: 'test-client' }, queue: { enabled: false } }));
  const first = await client(base, { messages: [user], tools: [tool], output_config: { effort: 'high' } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.equal(first.headers.get('set-cookie'), null);
  assert.equal(first.headers.get('x-codex-turn-state'), null);
  const firstWire = await first.text();
  assert.match(firstWire, /"type":"tool_use","id":"call_x","name":"Bash"/);
  assert.match(firstWire, /"stop_reason":"tool_use"/);
  am.accounts[0].enabled = true;
  am.accounts[1].enabled = true;
  const second = await client(base, { messages: [user,
    { role: 'assistant', content: [{ type: 'tool_use', id: 'call_x', name: 'Bash', input: { command: 'pwd' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_x', content: '/test/project' }] },
  ], tools: [tool], output_config: { effort: 'auto' } });
  assert.equal(second.status, 200);
  assert.match(await second.text(), /Tool finished\./);
  assert.equal(seen.length, 2, 'same thread remains on ChatGPT after Claude recovers');
  assert.equal(seen[0].path, '/v1/responses');
  assert.equal(seen[0].headers.authorization, 'Bearer dummy-openai-token');
  assert.equal(seen[0].headers['x-api-key'], undefined);
  assert.equal(seen[0].body.model, 'gpt-test');
  assert.equal(seen[0].body.store, false);
  assert.equal(seen[0].body.tools[0].tools[0].name, 'Bash');
  assert.equal(seen[0].body.input[0].role, 'user');
  assert.deepEqual(seen[0].body.reasoning, { effort: 'high' });
  assert.equal(seen[1].body.reasoning, undefined);
  const output = seen[1].body.input.find(item => item.type === 'function_call_output');
  assert.equal(output.call_id, 'call_x');
  assert.equal(output.output[0].text, '/test/project');
  assert.equal(am.accounts[2].completedRequests, 2);
});

test('per-provider cross routing leaves a ChatGPT thread eligible for Claude', () => {
  const am = new AccountManager([codex(), { name: 'claude', type: 'apikey', apiKey: 'dummy' }], 0.9, {
    providers: { codex: { sessionRouting: 'cross-provider' } },
  });
  const request = { profile: 'all', codexCompatible: true, affinityKey: 'a', path: '/v1/messages' };
  am.noteConversationServed(request, am.accounts[0]);
  assert.equal(am.pinnedSessionProvider(request), null);
  assert.equal(am.getActiveAccount(request, new Set([0]))?.name, 'claude');
  am.scheduler.providers.codex.sessionRouting = 'same-provider';
  am.noteConversationServed({ ...request, _notedServed: undefined }, am.accounts[0]);
  assert.equal(am.getActiveAccount(request, new Set([0])), null);
  const restored = new AccountManager([codex(), { name: 'claude', type: 'apikey', apiKey: 'dummy' }], 0.9);
  restored.restoreSessionProviders(am.exportSessionProviders());
  assert.equal(restored.pinnedSessionProvider(request), 'codex');
});

test('an early Responses quota error rotates to the next ChatGPT account', async t => {
  const creds = [];
  const upstream = await start(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain input */ }
    creds.push(req.headers.authorization);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'retry-after': '45' });
    event(res, { type: 'response.created', response: { id: 'resp_openai' } });
    if (creds.length === 1) {
      event(res, { type: 'response.failed', response: { error: {
        code: 'subscription_sharing_usage_limit_exceeded', message: 'Plan usage limit exceeded',
      } } });
    } else {
      event(res, { type: 'response.output_text.delta', item_id: 'a', delta: 'available' });
      event(res, { type: 'response.completed', response: {} });
    }
    res.end();
  }));
  const am = new AccountManager([codex({ upstream, priority: 0 }),
    codex({ name: 'second', accessToken: 'second-token', upstream, priority: 1 })], 0.9);
  const base = await start(t, createProxyServer(am, { proxy: { apiKey: 'test-client' }, queue: { enabled: false } }));
  const res = await client(base, { messages: [user] }, 'rate-limit-case');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /available/);
  assert.deepEqual(creds, ['Bearer dummy-openai-token', 'Bearer second-token']);
  assert.ok(am.accounts[0].rateLimitedUntil > Date.now());
});

test('linked cloud onboarding persists a ChatGPT grant and uses only OpenAI refresh', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-openai-cloud-'));
  const oldConfig = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'config.json');
  const config = { proxy: { apiKey: 'test-client' }, accounts: [] };
  await writeFile(process.env.MAXPOOL_CONFIG, JSON.stringify(config));
  t.after(async () => {
    if (oldConfig === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = oldConfig;
    await rm(dir, { recursive: true, force: true });
  });
  const am = new AccountManager([], 0.9, {}, {
    refreshOpenAIToken: async account => {
      assert.equal(account.oauthClientId, 'oaiapp_test');
      return { accessToken: 'updated', refreshToken: 'replace', expiresAt: Date.now() + 3600_000 };
    },
    refreshAccessToken: async () => assert.fail('sent ChatGPT grant to Anthropic'),
  });
  const url = await start(t, createProxyServer(am, config));
  const auth = { headers: { 'x-api-key': 'test-client' } };
  assert.equal((await fetch(url + '/maxpool/chatgpt-login')).status, 401);
  const init = await fetch(url + '/maxpool/chatgpt-login?name=chatgpt', auth);
  const { hostId } = await init.json();
  assert.match(hostId, /^urn:uuid:/);
  const grant = { accessToken: 'approved', refreshToken: 'initial', expiresAt: Date.now() - 1,
    oauthClientId: 'oaiapp_test', model: 'gpt-test' };
  const profile = { accountUuid: 'sub_test', provider: 'codex', organizationUuid: 'oaiapp_test' };
  const pub = await sendLoginToPool({ url, key: 'test-client', name: 'chatgpt', profile, creds: grant });
  assert.equal(pub.result, 'added');
  const disk = JSON.parse(await readFile(process.env.MAXPOOL_CONFIG, 'utf8'));
  assert.equal(disk.accounts[0].provider, 'codex');
  assert.equal(disk.accounts[0].model, 'gpt-test');
  const reconnect = await fetch(url + '/maxpool/chatgpt-login?name=chatgpt', auth);
  const setup = await reconnect.json();
  assert.equal(setup.hostId, hostId);
  assert.deepEqual(setup.prior, { accountUuid: 'sub_test', oauthClientId: 'oaiapp_test', model: 'gpt-test' });
  assert.equal(await am.ensureTokenFresh(0), true);
  assert.equal(am.accounts[0].credential, 'updated');
  const reauthed = await sendLoginToPool({ url, key: 'test-client', name: 'chatgpt', profile,
    creds: { ...grant, accessToken: 'reauthed' } });
  assert.equal(reauthed.result, 'reauthed');
  assert.equal(am.accounts.length, 1);
});

test('OpenAI browser login uses PKCE and verifies signed plan-grant identity', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const issuer = 'https://auth.openai.com';
  const clientId = 'oaiapp_test';
  let authorization;
  const login = loginOpenAI({
    hostId: 'urn:uuid:11111111-1111-4111-8111-111111111111',
    report: () => {},
    open: url => {
      authorization = new URL(url).searchParams;
      const callback = new URL(authorization.get('redirect_uri'));
      callback.search = new URLSearchParams({ state: authorization.get('state'), code: 'fake-code', client_id: clientId });
      void fetch(callback);
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/jwks.json')) {
        return new Response(JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test' }] }));
      }
      assert.equal(url, issuer + '/api/accounts/oauth/token');
      assert.equal(authorization.get('client_id'), 'dynamic_agent_client');
      assert.equal(options.body.get('client_id'), clientId);
      assert.equal(options.body.get('resource'), 'https://api.openai.com/v1');
      assert.equal(options.body.get('redirect_uri'), authorization.get('redirect_uri'));
      const verifier = options.body.get('code_verifier');
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorization.get('code_challenge'));
      const b64 = object => Buffer.from(JSON.stringify(object)).toString('base64url');
      const unsigned = b64({ kid: 'test', alg: 'RS256' }) + '.' + b64({
        iss: issuer, aud: clientId, nonce: authorization.get('nonce'), exp: Date.now() / 1000 + 3600,
        sub: 'fixture-subject', email_verified: true, email: 'fixture@example.test',
      });
      return new Response(JSON.stringify({
        id_token: unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url'),
        refresh_token: 'fixture-refresh', access_token: 'fixture-access', expires_in: 3600,
        scope: 'openid resource.invoke chatgpt.tokens.use.direct offline_access',
      }));
    },
  });
  const result = await login;
  assert.deepEqual(result.profile, { provider: 'codex', accountUuid: 'fixture-subject',
    organizationUuid: clientId, email: 'fixture@example.test' });
  assert.equal(result.creds.oauthClientId, clientId);
});

test('the edge can route ordinary Claude Code Messages to a linked cloud ChatGPT account', async t => {
  let calls = 0;
  const upstream = await start(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* read the request */ }
    calls++;
    assert.equal(req.headers.authorization, 'Bearer dummy-openai-token');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { type: 'response.created', response: { id: 'resp_' + calls } });
    event(res, { type: 'response.output_text.delta', item_id: 'txt', delta: 'Cloud answer' });
    event(res, { type: 'response.completed', response: {} });
    res.end();
  }));
  const cloudAccounts = new AccountManager([codex({ upstream })], 0.9);
  const cloud = await start(t, createProxyServer(cloudAccounts, {
    proxy: { clients: [{ name: 'edge', key: 'test-edge-key' }] }, queue: { enabled: false },
  }));
  const edgeAccounts = new AccountManager([], 0.9);
  const link = new PoolLink({ name: 'team', url: cloud, key: 'test-edge-key' });
  await link.poll();
  edgeAccounts.syncRemoteMirrors(link);
  assert.equal(edgeAccounts.accounts[0].name, 'chatgpt ☁');
  const edge = await start(t, createProxyServer(edgeAccounts, {
    proxy: { apiKey: 'test-client' }, queue: { enabled: false },
  }));
  const answer = await client(edge, { messages: [user] });
  assert.equal(answer.status, 200);
  assert.match(await answer.text(), /Cloud answer/);
  assert.equal(calls, 1);
});

test('an early OpenAI 401 forces one refresh and retries on the same account', async t => {
  const attempts = [];
  const upstream = await start(t, http.createServer(async (req, res) => {
    for await (const _ of req) { /* read the request */ }
    attempts.push(req.headers.authorization);
    if (attempts.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'token_expired', message: 'Provided authentication token is expired.' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    event(res, { type: 'response.output_text.delta', item_id: 'txt', delta: 'Refreshed' });
    event(res, { type: 'response.completed', response: {} });
    res.end();
  }));
  let refreshes = 0;
  let persisted = false;
  const am = new AccountManager([codex({
    upstream, refreshToken: 'original-refresh', expiresAt: Date.now() + 3600_000,
  })], 0.9, {}, { refreshOpenAIToken: async () => {
    refreshes++;
    return { accessToken: 'updated-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 };
  } });
  am.onTokenRefresh(() => { persisted = true; });
  const base = await start(t, createProxyServer(am, { proxy: { apiKey: 'test-client' }, queue: { enabled: false } }));
  const result = await client(base, { messages: [user] });
  assert.equal(result.status, 200);
  assert.match(await result.text(), /Refreshed/);
  assert.deepEqual(attempts, ['Bearer dummy-openai-token', 'Bearer updated-access']);
  assert.equal(refreshes, 1);
  assert.equal(persisted, true);
});
