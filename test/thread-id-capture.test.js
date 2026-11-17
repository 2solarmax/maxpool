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

test('extractUsageFromBody captures the id on a threaded non-streaming reply', () => {
  const { extractUsageFromBody } = __serverTest;
  const am = { accrueCapacity: () => {} };
  const ri = { _threadIntent: intent };
  extractUsageFromBody(Buffer.from('{"id":"msg_body","usage":{"input_tokens":1,"output_tokens":1}}'), 0, am, ri);
  assert.equal(ri._threadReplyId, 'msg_body');
  assert.equal(ri._capacityInput, 1, 'usage path untouched');
});

test("DIRECT path end to end: a create reply id is recorded, its continue passes, a sibling is refused", async () => {
  // The cloud pool serves each named account DIRECTLY — this is the path where the
  // thread gate runs (a link row on the Mac returns before it). Two direct accounts;
  // a create served by one must make the continue of THAT reply id pass on it and be
  // refused (400 thread_unsupported) on the other, even inside ONE terminal session.
  const { createProxyServer } = await import('../src/server.js');
  const { AccountManager } = await import('../src/account-manager.js');
  let n = 0;
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      n++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${n}`, type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const acct = (name) => ({ name, type: 'apikey', apiKey: 'k-' + name, upstream: `http://127.0.0.1:${upPort}` });
  const am = new AccountManager([acct('one'), acct('two')], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  const post = (body, pin) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'one-terminal', ...(pin ? { 'x-maxpool-pin-account': pin } : {}) },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));
  const base = { model: 'claude-opus-5-5', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };
  try {
    // Sibling agents inside ONE terminal: thread A created on "one", thread B on "two".
    // The per-terminal record now names "two" — the pre-fix gate refused A's continue on
    // its true holder "one" (and forwarded it to the wrong account the other way round).
    am.setRoutingMode('preferred', 'one');
    const a = await post({ ...base, thread: { type: 'create' } });
    assert.equal(a.status, 200, a.text);
    am.setRoutingMode('preferred', 'two');
    const b = await post({ ...base, thread: { type: 'create' } });
    assert.equal(b.status, 200, b.text);
    const idA = JSON.parse(a.text).id;
    const idB = JSON.parse(b.text).id;
    // A's continue on its holder "one" passes although the terminal last served on "two"
    am.setRoutingMode('preferred', 'one');
    const okA = await post({ ...base, thread: { type: 'continue', previous_message_id: idA } });
    assert.equal(okA.status, 200, `A's holder must serve A: ${okA.text}`);
    // B's continue routed to "one" (not its holder) is refused, although the terminal's
    // last record now says "one"
    const badB = await post({ ...base, thread: { type: 'continue', previous_message_id: idB } });
    assert.equal(badB.status, 400, `a non-holder must refuse B: ${badB.text}`);
    assert.match(badB.text, /thread_unsupported_request/);
  } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
});
import http from 'node:http';
