// THREAD-ID CAPTURE (2026-11-17): every path that relays a threaded reply must record
// the reply's own message id against the SERVING account — the next continue is judged
// by that id (previous_message_id), not by the terminal. These tests pin the capture
// seams on the real functions (parseSSEEvent, extractUsageFromBody), the per-attempt
// arming (threaded turns only), and the shared sink that survives the repair paths'
// `{ ...requestInfo }` copies.
import http from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const armed = (account) => ({ _threadSink: { attemptAccount: account, replyId: null, account: null } });

test('parseSSEEvent captures the message_start id against the armed account', () => {
  const ri = armed('one');
  __serverTest.parseSSEEvent('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_new"}}\n\n', 0, {}, ri);
  assert.equal(ri._threadSink.replyId, 'msg_new');
  assert.equal(ri._threadSink.account, 'one');
});

test('a NON-threaded attempt (sink not armed) records nothing — real parseSSEEvent and body reader', () => {
  const am = { accrueCapacity: () => {} };
  const ri = armed(null);
  __serverTest.parseSSEEvent('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_plain"}}\n\n', 0, am, ri);
  __serverTest.extractUsageFromBody(Buffer.from('{"id":"msg_plain2","usage":{"input_tokens":1,"output_tokens":1}}'), 0, am, ri);
  assert.equal(ri._threadSink.replyId, null);
  assert.equal(ri._threadSink.account, null);
});

test('extractUsageFromBody captures the id on a threaded non-streaming reply', () => {
  const am = { accrueCapacity: () => {} };
  const ri = armed('two');
  __serverTest.extractUsageFromBody(Buffer.from('{"id":"msg_body","usage":{"input_tokens":1,"output_tokens":1}}'), 0, am, ri);
  assert.equal(ri._threadSink.replyId, 'msg_body');
  assert.equal(ri._threadSink.account, 'two');
  assert.equal(ri._capacityInput, 1, 'usage path untouched');
});

test('a capture on a spread COPY lands in the shared sink the handler reads', () => {
  const ri = armed('one');
  const copy = { ...ri, effortRepaired: true };
  __serverTest.parseSSEEvent('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_copy"}}\n\n', 0, {}, copy);
  assert.equal(ri._threadSink.replyId, 'msg_copy');
});

async function harness(fn) {
  const { createProxyServer } = await import('../src/server.js');
  const { AccountManager } = await import('../src/account-manager.js');
  let n = 0;
  const tag = `h${harness.count = (harness.count || 0) + 1}`;
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      n++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: `msg_${tag}_${n}`, type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  await new Promise(r => upstream.listen(0, '127.0.0.1', r));
  const upPort = upstream.address().port;
  const acct = (name) => ({ name, type: 'apikey', apiKey: 'k-' + name, upstream: `http://127.0.0.1:${upPort}` });
  const am = new AccountManager([acct('one'), acct('two')], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const port = proxy.address().port;
  const session = `${tag}-terminal`;
  const post = (body, sess = session) => fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': sess },
    body: JSON.stringify(body) }).then(async r => ({ status: r.status, text: await r.text() }));
  try { await fn({ am, post, session }); } finally {
    await new Promise(r => proxy.close(r));
    await new Promise(r => upstream.close(r));
  }
}

const base = { model: 'claude-opus-5-5', stream: false, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] };

// Sibling agents inside ONE terminal: thread A created on "one", thread B on "two". The
// per-terminal record then names "two" — the pre-fix gate refused A's continue on its
// true holder "one" (and forwarded B's continue to the wrong account).
async function siblings({ am, post }, extra = {}) {
  am.setRoutingMode('preferred', 'one');
  const a = await post({ ...base, ...extra, thread: { type: 'create' } });
  assert.equal(a.status, 200, a.text);
  am.setRoutingMode('preferred', 'two');
  const b = await post({ ...base, ...extra, thread: { type: 'create' } });
  assert.equal(b.status, 200, b.text);
  return { idA: JSON.parse(a.text).id, idB: JSON.parse(b.text).id };
}

test('DIRECT path end to end: a create reply id is recorded, its continue passes, a sibling is refused', async () => {
  await harness(async (h) => {
    const { idA, idB } = await siblings(h);
    h.am.setRoutingMode('preferred', 'one');
    const okA = await h.post({ ...base, thread: { type: 'continue', previous_message_id: idA } });
    assert.equal(okA.status, 200, `A's holder must serve A: ${okA.text}`);
    const badB = await h.post({ ...base, thread: { type: 'continue', previous_message_id: idB } });
    assert.equal(badB.status, 400, `a non-holder must refuse B: ${badB.text}`);
    assert.match(badB.text, /thread_unsupported_request/);
  });
});

test('an EFFORT-LATCHED session (every turn served on a repaired copy) still records reply ids', async () => {
  await harness(async (h) => {
    h.am.markSessionEffort(h.session, 'claude-opus-5-5', 'high');
    const { idA } = await siblings(h, { output_config: { effort: 'xhigh' } });
    h.am.setRoutingMode('preferred', 'one');
    const okA = await h.post({ ...base, output_config: { effort: 'xhigh' }, thread: { type: 'continue', previous_message_id: idA } });
    assert.equal(okA.status, 200, `A's holder must serve A on a latched session: ${okA.text}`);
  });
});

test('plain (non-threaded) turns never enter the thread map', async () => {
  await harness(async (h) => {
    const owners = __serverTest.threadOwners();
    const { idA } = await siblings(h);
    const before = owners.threads.size;
    for (let i = 0; i < 25; i++) {
      const r = await h.post({ ...base }, 'other-terminal');
      assert.equal(r.status, 200, r.text);
    }
    assert.equal(owners.threads.size, before, 'a plain reply names no thread');
    assert.equal(owners.threadOwner(idA), 'one');
  });
});

test('the account is bound at CAPTURE time: re-arming for a later attempt cannot re-attribute an id', () => {
  const ri = armed('one');
  __serverTest.parseSSEEvent('event: message_start\ndata: {"type":"message_start","message":{"id":"msg_a1"}}\n\n', 0, {}, ri);
  ri._threadSink.attemptAccount = 'two';   // a retry moved accounts and died before message_start
  assert.equal(ri._threadSink.replyId, 'msg_a1');
  assert.equal(ri._threadSink.account, 'one');
});
