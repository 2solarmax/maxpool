import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { __serverTest } from '../src/server.js';

const { streamResponse } = __serverTest;

function mockRes(chunks) {
  const listeners = {};
  return {
    headersSent: false, destroyed: false, writableEnded: false,
    writeHead() { this.headersSent = true; },
    write(c) { chunks.push(typeof c === 'string' ? c : Buffer.from(c).toString('utf8')); return true; },
    end() { this.writableEnded = true; },
    once(ev, cb) { (listeners[ev] ||= []).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== cb); },
    emit(ev) { (listeners[ev] || []).forEach(cb => cb()); },
  };
}

function dummyManager() {
  return {
    updateUsage() {},
    markSessionThinkingProtected() {},
  };
}

function sseBody(events) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const e of events) ctrl.enqueue(enc.encode(e));
      ctrl.close();
    },
  });
}

test('model echo: glm id in message_start is rewritten to the client model', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody(['event: message_start\ndata: {"type":"message_start","message":{"model":"glm-5.3","role":"assistant"}}\n\n']),
    res, 200, { 'content-type': 'text/event-stream' }, 0,
    dummyManager(), [],
    { model: 'claude-opus-5', stream: true },
  );
  const out = got.join('');
  assert.match(out, /"model":"claude-opus-5"/);
  assert.doesNotMatch(out, /glm-5\.3/);
});

test('model echo: event split across chunks is still rewritten', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody([
      'event: message_start\ndata: {"type":"message_start","message":{"mod',
      'el":"glm-5.3","role":"assistant"}}\n\nevent: content_block_start\ndata: {"x":1}\n\n',
    ]),
    res, 200, { 'content-type': 'text/event-stream' }, 0,
    dummyManager(), [],
    { model: 'claude-sonnet-5', stream: true },
  );
  const out = got.join('');
  assert.match(out, /"model":"claude-sonnet-5"/);
  assert.doesNotMatch(out, /glm-5\.3/);
});

test('model echo: no requestInfo.model → passthrough untouched', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody(['event: message_start\ndata: {"type":"message_start","message":{"model":"glm-5.3"}}\n\n']),
    res, 200, { 'content-type': 'text/event-stream' }, 0,
    dummyManager(), [],
    {},
  );
  assert.match(got.join(''), /"model":"glm-5\.3"/);
});

test('model echo: claude-served response (model already == client model) passes through', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody(['event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-5"}}\n\n']),
    res, 200, { 'content-type': 'text/event-stream' }, 0,
    dummyManager(), [],
    { model: 'claude-opus-5', stream: true },
  );
  assert.match(got.join(''), /"model":"claude-opus-5"/);
});

test('model echo: pathological no-model 64KB+ stream flushes verbatim', async () => {
  const got = [];
  const res = mockRes(got);
  const big = 'event: ping\ndata: {"x":"' + 'a'.repeat(70_000) + '"}\n\n';
  await streamResponse(
    sseBody([big]),
    res, 200, { 'content-type': 'text/event-stream' }, 0,
    dummyManager(), [],
    { model: 'claude-opus-5', stream: true },
  );
  assert.ok(got.join('').length > 70_000);
});

// ── non-streaming (buffered) path — the half missed by v1.19.1 ────────────────

const { normalizeModelEcho } = __serverTest;

test('buffered: provider model id is rewritten to the client model', () => {
  const buf = Buffer.from(JSON.stringify({ id: 'm', model: 'glm-5.3', content: [] }));
  const out = normalizeModelEcho(buf, 'claude-opus-5');
  assert.equal(JSON.parse(out.toString()).model, 'claude-opus-5');
});

test('buffered: identical model returns the SAME buffer (no copy, no length change)', () => {
  const buf = Buffer.from(JSON.stringify({ model: 'claude-opus-5' }));
  assert.equal(normalizeModelEcho(buf, 'claude-opus-5'), buf);
});

test('buffered: no client model → untouched', () => {
  const buf = Buffer.from(JSON.stringify({ model: 'glm-5.3' }));
  assert.equal(normalizeModelEcho(buf, undefined), buf);
});

test('buffered: non-JSON body is forwarded verbatim', () => {
  const buf = Buffer.from('not json at all');
  assert.equal(normalizeModelEcho(buf, 'claude-opus-5'), buf);
});

test('buffered: body without a model field is untouched', () => {
  const buf = Buffer.from(JSON.stringify({ type: 'error', error: { type: 'x' } }));
  assert.equal(normalizeModelEcho(buf, 'claude-opus-5'), buf);
});

test('buffered: rewritten length differs from the original — the caller MUST reset content-length', () => {
  const buf = Buffer.from(JSON.stringify({ model: 'glm-5.3', content: [] }));
  const out = normalizeModelEcho(buf, 'claude-opus-5');
  assert.notEqual(out.length, buf.length, 'a length change is real; a stale content-length would truncate');
});

test('buffered: other fields survive the rewrite intact', () => {
  const src = { id: 'msg_1', model: 'glm-5.3', role: 'assistant',
                content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 5, output_tokens: 2 } };
  const out = JSON.parse(normalizeModelEcho(Buffer.from(JSON.stringify(src)), 'claude-sonnet-5').toString());
  assert.equal(out.model, 'claude-sonnet-5');
  assert.deepEqual(out.usage, src.usage);
  assert.deepEqual(out.content, src.content);
  assert.equal(out.id, 'msg_1');
});

// ── wiring: the buffered call site must actually be live (a helper alone is inert) ──
// Mutating out the `normalizeModelEcho(buf, ...)` call at server.js's non-streaming
// branch passes every unit test above; only this end-to-end walk catches it.

test('wiring: a NON-STREAMING provider response is normalized through the real proxy', async () => {
  const http = await import('node:http');
  const { createProxyServer } = await import('../src/server.js');
  const { AccountManager } = await import('../src/account-manager.js');

  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant',
      model: 'glm-5.3', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 2 } }));
  });
  await new Promise(r => upstream.listen(0, r));
  const up = `http://127.0.0.1:${upstream.address().port}`;

  const am = new AccountManager([{ name: 'a1', type: 'oauth', authToken: 't', profiles: ['claude', 'all'] }], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'k' }, upstream: up });
  await new Promise(r => proxy.listen(0, r));
  const port = proxy.address().port;

  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-opus-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const body = await r.json();
    assert.equal(body.model, 'claude-opus-5', 'the provider id must not reach the client');
    assert.deepEqual(body.content, [{ type: 'text', text: 'hi' }], 'payload survives the rewrite');
    assert.deepEqual(body.usage, { input_tokens: 5, output_tokens: 2 }, 'usage survives the rewrite');
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});
