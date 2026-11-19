/* global Headers, Response */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { foreignToolBlockText } from './provider-thinking-scrub.js';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const scope = 'claude_code';
const blocks = value => Array.isArray(value) ? value : [{ type: 'text', text: value ?? '' }];
const omitted = new Set(['thinking', 'redacted_thinking', 'cache_creation']);
const explicitEfforts = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const searchVersions = new Set(['web_search_20250305', 'web_search_20260209', 'web_search_20260318']);

export class UnsupportedOpenAIRequest extends Error {}

function hostedWebSearch(tools) {
  if (tools.some(tool => /^web_fetch_\d{8}$/.test(tool?.type))) {
    throw new UnsupportedOpenAIRequest('Anthropic-hosted web_fetch requires an Anthropic account. Claude Code WebFetch works on the Codex route.');
  }
  const searches = tools.filter(tool => searchVersions.has(tool?.type));
  if (searches.length > 1) {
    throw new UnsupportedOpenAIRequest('The Codex route accepts one hosted web_search definition per request.');
  }
  const search = searches[0];
  if (!search) return null;
  if (search.blocked_domains?.length) {
    throw new UnsupportedOpenAIRequest('Codex hosted web search does not support blocked_domains. Use allowed_domains to restrict sources.');
  }
  const tool = { type: 'web_search', external_web_access: true };
  if (search.allowed_domains?.length) tool.filters = { allowed_domains: search.allowed_domains };
  if (search.user_location) tool.user_location = search.user_location;
  return { tool, name: search.name || 'web_search', maxUses: search.max_uses };
}

function wireName(name) {
  if (/^[a-zA-Z0-9_-]{1,64}$/.test(name) && !name.startsWith('maxpool_tool_')) return name;
  return 'maxpool_tool_' + createHash('sha256').update(String(name)).digest('hex').slice(0, 40);
}

function wireCallId(id) {
  if (typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)) return id;
  return 'call_' + createHash('sha256').update(String(id)).digest('hex').slice(0, 40);
}

function inputPart(block) {
  if (block.type === 'text') return { type: 'input_text', text: block.text };
  if (block.type === 'tool_reference') return { type: 'input_text', text: `Tool loaded: ${block.tool_name}` };
  if (block.type === 'image') {
    const source = block.source;
    const image_url = source?.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source?.url;
    if (image_url) return { type: 'input_image', image_url, detail: 'auto' };
  }
  return { type: 'input_text', text: JSON.stringify(block) };
}

/**
 * Keep the Claude Code transcript as the source of truth. Replay ordinary tool
 * calls and outputs as matching Responses items. Provider-owned state can travel
 * as visible context, and opaque thinking is kept out of the request.
 */
export function toOpenAIRequest(json, model, { native = false } = {}) {
  const toolNames = new Map();
  const functionScope = native ? {} : { namespace: scope };
  const webSearch = hostedWebSearch(json.tools || []);
  const tools = (json.tools || []).filter(tool => tool.input_schema && typeof tool.name === 'string').map(tool => {
    const name = wireName(tool.name);
    toolNames.set(name, tool.name);
    return { type: 'function', name, description: tool.description || '', parameters: tool.input_schema, strict: false };
  });
  const input = [];
  let instructions = blocks(json.system).filter(b => b.type === 'text' && !String(b.text).startsWith('x-anthropic-billing-header:'))
    .map(b => b.text).filter(Boolean).join('\n\n');
  for (const message of json.messages || []) {
    let content = [];
    const flush = () => {
      if (content.length) {
        const role = message.role === 'system' ? 'developer' : message.role;
        input.push({ role, content });
      }
      content = [];
    };
    if (message.role === 'system' && typeof message.output_config?.directives === 'string' && message.output_config.directives) {
      content.push({ type: 'input_text', text: message.output_config.directives });
    }
    for (const block of blocks(message.content)) {
      if (!block || omitted.has(block.type)) continue;
      if (block.type === 'tool_use' && block.id && block.name) {
        flush();
        input.push({ type: 'function_call', call_id: wireCallId(block.id), ...functionScope,
          name: wireName(block.name), arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        flush();
        const result = blocks(block.content).filter(b => b && !omitted.has(b.type)).map(inputPart);
        if (block.is_error) result.unshift({ type: 'input_text', text: 'Tool execution failed.' });
        input.push({ type: 'function_call_output', call_id: wireCallId(block.tool_use_id),
          output: result.length ? result : '' });
      } else if (message.role === 'assistant') {
        const webSearchReceipt = block.type === 'web_search_tool_result'
          || (block.type === 'server_tool_use' && block.name === 'web_search');
        const part = block.type === 'text' ? block.text
          : webSearchReceipt ? foreignToolBlockText(block) : JSON.stringify(block);
        if (part) content.push({ type: 'output_text', text: part, annotations: [] });
      } else {
        const part = inputPart(block);
        if (part.type !== 'input_text' || part.text) content.push(part);
      }
    }
    flush();
  }
  const body = { model, input, store: false, stream: true };
  // Native Codex uses flat function declarations, as in CLIProxyAPI's translator.
  if (tools.length || webSearch) {
    body.tools = tools.length && !native ? [{ type: 'namespace', name: scope, description: 'Tools executed by Claude Code.', tools }] : tools;
    if (webSearch) body.tools.push(webSearch.tool);
  }
  if (webSearch) {
    body.include = ['web_search_call.action.sources'];
    if (Number.isSafeInteger(webSearch.maxUses) && webSearch.maxUses > 0) {
      // The subscription endpoint rejects max_tool_calls. Carry the caller's
      // budget as guidance, the same way Claude Code asks its helper to search once.
      if (native) instructions = [instructions, `Use web search at most ${webSearch.maxUses} times.`].filter(Boolean).join('\n\n');
      else body.max_tool_calls = webSearch.maxUses;
    }
  }
  if (instructions || native) body.instructions = instructions || 'You are a helpful coding assistant.';
  const effort = json.output_config?.effort;
  if (explicitEfforts.has(effort)) body.reasoning = { effort };
  if (body.tools && json.tool_choice?.type === 'none') body.tool_choice = 'none';
  if (body.tools && json.tool_choice?.type === 'any') body.tool_choice = 'required';
  if (json.tool_choice?.type === 'tool') {
    const name = wireName(json.tool_choice.name);
    if (toolNames.has(name)) body.tool_choice = { type: 'function', ...functionScope, name };
    else if (webSearch?.name === json.tool_choice.name) body.tool_choice = { type: 'web_search' };
  }
  if (json.tool_choice?.disable_parallel_tool_use) body.parallel_tool_calls = false;
  return { body, toolNames, webSearch: webSearch?.name };
}

async function* readEvents(body) {
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(pending))) {
      const frame = pending.slice(0, boundary.index);
      pending = pending.slice(boundary.index + boundary[0].length);
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (data && data !== '[DONE]') yield JSON.parse(data);
    }
    if (pending.length > 16 * 1024 * 1024) throw new Error('OpenAI event exceeds size limit');
  }
}

function usageOf(response) {
  const usage = response?.usage || {};
  const input = usage.input_tokens || 0;
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  const created = Math.min(Math.max(0, input - cached), usage.input_tokens_details?.cache_write_tokens || 0);
  return { input_tokens: Math.max(0, input - cached - created),
    cache_read_input_tokens: cached, cache_creation_input_tokens: created, output_tokens: usage.output_tokens || 0 };
}

function failureStatus(error) {
  const code = error?.code || error?.type || '';
  if (/rate_limit|usage_limit|insufficient_quota/.test(code)) return 429;
  if (/invalid_api_key|invalid_token|invalid_user|authentication/.test(code)) return 401;
  if (/usage_unavailable|user_unavailable/.test(code)) return 503;
  if (/access_denied|permission|not_eligible|scope_not_authorized/.test(code)) return 403;
  if (/invalid_request|context_length|model_not_found|unsupported_capability/.test(code)) return 400;
  return 502;
}

function errorEvent(status, error) {
  const type = { 400: 'invalid_request_error', 401: 'authentication_error', 403: 'permission_error', 429: 'rate_limit_error' }[status] || 'api_error';
  return { type: 'error', error: { type, message: error?.message || 'OpenAI did not complete the response.' } };
}

function normalizedHeaders(original) {
  const headers = new Headers(original);
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding', 'set-cookie', 'x-codex-turn-state']) {
    headers.delete(name);
  }
  return headers;
}

function jsonResponse(body, status, headers) {
  headers.set('content-type', 'application/json');
  return new Response(JSON.stringify(body), { status, headers });
}

/**
 * Translate an HTTP Responses stream back to Anthropic Messages. Wait for a
 * meaningful event before releasing the response to the existing retry layer,
 * so early structured quota failures can take the same failover path as HTTP 429.
 */
export async function fromOpenAIResponse(response, { model, stream, toolNames, webSearch, upstreamModel }) {
  const headers = normalizedHeaders(response.headers);
  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error;
    if (typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)) {
      headers.set('x-maxpool-openai-error-code', error.code);
    }
    return jsonResponse(errorEvent(response.status, error), response.status, headers);
  }
  // The ChatGPT plan endpoint can return SSE with no Content-Type header.
  // In that case the required Responses events verify the stream format.
  const contentType = response.headers.get('content-type');
  if (!response.body || (contentType && !contentType.includes('text/event-stream'))) {
    await response.body?.cancel();
    return jsonResponse(errorEvent(502), 502, headers);
  }
  const events = readEvents(response.body);
  let id;
  let servedModel;
  let first;
  for (;;) {
    const next = await events.next();
    if (next.done) return jsonResponse(errorEvent(502), 502, headers);
    first = next.value;
    id ||= first.response?.id;
    servedModel ||= first.response?.model;
    if (first.type === 'error' || first.type === 'response.failed') {
      await events.return();
      const error = first.response?.error || first;
      const status = failureStatus(error);
      if (typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)) {
        headers.set('x-maxpool-openai-error-code', error.code);
      }
      return jsonResponse(errorEvent(status, error), status, headers);
    }
    if (first.type === 'response.output_item.added' && first.item?.type === 'function_call') break;
    if (webSearch && first.type === 'response.output_item.done' && first.item?.type === 'web_search_call') break;
    if (first.type === 'response.output_text.delta' || first.type === 'response.refusal.delta'
      || first.type === 'response.completed' || first.type === 'response.incomplete') break;
  }
  const actualModel = servedModel || upstreamModel;
  const tagged = typeof actualModel === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(actualModel);
  const upstreamId = String(id || 'openai').replace(/^resp_/, '');
  const messageId = tagged ? 'msg_maxpool_codex_' + Buffer.from(actualModel).toString('hex') + '_' + upstreamId : 'msg_' + upstreamId;
  const message = { id: messageId, type: 'message',
    role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usageOf() };
  if (tagged) headers.set('x-maxpool-served-model', actualModel);
  const converted = convertEvents(events, first, message, toolNames, webSearch);
  if (stream) {
    headers.set('content-type', 'text/event-stream');
    return new Response(Readable.toWeb(Readable.from(encodeEvents(converted))), { headers });
  }
  for await (const event of converted) {
    if (event.type === 'error') return jsonResponse(event, 502, headers);
  }
  return jsonResponse(message, 200, headers);
}

async function* encodeEvents(events) {
  for await (const event of events) {
    yield Buffer.from(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
}

async function* withFirst(first, events) {
  try {
    yield first;
    yield* events;
  } finally {
    await events.return();
  }
}

function webSearchSources(sources) {
  const seen = new Set();
  const results = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    let url;
    try { url = new URL(source?.url); } catch { continue; }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || seen.has(url.href)) continue;
    seen.add(url.href);
    const title = typeof source.title === 'string' && source.title.trim() ? source.title : url.href;
    results.push({ type: 'web_search_result', url: url.href, title, page_age: null });
  }
  return results;
}

// CLIProxyAPI's Codex→Claude adapter uses a server tool use followed by a
// search result block. Only provider-supplied URLs can appear in the result.
function* appendWebSearch(message, item, name, seen, outputIndex) {
  if (!name || item?.type !== 'web_search_call') return;
  const action = item.action;
  if (action?.type !== 'search' && item.status !== 'failed') return;
  const id = wireCallId(item.id || `${message.id}_search_${outputIndex}`);
  if (seen.has(id)) return;
  seen.add(id);
  const query = action?.query || action?.queries?.[0];
  const input = typeof query === 'string' ? { query } : {};
  const useIndex = message.content.length;
  message.content.push({ type: 'server_tool_use', id, name, input });
  yield { type: 'content_block_start', index: useIndex, content_block: { type: 'server_tool_use', id, name, input: {} } };
  yield { type: 'content_block_delta', index: useIndex,
    delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } };
  yield { type: 'content_block_stop', index: useIndex };
  const resultIndex = message.content.length;
  const content = item.status === 'failed' ? { type: 'web_search_tool_result_error', error_code: 'unavailable' }
    : webSearchSources(action?.sources ?? item.results);
  const result = { type: 'web_search_tool_result', tool_use_id: id, content };
  message.content.push(result);
  yield { type: 'content_block_start', index: resultIndex, content_block: result };
  yield { type: 'content_block_stop', index: resultIndex };
}

async function* convertEvents(events, first, message, toolNames, webSearch) {
  const items = new Map();
  const finished = new Set();
  const searches = new Set();
  let usedTool = false;
  yield { type: 'message_start', message: { ...message, content: [] } };
  try {
    for await (const event of withFirst(first, events)) {
      const { item, item_id, output_index } = event;
      if (event.type === 'response.output_item.added' && item?.type === 'function_call') {
        const name = toolNames.get(item.name);
        if (!name) {
          yield errorEvent(502, { message: 'OpenAI requested a tool that was not declared by Claude Code.' });
          return;
        }
        const index = message.content.length;
        const block = { type: 'tool_use', id: item.call_id, name, input: {} };
        message.content.push(block);
        items.set(item.id || output_index, { index, arguments: '' });
        usedTool = true;
        yield { type: 'content_block_start', index, content_block: { ...block } };
      } else if (event.type === 'response.function_call_arguments.delta') {
        const tool = items.get(item_id || output_index);
        if (!tool) continue;
        tool.arguments += event.delta;
        yield { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: event.delta } };
      } else if (event.type === 'response.output_item.done' && item?.type === 'web_search_call') {
        for (const block of appendWebSearch(message, item, webSearch, searches, output_index)) {
          if (block.type === 'content_block_stop') finished.add(block.index);
          yield block;
        }
      } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
        const key = `text:${item_id || output_index}:${event.content_index || 0}`;
        if (!items.has(key)) {
          const index = message.content.length;
          const block = { type: 'text', text: '' };
          message.content.push(block);
          items.set(key, { index });
          yield { type: 'content_block_start', index, content_block: { ...block } };
        }
        const { index } = items.get(key);
        message.content[index].text += event.delta;
        yield { type: 'content_block_delta', index, delta: { type: 'text_delta', text: event.delta } };
      } else if (event.type === 'response.content_part.done') {
        const text = items.get(`text:${item_id || output_index}:${event.content_index || 0}`);
        if (!text || finished.has(text.index)) continue;
        finished.add(text.index);
        yield { type: 'content_block_stop', index: text.index };
      } else if (event.type === 'response.output_item.done' && item?.type === 'function_call') {
        const tool = items.get(item.id || output_index);
        if (!tool) continue;
        const args = tool.arguments || item.arguments || '{}';
        if (!tool.arguments) yield { type: 'content_block_delta', index: tool.index, delta: { type: 'input_json_delta', partial_json: args } };
        message.content[tool.index].input = JSON.parse(args);
        finished.add(tool.index);
        yield { type: 'content_block_stop', index: tool.index };
      } else if (event.type === 'error' || event.type === 'response.failed') {
        const error = event.response?.error || event;
        yield errorEvent(failureStatus(error), error);
        return;
      } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        for (let index = 0; index < message.content.length; index++) {
          if (!finished.has(index)) yield { type: 'content_block_stop', index };
        }
        for (const [index, item] of (event.response?.output || []).entries()) {
          yield* appendWebSearch(message, item, webSearch, searches, index);
        }
        message.usage = usageOf(event.response);
        message.stop_reason = event.type === 'response.incomplete' ? 'max_tokens' : usedTool ? 'tool_use' : 'end_turn';
        yield { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: message.usage };
        yield { type: 'message_stop' };
        return;
      }
    }
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    yield errorEvent(502);
    return;
  }
  yield errorEvent(502);
}
