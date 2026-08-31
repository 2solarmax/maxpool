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
