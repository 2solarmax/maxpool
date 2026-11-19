import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { toOpenAIRequest } from '../src/openai-responses.js';

const searchRequest = {
  model: 'claude-sonnet-5-5',
  system: 'Search once, then reply with a brief summary of the results.',
  messages: [{ role: 'user', content: 'Perform a web search for the query: IANA reserved example domains' }],
  tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
  tool_choice: { type: 'auto' },
};

test('hosted search maps filters, location, explicit choice and search budget by upstream', () => {
  const search = {
    ...searchRequest.tools[0],
    type: 'web_search_20260318',
    name: 'docs_search',
    allowed_domains: ['iana.org'],
    user_location: { type: 'approximate', country: 'US' },
  };
  const request = { ...searchRequest, tools: [search], tool_choice: { type: 'tool', name: 'docs_search' } };
  const native = toOpenAIRequest(request, 'gpt-6.2-sol', { native: true });
  assert.deepEqual(native.body.tools, [{ type: 'web_search', external_web_access: true,
    filters: { allowed_domains: ['iana.org'] }, user_location: { type: 'approximate', country: 'US' } }]);
  assert.deepEqual(native.body.include, ['web_search_call.action.sources']);
  assert.deepEqual(native.body.tool_choice, { type: 'web_search' });
  assert.match(native.body.instructions, /Use web search at most 8 times/);
  assert.equal(native.body.max_tool_calls, undefined);
  assert.equal(native.webSearch, 'docs_search');
  assert.equal(toOpenAIRequest(request, 'gpt-6.2-sol').body.max_tool_calls, 8);

  const fn = toOpenAIRequest({ ...searchRequest, tools: [{ name: 'WebFetch', input_schema: { type: 'object' } }],
    tool_choice: { type: 'tool', name: 'WebFetch' } }, 'gpt-6.2-sol', { native: true });
  assert.equal(fn.webSearch, undefined);
  assert.deepEqual(fn.body.tool_choice, { type: 'function', name: 'WebFetch' });
});

async function listen(t, server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('Claude Code hosted search helper receives sources and an end turn through MaxPool', async t => {
  const requests = [];
  const receipt = { type: 'web_search_call', id: 'ws_source', status: 'completed',
    action: { type: 'search', query: 'IANA reserved example domains', sources: [
      { type: 'url', url: 'https://www.iana.org/domains/reserved', title: 'IANA-managed Reserved Domains' },
      { type: 'url', url: 'https://www.iana.org/domains/reserved' },
      { type: 'url', url: 'javascript:unsafe' },
    ] } };
  const upstream = await listen(t, createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [
      { type: 'response.created', response: { id: 'resp_fixture', model: body.model } },
      { type: 'response.output_item.added', output_index: 0, item: { ...receipt, action: undefined } },
      { type: 'response.output_item.done', output_index: 0, item: receipt },
      { type: 'response.output_text.delta', item_id: 'text', delta: 'The [IANA page](https://www.iana.org/domains/reserved) explains the reservation.' },
      { type: 'response.content_part.done', item_id: 'text', content_index: 0 },
      { type: 'response.completed', response: { output: [receipt], usage: { input_tokens: 20, output_tokens: 13 } } },
    ];
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  }));
  const manager = new AccountManager([{
    name: 'Codex test', type: 'oauth', provider: 'codex', codexAuth: 'native',
    accessToken: 'test-access', codexAccountId: 'test-workspace', upstream,
    codexModels: [{ slug: 'gpt-6.2-sol' }],
  }]);
  const proxy = await listen(t, createProxyServer(manager, { proxy: { apiKey: 'test-token' }, queue: { enabled: false } }));
  const post = (body) => fetch(proxy + '/v1/messages?beta=true', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-token',
      'x-maxpool-provider': 'codex', 'x-maxpool-profile': 'all' },
    body: JSON.stringify(body) });
  const streaming = await post({ ...searchRequest, stream: true });
  assert.equal(streaming.status, 200);
  const events = (await streaming.text()).split('\n').filter(line => line.startsWith('data: '))
    .map(line => JSON.parse(line.slice(6)));
  assert.deepEqual(events.filter(event => event.type === 'content_block_start').map(event => event.content_block.type),
    ['server_tool_use', 'web_search_tool_result', 'text']);
  assert.equal(events.filter(event => event.type === 'content_block_stop').length, 3);
  assert.equal(events.find(event => event.type === 'message_delta').delta.stop_reason, 'end_turn');

  const buffered = await post({ ...searchRequest, stream: false });
  assert.equal(buffered.status, 200);
  const message = await buffered.json();
  assert.deepEqual(message.content[0], { type: 'server_tool_use', id: 'ws_source', name: 'web_search',
    input: { query: 'IANA reserved example domains' } });
  assert.deepEqual(message.content[1], { type: 'web_search_tool_result', tool_use_id: 'ws_source', content: [
    { type: 'web_search_result', url: 'https://www.iana.org/domains/reserved', title: 'IANA-managed Reserved Domains', page_age: null },
  ] });
  assert.match(message.content[2].text, /https:\/\/www\.iana\.org\/domains\/reserved/);
  assert.equal(message.usage.output_tokens, 13);
  assert.equal(requests[0].tools[0].type, 'web_search');

  const blocked = await post({ ...searchRequest, tools: [{ ...searchRequest.tools[0], blocked_domains: ['example.com'] }] });
  assert.equal(blocked.status, 400);
  assert.match((await blocked.json()).error.message, /blocked_domains/);
  assert.equal(requests.length, 2, 'unsupported domain restrictions must not trigger an unfiltered search');

  const hostedFetch = await post({ ...searchRequest, tools: [{ type: 'web_fetch_20260318', name: 'web_fetch' }] });
  assert.equal(hostedFetch.status, 400);
  assert.match((await hostedFetch.json()).error.message, /Anthropic-hosted web_fetch/);
  assert.equal(requests.length, 2);
});
