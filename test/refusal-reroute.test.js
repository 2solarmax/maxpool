// SAFEGUARD-REFUSAL REROUTE (task-2026-09-14-maxpool-reroute-anthropic-refusals-to-provider)
//
// Anthropic can end a turn with HTTP 200 + stop_reason:"refusal" and usage 0/0 — no model
// output exists, the CLI renders "API Error: … safeguards flagged this message", and the
// turn dies. maxpool now holds the first SSE events, detects the refusal before anything
// reaches the client, and throws REFUSAL_RETRY so the caller re-dispatches on a provider.
//
// The fixtures below are the REAL wire shape, taken from session e2750920 (9 captures,
// 2026-09-01 20:24 → 09-02 04:12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { __serverTest } from '../src/server.js';

const { streamResponse, classifyHeldStreamPrefix } = __serverTest;

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

const dummyManager = () => ({ updateUsage() {}, markSessionThinkingProtected() {} });

function sseBody(events) {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      for (const e of events) ctrl.enqueue(enc.encode(e));
      ctrl.close();
    },
  });
}

// --- real captured shapes -------------------------------------------------
const MESSAGE_START = 'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"claude-opus-5","usage":{"input_tokens":0,"output_tokens":0}}}\n\n';
const PING = 'event: ping\ndata: {"type":"ping"}\n\n';
const REFUSAL_DELTA = 'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal","stop_details":{"type":"refusal","category":"reasoning_extraction","explanation":"This request was blocked as it seems to violate Anthropic\'s Terms of Service restrictions on reverse engineering or duplicating model outputs."}},"usage":{"output_tokens":0}}\n\n';
const CONTENT_START = 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n';
const CONTENT_DELTA = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}\n\n';
const MESSAGE_STOP = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

// --- classifier -----------------------------------------------------------

test('classifier: message_start alone is not decisive', () => {
  assert.equal(classifyHeldStreamPrefix(MESSAGE_START).decision, 'hold');
});

test('classifier: ping is not decisive (must not release the hold)', () => {
  assert.equal(classifyHeldStreamPrefix(MESSAGE_START + PING).decision, 'hold');
});

test('classifier: real refusal delta is detected with its category', () => {
  const v = classifyHeldStreamPrefix(MESSAGE_START + REFUSAL_DELTA);
  assert.equal(v.decision, 'refusal');
  assert.equal(v.category, 'reasoning_extraction');
});

test('classifier: content_block_start releases the hold', () => {
  assert.equal(classifyHeldStreamPrefix(MESSAGE_START + CONTENT_START).decision, 'content');
});

test('classifier: partial/incomplete JSON holds rather than throwing', () => {
  assert.equal(classifyHeldStreamPrefix('event: message_start\ndata: {"type":"mess').decision, 'hold');
});

test('classifier: message_stop without refusal releases (usage-only edge)', () => {
  assert.equal(classifyHeldStreamPrefix(MESSAGE_START + MESSAGE_STOP).decision, 'content');
});

// --- stream integration ---------------------------------------------------

test('refusal on an ELIGIBLE anthropic stream throws REFUSAL_RETRY and writes NOTHING', async () => {
  const got = [];
  const res = mockRes(got);
  await assert.rejects(
    () => streamResponse(
      sseBody([MESSAGE_START, PING, REFUSAL_DELTA, MESSAGE_STOP]), res, 200, {}, 0, dummyManager(), null,
      { _refusalRerouteEligible: true },
    ),
    (err) => {
      assert.equal(err.code, 'REFUSAL_RETRY');
      assert.equal(err.refusalCategory, 'reasoning_extraction');
      return true;
    },
  );
  assert.equal(got.length, 0, 'nothing may be written to the client — the turn is being rerouted');
  assert.equal(res.headersSent, false, 'headers must not be committed, or failover is impossible');
  assert.equal(res.writableEnded, false, 'the socket must stay open for the retry');
});

test('a NORMAL stream is unaffected when the hold is armed (content flushes verbatim)', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody([MESSAGE_START, CONTENT_START, CONTENT_DELTA, MESSAGE_STOP]), res, 200, {}, 0, dummyManager(), null,
    { _refusalRerouteEligible: true },
  );
  const out = got.join('');
  assert.ok(out.includes('message_start'), 'held events must be released, not dropped');
  assert.ok(out.includes('hello'), 'content must reach the client');
  assert.ok(out.includes('message_stop'));
});

test('refusal on a NON-eligible stream (provider) passes through untouched', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody([MESSAGE_START, REFUSAL_DELTA, MESSAGE_STOP]), res, 200, {}, 0, dummyManager(), null,
    { _refusalRerouteEligible: false },
  );
  assert.ok(got.join('').includes('refusal'), 'without the flag the refusal is forwarded as before');
});

test('hold releases in ORDER — no chunk is reordered or lost', async () => {
  const got = [];
  const res = mockRes(got);
  await streamResponse(
    sseBody([MESSAGE_START, PING, CONTENT_START, CONTENT_DELTA, MESSAGE_STOP]), res, 200, {}, 0, dummyManager(), null,
    { _refusalRerouteEligible: true },
  );
  const out = got.join('');
  assert.ok(out.indexOf('message_start') < out.indexOf('content_block_start'), 'order preserved');
  assert.ok(out.indexOf('content_block_start') < out.indexOf('message_stop'), 'order preserved');
  assert.ok(out.includes('"type":"ping"'), 'non-decisive events are still delivered');
});

