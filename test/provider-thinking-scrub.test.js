import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderThinkingScrubber, scrubProviderResponseBody, scrubEnabledFor } from '../src/provider-thinking-scrub.js';

const ev = j => `event: ${j.type}\ndata: ${JSON.stringify(j)}`;
const stream = events => events.map(ev).join('\n\n') + '\n\n';
const parse = out => out.split('\n\n').map(e => /^data: (.*)$/m.exec(e)).filter(Boolean).map(m => JSON.parse(m[1]));

// The PUSH-based reducer the red team found on CC's SDK paths: blocks pushed on start,
// deltas applied via content.at(index). If renumbering is wrong, text lands on the wrong
// block (or a tool_use) — the silent-corruption class this test exists for.
function pushReducer(events) {
  const content = [];
  for (const j of events) {
    if (j.type === 'content_block_start') content.push({ ...j.content_block });
    if (j.type === 'content_block_delta') {
      const b = content.at(j.index);
      if (j.delta.type === 'text_delta') b.text = (b.text || '') + j.delta.text;
      if (j.delta.type === 'input_json_delta') b.json = (b.json || '') + j.delta.partial_json;
    }
  }
  return content;
}

const thinking = i => [
  { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: 'glm internal' } },
  { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'glmsig' } },
  { type: 'content_block_stop', index: i },
];
const text = (i, s) => [
  { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: s } },
  { type: 'content_block_stop', index: i },
];
const toolUse = (i, id) => [
  { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id, name: 'lookup', input: {} } },
  { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: '{"name":"a"}' } },
  { type: 'content_block_stop', index: i },
];
const head = [{ type: 'message_start', message: { id: 'msg_1', model: 'glm-5.3', content: [] } }];
const tail = [{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 9 } }, { type: 'message_stop' }];

test('thinking FIRST: dropped, later blocks renumbered contiguously, push-reducer sees correct text', () => {
  const s = new ProviderThinkingScrubber();
  const out = parse(s.push(stream([...head, ...thinking(0), ...text(1, 'Hello'), ...toolUse(2, 'toolu_a'), ...tail])) + s.flush());
  const starts = out.filter(j => j.type === 'content_block_start');
  assert.deepEqual(starts.map(j => j.index), [0, 1]);
  assert.deepEqual(pushReducer(out).map(b => b.type), ['text', 'tool_use']);
  assert.equal(pushReducer(out)[0].text, 'Hello');
  assert.equal(pushReducer(out)[1].json, '{"name":"a"}');
  assert.ok(!out.some(j => j.delta?.type === 'thinking_delta' || j.delta?.type === 'signature_delta'));
  assert.equal(s.scrubbedCount, 1);
});

test('thinking in the MIDDLE: earlier block untouched, later blocks shift down by one', () => {
  const s = new ProviderThinkingScrubber();
  const out = parse(s.push(stream([...head, ...text(0, 'A'), ...thinking(1), ...toolUse(2, 'toolu_b'), ...tail])));
  assert.deepEqual(out.filter(j => j.type === 'content_block_start').map(j => j.index), [0, 1]);
  assert.deepEqual(out.filter(j => j.type === 'content_block_stop').map(j => j.index), [0, 1]);
  const r = pushReducer(out);
  assert.equal(r[0].text, 'A');
  assert.equal(r[1].json, '{"name":"a"}');
});

test('two thinking blocks interleaved: indexes contiguous, every stop present', () => {
  const s = new ProviderThinkingScrubber();
  const out = parse(s.push(stream([...head, ...thinking(0), ...text(1, 'X'), ...thinking(2), ...text(3, 'Y'), ...tail])));
  assert.deepEqual(out.filter(j => j.type === 'content_block_start').map(j => j.index), [0, 1]);
  assert.deepEqual(out.filter(j => j.type === 'content_block_stop').map(j => j.index), [0, 1]);
  assert.deepEqual(pushReducer(out).map(b => b.text), ['X', 'Y']);
});

test('thinking-only turn: a placeholder text block is synthesized (never content:[])', () => {
  const s = new ProviderThinkingScrubber();
  const out = parse(s.push(stream([...head, ...thinking(0), { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} }, { type: 'message_stop' }])));
  const r = pushReducer(out);
  assert.equal(r.length, 1);
  assert.equal(r[0].type, 'text');
  assert.equal(r[0].text, '(reasoning omitted)');
  // placeholder lands BEFORE message_delta so stop_reason/usage still close the message
  const types = out.map(j => j.type);
  assert.ok(types.indexOf('content_block_stop') < types.indexOf('message_delta'));
});

test('events split across arbitrary chunk boundaries produce identical output', () => {
  const full = stream([...head, ...thinking(0), ...text(1, 'Hello'), ...toolUse(2, 'toolu_c'), ...tail]);
  const whole = new ProviderThinkingScrubber();
  const a = whole.push(full) + whole.flush();
  for (const size of [1, 7, 33, 128]) {
    const s = new ProviderThinkingScrubber();
    let b = '';
    for (let i = 0; i < full.length; i += size) b += s.push(full.slice(i, i + size));
    b += s.flush();
    assert.equal(b, a, `chunk size ${size}`);
  }
});

test('no thinking in stream: bytes pass through unchanged', () => {
  const s = new ProviderThinkingScrubber();
  const full = stream([...head, ...text(0, 'plain'), ...toolUse(1, 'toolu_d'), ...tail]);
  assert.equal(s.push(full) + s.flush(), full);
});

test('unknown block type is dropped (and renumbers like thinking); redacted_thinking dropped', () => {
  const s = new ProviderThinkingScrubber();
  const out = parse(s.push(stream([...head,
    { type: 'content_block_start', index: 0, content_block: { type: 'mystery_v2' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'x' } },
    { type: 'content_block_stop', index: 1 },
    ...text(2, 'kept'), ...tail])));
  assert.deepEqual(out.filter(j => j.type === 'content_block_start').map(j => [j.index, j.content_block.type]), [[0, 'text']]);
  assert.equal(pushReducer(out)[0].text, 'kept');
});

test('ping / non-data frames and malformed JSON pass through verbatim', () => {
  const s = new ProviderThinkingScrubber();
  const raw = 'event: ping\ndata: {"type": "ping"}\n\n: comment line\n\ndata: {not json\n\n';
  assert.equal(s.push(raw), raw);
});

test('buffered lane: thinking + redacted + unknown removed; text and tool_use kept in order', () => {
  const body = { id: 'm', content: [
    { type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'A' },
    { type: 'redacted_thinking', data: 'r' }, { type: 'tool_use', id: 't', name: 'n', input: {} },
    { type: 'mystery', x: 1 }] };
  const out = scrubProviderResponseBody(body);
  assert.deepEqual(out.content.map(b => b.type), ['text', 'tool_use']);
  assert.equal(body.content.length, 5, 'input not mutated');
});

test('buffered lane: thinking-only body gets the placeholder; clean body returns null (forward original)', () => {
  assert.deepEqual(scrubProviderResponseBody({ content: [{ type: 'thinking', thinking: 'x' }] }).content, [{ type: 'text', text: '(reasoning omitted)' }]);
  assert.equal(scrubProviderResponseBody({ content: [{ type: 'text', text: 'ok' }] }), null);
  assert.equal(scrubProviderResponseBody({ type: 'error' }), null);
});

test('gate: OFF by default, ON only for provider accounts (Claude thinking is never scrubbed)', () => {
  assert.equal(scrubEnabledFor({ type: 'provider' }, {}), false);
  assert.equal(scrubEnabledFor({ type: 'provider' }, { providerThinkingScrub: true }), true);
  assert.equal(scrubEnabledFor({ type: 'oauth' }, { providerThinkingScrub: true }), false);
});

// ── WIRING: streamResponse with a live scrubber (the exact call shape the proxy uses).
// Same harness style as model-echo-normalization.test.js — a helper alone is inert.
import { ReadableStream } from 'node:stream/web';
import { __serverTest } from '../src/server.js';
const { streamResponse } = __serverTest;

function mockRes(chunks) {
  chunks.join = () => Buffer.concat(chunks.slice()).toString('utf8');
  const listeners = {};
  return {
    headersSent: false, destroyed: false, writableEnded: false,
    writeHead() { this.headersSent = true; },
    // Collect RAW bytes and decode once at read time: a real socket carries bytes, so
    // decoding each write separately would invent U+FFFD at a split multi-byte char.
    write(c) { chunks.push(typeof c === 'string' ? Buffer.from(c, 'utf8') : Buffer.from(c)); return true; },
    end() { this.writableEnded = true; },
    once(ev, cb) { (listeners[ev] ||= []).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== cb); },
    emit(ev) { (listeners[ev] || []).forEach(cb => cb()); },
  };
}
function dummyManager() { return { updateUsage() {}, markSessionThinkingProtected() {} }; }
function sseBody(events) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const e of events) c.enqueue(enc.encode(e)); c.close(); } });
}

const providerSSE = stream([
  { type: 'message_start', message: { id: 'msg_p', type: 'message', role: 'assistant', model: 'glm-5.3', content: [], usage: { input_tokens: 5, output_tokens: 0 } } },
  ...thinking(0), ...text(1, 'Answer'),
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
  { type: 'message_stop' },
]);

test('wiring STREAM: streamResponse with a scrubber drops provider thinking; usage still parsed from the ORIGINAL stream', async () => {
  const got = [];
  const am = { ...dummyManager(), updateUsage(idx, inp, out) { got._usageIn = inp; } };
  const sc = new ProviderThinkingScrubber();
  await streamResponse(sseBody([providerSSE]), mockRes(got), 200, { 'content-type': 'text/event-stream' }, 0, am, [], { model: 'claude-opus-5', stream: true }, undefined, sc);
  assert.doesNotMatch(got.join(''), /thinking/);
  const r = pushReducer(parse(got.join('')));
  assert.deepEqual(r.map(b => [b.type, b.text]), [['text', 'Answer']]);
  assert.ok(got._usageIn !== undefined, 'usage accounting ran on the pre-scrub stream');
});

test('wiring STREAM flag OFF (scrubber null): bytes identical apart from model echo', async () => {
  const got = [];
  await streamResponse(sseBody([providerSSE]), mockRes(got), 200, { 'content-type': 'text/event-stream' }, 0, dummyManager(), [], { model: 'claude-opus-5', stream: true });
  assert.equal(got.join(''), providerSSE.replace('"model":"glm-5.3"', '"model":"claude-opus-5"'));
});

test('wiring CHUNKED: identical client bytes whether the stream arrives whole or in N-byte chunks', async () => {
  const run = async (chunks) => {
    const got = [];
    const sc = new ProviderThinkingScrubber();
    await streamResponse(sseBody(chunks), mockRes(got), 200, {}, 0, dummyManager(), [], { model: null }, undefined, sc);
    return got.join('');
  };
  const whole = await run([providerSSE]);
  for (const size of [5, 64, 512]) {
    const parts = [];
    for (let i = 0; i < providerSSE.length; i += size) parts.push(providerSSE.slice(i, i + size));
    assert.equal(await run(parts), whole, `chunk size ${size}`);
  }
  assert.match(whole, /Answer/);
  assert.doesNotMatch(whole, /thinking/);
});

// B1 (build review 2026-11-06): every chunk must be decoded ONCE. A second
// decode({stream:true}) on the same shared TextDecoder flushes a pending partial
// UTF-8 sequence as U+FFFD — invisible with ASCII fixtures, so the payload here
// splits a 3-byte char (中) across two chunks.
for (const flagOn of [false, true]) {
  test(`B1: multi-byte char split across chunks survives in client bytes AND streamLog (flag ${flagOn ? 'ON' : 'OFF'})`, async () => {
    const sse = stream([
      { type: 'message_start', message: { id: 'msg_u', type: 'message', role: 'assistant', model: 'glm-5.3', content: [], usage: { input_tokens: 3, output_tokens: 0 } } },
      ...text(0, 'A中B'),
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
      { type: 'message_stop' },
    ]);
    const bytes = Buffer.from(sse, 'utf8');
    const cut = bytes.indexOf(Buffer.from('中', 'utf8')) + 1;   // inside the 3-byte sequence
    const got = []; const log = [];
    const enc = [bytes.subarray(0, cut), bytes.subarray(cut)];
    const body = new ReadableStream({ start(c) { for (const b of enc) c.enqueue(new Uint8Array(b)); c.close(); } });
    await streamResponse(body, mockRes(got), 200, {}, 0, dummyManager(), log, { model: null }, undefined,
      flagOn ? new ProviderThinkingScrubber() : null);
    const client = got.join('');
    assert.doesNotMatch(client, /�/, 'client bytes carry no replacement char');
    assert.match(client, /A中B/);
    assert.equal(log.join(''), sse, 'streamLog (the usage/capacity lane) equals the original stream exactly');
  });
}
