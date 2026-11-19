/* global Response */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { fetchBoundedOpenAIResponse, fromOpenAIResponse, toOpenAIRequest } from '../src/openai-responses.js';

const searchRequest = {
  model: 'claude-sonnet-5-5',
  system: 'You run a web search for another Claude model. Search once, then reply with a brief summary of the results.',
  messages: [{ role: 'user', content: 'Perform a web search for the query: IANA reserved example domains' }],
  tools: [{ type: 'web_search_20250305', name: 'web_search' }],
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
  assert.equal(native.body.max_tool_calls, undefined);
  assert.equal(native.webSearch, 'docs_search');
  const capped = { ...request, tools: [{ ...search, max_uses: 1 }] };
  assert.equal(toOpenAIRequest(capped, 'gpt-6.2-sol').body.max_tool_calls, 1);
  const bounded = toOpenAIRequest(capped, 'gpt-6.2-sol', { native: true });
  assert.equal(bounded.body.tools[0].type, 'function');
  assert.equal(bounded.boundedSearch.maxUses, 1);
  assert.equal(bounded.boundedSearch.directQuery, 'IANA reserved example domains');
  assert.deepEqual(bounded.boundedSearch.settings.filters, { allowed_domains: ['iana.org'] });

  const extended = { ...request, tools: [{ ...search, max_uses: 100 }] };
  for (const [priorSearches, maximum] of [[0, 32], [90, 10], [100, 0]]) {
    assert.equal(toOpenAIRequest(extended, 'gpt-6.2-sol', { native: true, priorSearches }).boundedSearch.maxUses, maximum);
  }

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

  const hostedFetch = await post({ ...searchRequest, tools: [{ type: 'web_fetch_20260318', name: 'web_fetch' }] });
  assert.equal(hostedFetch.status, 400);
  assert.match((await hostedFetch.json()).error.message, /Anthropic-hosted web_fetch/);
  assert.equal(requests.length, 2);
});

test('native standalone search enforces the request cap and domain exclusions', async t => {
  const searches = [];
  const modelCalls = [];
  let searchAvailable = true;
  const upstream = await listen(t, createServer(async (request, response) => {
    let data = '';
    for await (const chunk of request) data += chunk;
    const body = JSON.parse(data);
    if (request.url === '/alpha/search') {
      searches.push(body);
      response.writeHead(searchAvailable ? 200 : 404, { 'content-type': 'application/json' });
      return response.end(JSON.stringify({ output: 'Reserved examples', results: [
        { url: 'https://www.rfc-editor.org/info/rfc6761/', title: 'RFC 6761' },
      ] }));
    }
    modelCalls.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const events = [{ type: 'response.created', response: { id: 'resp_bounded_fixture', model: body.model } }];
    const searchTool = body.tools?.find(tool => tool.name === 'maxpool_tool_hosted_web_search');
    if (searchTool) {
      for (const [index, query] of ['reserved domains', 'second search'].entries()) {
        events.push({ type: 'response.output_item.done', output_index: index, item: {
          id: 'fc_' + index, type: 'function_call', name: searchTool.name, call_id: 'call_' + index,
          arguments: JSON.stringify({ query }),
        } });
      }
    } else {
      events.push({ type: 'response.output_text.delta', item_id: 'final', delta: 'See [RFC 6761](https://www.rfc-editor.org/info/rfc6761/).' });
    }
    events.push({ type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 13 } } });
    response.end(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  }));
  const manager = new AccountManager([{
    name: 'Codex test', type: 'oauth', provider: 'codex', codexAuth: 'native',
    accessToken: 'test-access', codexAccountId: 'test-workspace', upstream: upstream + '/responses',
    codexModels: [{ slug: 'gpt-6.2-sol' }],
  }]);
  const proxy = await listen(t, createProxyServer(manager, { proxy: { apiKey: 'test-token' },
    queue: { enabled: false }, retry: { maxAttempts: 1 } }));
  const post = (overrides) => fetch(proxy + '/v1/messages?beta=true', { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-token',
      'x-maxpool-provider': 'codex', 'x-maxpool-profile': 'all' },
    body: JSON.stringify({ ...searchRequest, tools: [{ ...searchRequest.tools[0], max_uses: 1, blocked_domains: ['iana.org'] }],
      stream: false, ...overrides }) });

  const direct = await post({});
  assert.equal(direct.status, 200);
  assert.deepEqual(searches.map(search => search.commands), [{ search_query: [{ q: 'IANA reserved example domains' }] }]);
  assert.deepEqual(searches[0].settings.filters, { blocked_domains: ['iana.org'] });
  assert.equal(modelCalls.length, 1, 'Claude Code supplies the query and needs only the summarization request');
  assert.equal(modelCalls[0].tools, undefined);
  assert.match((await direct.json()).content[1].content[0].url, /rfc-editor.org/);

  const generic = await post({ system: 'Search for the requested facts.' });
  assert.equal(generic.status, 200);
  const message = await generic.json();
  assert.equal(searches.length, 2, 'only one search may execute per request');
  assert.deepEqual(searches[1].commands, { search_query: [{ q: 'reserved domains' }] });
  assert.equal(message.content[3].content.error_code, 'max_uses_exceeded');
  assert.equal(modelCalls[2].tools, undefined);
  assert.match(message.content.at(-1).text, /RFC 6761/);
  assert.equal(message.stop_reason, 'end_turn');
  assert.equal(message.usage.output_tokens, 26, 'account usage includes model work to plan the search');

  const continued = await post({ system: 'Continue after the client tool.', messages: [
    ...searchRequest.messages,
    { role: 'assistant', content: [message.content[0], message.content[1], {
      id: 'toolu_fixture', type: 'tool_use', name: 'Read', input: { file_path: 'fixture' },
    }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_fixture', content: 'Fixture read result' }] },
  ] });
  assert.equal(continued.status, 200);
  assert.equal(searches.length, 2, 'earlier searches in the same turn count after an ordinary tool result');
  assert.equal((await continued.json()).content[1].content.error_code, 'max_uses_exceeded');

  searchAvailable = false;
  const unavailable = await post({});
  assert.ok(unavailable.status >= 400);
  assert.match((await unavailable.json()).error.message, /standalone web search is unavailable/);
  assert.equal(searches.length, 3, 'a failed standalone search must not fall back to an unfiltered search');
});

test('a blocked-domain search without max_uses stops even when the model keeps asking', async () => {
  const request = toOpenAIRequest({
    ...searchRequest, system: 'Search for the requested facts.',
    tools: [{ ...searchRequest.tools[0], blocked_domains: ['iana.org'] }],
  }, 'gpt-6.2-sol', { native: true });
  let searchCalls = 0;
  let planningRounds = 0;
  const bounded = await fetchBoundedOpenAIResponse(request, {
    budget: { used: 0, results: new Map() },
    async fetchSearch({ settings }) {
      searchCalls++;
      assert.deepEqual(settings.filters, { blocked_domains: ['iana.org'] });
      return Response.json({ output: 'Example result', results: [] });
    },
    async fetchResponses(body) {
      const tool = body.tools?.find(tool => tool.name === 'maxpool_tool_hosted_web_search');
      const events = [{ type: 'response.created', response: { id: 'resp_safety_fixture', model: body.model } }];
      if (tool) {
        planningRounds++;
        assert.ok(planningRounds <= 32, 'the model kept receiving the search tool after the safety cap');
        const queries = planningRounds === 32 ? 2 : 1;
        for (let index = 0; index < queries; index++) {
          const id = `${planningRounds}_${index}`;
          events.push({ type: 'response.output_item.done', output_index: index, item: {
            type: 'function_call', id: 'fc_' + id, name: tool.name, call_id: 'call_' + id,
            arguments: JSON.stringify({ query: 'reserved domains ' + id }),
          } });
        }
      } else {
        events.push({ type: 'response.output_text.delta', item_id: 'final', delta: 'Summary of available results.' });
      }
      events.push({ type: 'response.completed', response: {} });
      return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });
  const response = await fromOpenAIResponse(bounded, { ...request, model: searchRequest.model, stream: false });
  const message = await response.json();
  assert.equal(searchCalls, 32);
  assert.equal(planningRounds, 32);
  assert.equal(message.content.find(block => block.content?.error_code)?.content.error_code, 'max_uses_exceeded');
  assert.equal(message.content.at(-1).text, 'Summary of available results.');
  assert.equal(message.stop_reason, 'end_turn');
});
