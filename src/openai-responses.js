/* global Headers, Response */
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

export const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

const scope = 'claude_code';
const blocks = value => Array.isArray(value) ? value : [{ type: 'text', text: value ?? '' }];
const omitted = new Set(['thinking', 'redacted_thinking', 'cache_creation']);

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
export function toOpenAIRequest(json, model) {
  const toolNames = new Map();
  const tools = (json.tools || []).filter(tool => tool.input_schema && typeof tool.name === 'string').map(tool => {
    const name = wireName(tool.name);
    toolNames.set(name, tool.name);
    return { type: 'function', name, description: tool.description || '', parameters: tool.input_schema, strict: false };
  });
  const input = [];
  if (tools.length) input.push({ type: 'additional_tools', tools: [{ type: 'namespace', name: scope, description: 'Tools executed by Claude Code.', tools }] });
  const instructions = blocks(json.system).filter(b => b.type === 'text' && !String(b.text).startsWith('x-anthropic-billing-header:'))
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
    for (const block of blocks(message.content)) {
      if (!block || omitted.has(block.type)) continue;
      if (block.type === 'tool_use' && block.id && block.name) {
        flush();
        input.push({ type: 'function_call', call_id: wireCallId(block.id), namespace: scope,
          name: wireName(block.name), arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === 'tool_result' && block.tool_use_id) {
        flush();
        const result = blocks(block.content).filter(b => b && !omitted.has(b.type)).map(inputPart);
        if (block.is_error) result.unshift({ type: 'input_text', text: 'Tool execution failed.' });
        input.push({ type: 'function_call_output', call_id: wireCallId(block.tool_use_id),
          output: result.length ? result : '' });
      } else if (message.role === 'assistant') {
        const part = block.type === 'text' ? block.text : JSON.stringify(block);
        if (part) content.push({ type: 'output_text', text: part, annotations: [] });
      } else {
        const part = inputPart(block);
        if (part.type !== 'input_text' || part.text) content.push(part);
      }
    }
    flush();
  }
  const body = { model, input, store: false, stream: true };
  if (instructions) body.instructions = instructions;
  if (tools.length && json.tool_choice?.type === 'none') body.tool_choice = 'none';
  if (tools.length && json.tool_choice?.type === 'any') body.tool_choice = 'required';
  if (json.tool_choice?.type === 'tool' && toolNames.has(wireName(json.tool_choice.name))) body.tool_choice = {
    type: 'function', namespace: scope, name: wireName(json.tool_choice.name),
  };
  if (json.tool_choice?.disable_parallel_tool_use) body.parallel_tool_calls = false;
  return { body, toolNames };
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
  const cached = usage.input_tokens_details?.cached_tokens || 0;
  return { input_tokens: Math.max(0, (usage.input_tokens || 0) - cached),
    cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: usage.output_tokens || 0 };
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
  for (const name of ['content-length', 'content-encoding', 'transfer-encoding']) headers.delete(name);
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
export async function fromOpenAIResponse(response, { model, stream, toolNames }) {
  const headers = normalizedHeaders(response.headers);
  if (!response.ok) {
    const error = (await response.json().catch(() => null))?.error;
    return jsonResponse(errorEvent(response.status, error), response.status, headers);
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    await response.body?.cancel();
    return jsonResponse(errorEvent(502), 502, headers);
  }
  const events = readEvents(response.body);
  let id;
  let first;
  for (;;) {
    const next = await events.next();
    if (next.done) return jsonResponse(errorEvent(502), 502, headers);
    first = next.value;
    id ||= first.response?.id;
    if (first.type === 'error' || first.type === 'response.failed') {
      await events.return();
      const error = first.response?.error || first;
      const status = failureStatus(error);
      return jsonResponse(errorEvent(status, error), status, headers);
    }
    if (first.type === 'response.output_item.added' && first.item?.type === 'function_call') break;
    if (first.type === 'response.output_text.delta' || first.type === 'response.refusal.delta'
      || first.type === 'response.completed' || first.type === 'response.incomplete') break;
  }
  const message = { id: 'msg_' + String(id || 'openai').replace(/^resp_/, ''), type: 'message',
    role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usageOf() };
  const converted = convertEvents(events, first, message, toolNames);
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

async function* convertEvents(events, first, message, toolNames) {
  const items = new Map();
  const finished = new Set();
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
