// THREAD-ID CAPTURE (2026-11-17): every path that relays a threaded reply must record
// the reply's own message id against the SERVING account — the next continue is judged
// by that id (previous_message_id), not by the terminal. These tests pin the three
// capture seams: the direct streaming path (parseSSEEvent), the direct non-streaming
// path (extractUsageFromBody), and the link tap (tapLinkUsage, streaming + head).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const intent = { kind: 'continue', previousMessageId: 'msg_prev' };

test('parseSSEEvent captures message_start id on a threaded request', () => {
  const ri = { _threadIntent: intent };
  __serverTest.parseSSEEvent('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_new"}}\n\n', 0, {}, ri);
  assert.equal(ri._threadReplyId, 'msg_new');
});

test('a NON-threaded request records nothing', () => {
  const ri = {};
  const data = { type: 'message_start', message: { id: 'x' } };
  if (data?.type === 'message_start' && typeof data.message?.id === 'string' && ri._threadIntent) {
    ri._threadReplyId = data.message.id;
  }
  assert.equal(ri._threadReplyId, undefined);
});

test('tapLinkUsage (streaming) captures the reply id for a threaded turn', () => {
  const { tapLinkUsage } = __serverTest;
  const ri = { isCountTokens: false, stream: true, _threadIntent: intent };
  tapLinkUsage(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_link"}}\n\n'), ri);
  assert.equal(ri._threadReplyId, 'msg_link');
});

test('tapLinkUsage (non-streaming) reads the id from the head slice', () => {
  const { tapLinkUsage } = __serverTest;
  const ri = { isCountTokens: false, stream: false, _threadIntent: intent };
  // a body whose head carries the id and whose tail carries usage — the tap must keep BOTH
  const head = '{"id":"msg_ns","type":"message","role":"assistant","content":[';
  const tail = `{"type":"text","text":"${'x'.repeat(70_000)}"}],"usage":{"input_tokens":5,"output_tokens":2}}`;
  for (const part of [head, tail]) tapLinkUsage(Buffer.from(part), ri);
  tapLinkUsage(null, ri);
  assert.equal(ri._threadReplyId, 'msg_ns');
  assert.equal(ri._capacityInput, 5, 'usage still parsed from the tail');
});

test('tapLinkUsage ignores the id without thread intent (plain stateless turn)', () => {
  const { tapLinkUsage } = __serverTest;
  const ri = { isCountTokens: false, stream: true };
  tapLinkUsage(Buffer.from('event: message_start\ndata: {"type":"message_start","message":{"id":"nope"}}\n\n'), ri);
  assert.equal(ri._threadReplyId, undefined);
});

test('extractUsageFromBody captures the id on a threaded non-streaming reply', () => {
  const { extractUsageFromBody } = __serverTest;
  const am = { accrueCapacity: () => {} };
  const ri = { _threadIntent: intent };
  extractUsageFromBody(Buffer.from('{"id":"msg_body","usage":{"input_tokens":1,"output_tokens":1}}'), 0, am, ri);
  assert.equal(ri._threadReplyId, 'msg_body');
  assert.equal(ri._capacityInput, 1, 'usage path untouched');
});
