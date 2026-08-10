import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { stripForeignThinkingBlocks, parseRejectedBlockPath, stripRejectedBlockClass, peekRejectedBlockType, describeRejectedBlock } = __serverTest;

// The exact error Anthropic returned on 2026-08-06, which the user saw as
// "Start a new session ... maxpool could not repair automatically".
const REAL_400 = 'messages.29.content.58: Invalid `signature` in `thinking` block';

const enc = obj => Buffer.from(JSON.stringify(obj));
const dec = buf => JSON.parse(buf.toString('utf8'));

// ── the defect: a thinking block the broad strip could not SEE ────────────────
//
// Before this fix `stripForeignThinkingBlocks` skipped every message whose role was
// not exactly 'assistant', so it reported "nothing to remove" for a block Anthropic
// rejects. That left `thinkingStripped` false, barred the session latch, and surfaced
// the 400 to the user — the bricked-session report.

test('a thinking block on a NON-assistant role is stripped (was invisible → session bricked)', () => {
  const body = enc({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      // The shape the role gate skipped.
      { role: 'user', content: [
        { type: 'thinking', thinking: 'foreign', signature: '8f8840affff743118e1f569d' },
        { type: 'text', text: 'still here' },
      ] },
    ],
  });

  const out = stripForeignThinkingBlocks(body);

  assert.ok(out.body, 'must produce a repaired body — returning null is the bug');
  assert.equal(out.removed, 1);
  const msgs = dec(out.body).messages;
  // Conversation content survives; only the unverifiable block goes.
  assert.deepEqual(msgs[1].content, [{ type: 'text', text: 'still here' }]);
});

test('assistant-role stripping and text/tool_use preservation still hold', () => {
  const body = enc({
    messages: [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'x', signature: 'sig' },
        { type: 'text', text: 'answer' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} },
      ] },
    ],
  });
  const out = stripForeignThinkingBlocks(body);
  assert.equal(out.removed, 1);
  const content = dec(out.body).messages[0].content;
  assert.deepEqual(content.map(b => b.type), ['text', 'tool_use'], 'content + tool wiring preserved');
});

test('a turn that stripping empties is dropped, not resent with its rejected block', () => {
  const body = enc({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    ],
  });
  const out = stripForeignThinkingBlocks(body);
  const msgs = dec(out.body).messages;
  assert.equal(msgs.length, 1, 'the emptied turn is removed entirely');
  assert.equal(msgs[0].role, 'user');
});

// ── the coordinate repair: trust Anthropic's index over our shape model ───────

test('the rejected-block coordinate is parsed from the real 400 body', () => {
  assert.deepEqual(parseRejectedBlockPath(REAL_400), { mi: 29, ci: 58 });
  assert.equal(parseRejectedBlockPath('some unrelated error'), null);
  assert.equal(parseRejectedBlockPath(''), null);
  assert.equal(parseRejectedBlockPath(undefined), null);
});

test('coordinate repair removes the whole CLASS in one round-trip, not one block at a time', () => {
  // `redacted_thinking` is deliberately outside the broad strip (it carries `data`,
  // no signature). If Anthropic ever rejects one, only the coordinate repair sees it.
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'q' }] }];
  for (let i = 0; i < 5; i++) {
    messages.push({ role: 'assistant', content: [
      { type: 'redacted_thinking', data: `d${i}` },
      { type: 'text', text: `a${i}` },
    ] });
  }
  const body = enc({ messages });

  // Anthropic points at message 1, block 0.
  const out = stripRejectedBlockClass(body, 'messages.1.content.0: Invalid `signature` in `thinking` block');

  assert.ok(out.body, 'coordinate repair must fire where the broad strip is blind');
  assert.equal(out.type, 'redacted_thinking');
  assert.equal(out.removed, 5, 'all 5 removed in ONE retry — not 5 rejected round-trips');
  // Proof the broad strip genuinely could not do this:
  assert.equal(stripForeignThinkingBlocks(body).body, null, 'broad strip is blind here by design');

  const repaired = dec(out.body).messages;
  assert.equal(repaired.length, 6, 'no turn was lost — each kept its text block');
  assert.ok(repaired.every(m => m.content.every(b => b.type !== 'redacted_thinking')));
});

test('coordinate repair REFUSES to remove content-bearing blocks', () => {
  // Removing text/tool_use would corrupt the transcript rather than repair it.
  for (const type of ['text', 'tool_use', 'tool_result']) {
    const body = enc({ messages: [{ role: 'assistant', content: [{ type, text: 'x', id: 'i' }] }] });
    const out = stripRejectedBlockClass(body, 'messages.0.content.0: Invalid `signature` in `thinking` block');
    assert.equal(out.body, null, `${type} must never be stripped`);
    assert.equal(out.type, type, 'the type is still reported, so the user gets a real reason');
  }
});

test('coordinate repair is inert on a body it cannot use (no crash, no corruption)', () => {
  const body = enc({ messages: [{ role: 'assistant', content: [{ type: 'thinking', signature: 's' }] }] });
  // Out-of-range coordinate — must not throw, must not rewrite.
  assert.equal(stripRejectedBlockClass(body, 'messages.99.content.99: Invalid').body, null);
  // No coordinate in the error at all.
  assert.equal(stripRejectedBlockClass(body, 'Invalid `signature`').body, null);
  // Unparseable body.
  assert.equal(stripRejectedBlockClass(Buffer.from('not json'), REAL_400).body, null);
  // Non-array messages.
  assert.equal(stripRejectedBlockClass(enc({ messages: 'nope' }), REAL_400).body, null);
});

test('coordinate repair drops a turn it empties, keeping the transcript valid', () => {
  const body = enc({
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'q' }] },
      { role: 'assistant', content: [{ type: 'redacted_thinking', data: 'd' }] },
      { role: 'user', content: [{ type: 'text', text: 'q2' }] },
    ],
  });
  const out = stripRejectedBlockClass(body, 'messages.1.content.0: bad');
  const msgs = dec(out.body).messages;
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every(m => m.content.length > 0), 'no message is left with empty content');
});

// ── WIRING (not just the unit): the repair must actually run in forwardRequest ──
//
// Every test above passes even with the call site DELETED from the 4xx handler — the
// unit works while the proxy never calls it. This drives the real proxy against a real
// upstream so an inert repair is caught.

import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const close = s => new Promise(r => s.close(r));
// Two accounts on purpose: maxAttempts defaults to the ACCOUNT COUNT, so a single-account
// fleet makes `retryCount + 1 < maxAttempts` false and silently bars every repair path.
const fleet = () => [
  { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  { name: 'a2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
];

test('WIRING: a signature 400 on a block the broad strip cannot see is repaired and retried', async () => {
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        // The exact shape Anthropic returned on 2026-08-06.
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);

  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'q' }] },
          // Invisible to the broad strip (redacted_thinking is excluded by design):
          // ONLY the coordinate repair can rescue this session.
          { role: 'assistant', content: [
            { type: 'redacted_thinking', data: 'zzz' },
            { type: 'text', text: 'kept' },
          ] },
        ],
      }),
    });

    assert.equal(res.status, 200, 'the session must SURVIVE — 400 here means the repair never ran');
    assert.equal(bodies.length, 2, 'exactly one repair retry');
    const retried = bodies[1].messages;
    assert.ok(retried[1].content.every(b => b.type !== 'redacted_thinking'), 'rejected block removed on retry');
    assert.deepEqual(retried[1].content, [{ type: 'text', text: 'kept' }], 'conversation content preserved');
  } finally {
    await close(proxy);
    await close(upstream);
  }
});

// ── judge findings: each of these kills a mutant that survived the full suite ──

test('MUT-N: the broad-strip CALL SITE is pinned — deleting it must fail a test', async () => {
  // The unit tests above all pass with the reactive broad strip disabled, because the
  // coordinate repair silently covers for it. So assert WHICH repair ran, by log line.
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        // A `thinking` block on a USER role — the exact diagnosed shape. The BROAD strip
        // must be what repairs this; if the call site is gone the coordinate repair
        // still returns 200, so status alone cannot tell them apart.
        { role: 'user', content: [
          { type: 'thinking', thinking: 'foreign', signature: '8f8840affff743118e1f569d' },
          { type: 'text', text: 'kept' },
        ] },
      ] }),
    });
    console.log = orig;
    assert.equal(res.status, 200);
    const joined = logs.join('\n');
    assert.match(joined, /stripped 1 provider thinking block/, 'the BROAD strip must be the repair that ran');
    assert.doesNotMatch(joined, /rejected a "thinking" block by index/, 'the coordinate repair must NOT be what saved it');
  } finally {
    console.log = orig;
    await close(proxy); await close(upstream);
  }
});

test('MUT-A: coordinate repair handles `thinking` — the only type Anthropic really points at', () => {
  // Every other coordinate test uses redacted_thinking, so the `thinking` half of the
  // safety guard was completely unpinned: it could be made to refuse `thinking` with
  // zero failures across all 571 tests.
  const body = enc({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'tool', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'k' }] },
  ] });
  const out = stripRejectedBlockClass(body, 'messages.1.content.0: Invalid `signature` in `thinking` block');
  assert.ok(out.body, '`thinking` MUST be repairable by coordinate');
  assert.equal(out.type, 'thinking');
  assert.equal(out.removed, 1);
});

test('a NESTED coordinate is refused, so the user is never told the wrong block type', () => {
  // messages.29.content.58.content.3 points INSIDE block 58, not at it. Taking the outer
  // coordinate would report e.g. "tool_result" — confidently wrong.
  assert.equal(parseRejectedBlockPath('messages.29.content.58.content.3: Invalid `signature`'), null);
  assert.deepEqual(parseRejectedBlockPath('messages.29.content.58: Invalid `signature`'), { mi: 29, ci: 58 });
});

test('messages[0] is never dropped — an assistant-first transcript is rejected outright', () => {
  // Reachable only since the role gate was removed.
  const body = enc({ messages: [
    { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'a' }] },
  ] });
  const out = stripForeignThinkingBlocks(body);
  const msgs = dec(out.body).messages;
  assert.equal(msgs[0].role, 'user', 'first message must still be a user turn');
  assert.ok(msgs[0].content.length > 0, 'and must not have empty content');
  // Same guard on the coordinate path.
  const out2 = stripRejectedBlockClass(body, 'messages.0.content.0: Invalid `signature` in `thinking` block');
  assert.equal(dec(out2.body).messages[0].role, 'user');
});

test('MUT-C: a redacted_thinking coordinate repair does NOT latch the session', async () => {
  // The pre-strip cannot touch redacted_thinking, so latching would make every later
  // turn pay a rejected round-trip forever, and mislabel the give-up as a GLM/Kimi
  // story. Asserted by OBSERVING the latch call, not by reading the source.
  const latched = [];
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const realLatch = am.markSessionThinkingContaminated.bind(am);
  am.markSessionThinkingContaminated = key => { latched.push(key); return realLatch(key); };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'assistant', content: [
          { type: 'redacted_thinking', data: 'zzz' },
          { type: 'text', text: 'kept' },
        ] },
      ] }),
    });
    assert.equal(res.status, 200, 'session still recovers');
    assert.deepEqual(latched, [], 'a redacted_thinking repair must NOT latch — the pre-strip cannot repeat it');
  } finally { await close(proxy); await close(upstream); }
});

test('a `thinking` coordinate repair DOES latch (the pre-strip can repeat that one)', async () => {
  const latched = [];
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const realLatch = am.markSessionThinkingContaminated.bind(am);
  am.markSessionThinkingContaminated = key => { latched.push(key); return realLatch(key); };
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [
        { role: 'user', content: [{ type: 'text', text: 'q' }] },
        { role: 'user', content: [
          { type: 'thinking', thinking: 'x', signature: 's' },
          { type: 'text', text: 'kept' },
        ] },
      ] }),
    });
    assert.equal(res.status, 200);
    assert.equal(latched.length > 0, true, 'a `thinking` repair latches so later turns are pre-stripped');
  } finally { await close(proxy); await close(upstream); }
});

test('MUT-G/peek: the give-up reads the rejected type WITHOUT rebuilding the body', () => {
  const body = enc({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }] },
  ] });
  assert.equal(peekRejectedBlockType(body, 'messages.1.content.0: Invalid'), 'tool_result');
  assert.equal(peekRejectedBlockType(body, 'no coordinate here'), null);
  assert.equal(peekRejectedBlockType(Buffer.from('not json'), 'messages.0.content.0: x'), null);
  // And it must NOT be the rewriting function — that one refuses tool_result outright.
  assert.equal(stripRejectedBlockClass(body, 'messages.1.content.0: Invalid').body, null);
});

test('the instrument names role+type+coordinate so the next give-up is diagnosable', () => {
  const body = enc({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'user', content: [{ type: 'thinking', thinking: 'x', signature: 's' }, { type: 'text', text: 'k' }] },
  ] });
  const line = describeRejectedBlock(body, 'messages.1.content.0: Invalid `signature` in `thinking` block');
  assert.match(line, /coordinate=messages\.1\.content\.0/);
  assert.match(line, /role=user/);
  assert.match(line, /type=thinking/);
  assert.match(line, /blocks=2/);
  // It must survive the bodies it exists to diagnose.
  assert.match(describeRejectedBlock(Buffer.from('not json'), 'messages.1.content.0: x'), /UNPARSEABLE/);
  assert.match(describeRejectedBlock(body, 'no coordinate'), /coordinate=unparsed/);
  assert.match(describeRejectedBlock(body, 'messages.9.content.9: x'), /role=MISSING type=MISSING/);
});

test('a body OVER the retry buffer is still REPAIRED (size must not block a repair)', async () => {
  // Reported 2026-08-10: "This session's history is too large for maxpool to rewrite
  // automatically (over 10MB). Run /compact" — on a session the strip fixes in 20ms.
  // The limit exists to stop a huge body being RE-SENT across accounts on failover; a
  // repair SHRINKS it (measured 11.5MB -> 5.7MB), so gating the repair on it was
  // backwards. Worse, /compact itself goes through maxpool, so the user was deadlocked.
  //
  // Asserts WHICH repair ran: the two repair paths mask each other's absence, so a
  // status-only assertion passes even with the gate restored on one of them.
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 200 },   // force canRetryBufferedBody = false
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] },
        { role: 'user', content: [
          { type: 'thinking', thinking: 'y', signature: 's' },
          { type: 'text', text: 'kept' },
        ] },
      ] }),
    });
    console.log = orig;
    assert.equal(res.status, 200, 'an oversized body must STILL be repaired, not refused');
    assert.equal(bodies.length, 2, 'the repair retry fired despite the size limit');
    // The BROAD strip must be what ran — if its gate is restored, the coordinate repair
    // silently covers for it and a status-only check would still pass.
    const joined = logs.join('\n');
    assert.match(joined, /stripped \d+ provider thinking block/,
      'the BROAD strip must run on an oversized body');
    const retried = bodies[1].messages;
    assert.ok(retried.every(m => m.content.every(b => b.type !== 'thinking')),
      'the offending block was stripped');
  } finally {
    console.log = orig;
    await close(proxy); await close(upstream);
  }
});

test('the COORDINATE repair also ignores the size limit (its own gate)', async () => {
  // Same fix, other path. Uses redacted_thinking, which the broad strip is blind to by
  // design — so ONLY the coordinate repair can rescue this, isolating its gate.
  const logs = [];
  const orig = console.log;
  console.log = (...a) => { logs.push(a.join(' ')); };
  const bodies = [];
  const upstream = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      bodies.push(JSON.parse(raw));
      if (bodies.length === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error',
          message: 'messages.1.content.0: Invalid `signature` in `thinking` block' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, usage: { input_tokens: 1, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager(fleet(), 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 200 },
  });
  const proxyPort = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'test', messages: [
        { role: 'user', content: [{ type: 'text', text: 'x'.repeat(500) }] },
        { role: 'assistant', content: [
          { type: 'redacted_thinking', data: 'zzz' },
          { type: 'text', text: 'kept' },
        ] },
      ] }),
    });
    console.log = orig;
    assert.equal(res.status, 200, 'the coordinate repair must run on an oversized body');
    assert.match(logs.join('\n'), /rejected a "redacted_thinking" block by index/,
      'the COORDINATE repair is what saved it');
  } finally {
    console.log = orig;
    await close(proxy); await close(upstream);
  }
});

test('a PROVIDER issuer does NOT trigger the revert fail-safe (the 400-loop bug)', () => {
  // Drives the REAL migration: bind a session to the provider, then acquire on a
  // Claude account — that sets lease.migratedFromName to the provider's name, which
  // is exactly the state that produced the 4x loop on 2026-08-09.
  const am = new AccountManager([
    { name: 'cc1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'z',
      upstream: 'https://api.z.ai/api/anthropic', profiles: ['claude', 'all'] },
  ], 0.90, { crossProviderFallbackPolicy: 'always' });

  const glm = am.accounts.find(a => a.type === 'provider');

  // Session lives on the PROVIDER
  am._bindSession('sess', glm, null);
  // Now force it onto the Claude account (the migration)
  const lease = am.acquireAccount(
    { profile: 'claude', sessionKey: 'sess', pinnedAccountName: 'cc1' }, new Set(),
  );
  assert.equal(lease?.account?.name, 'cc1', 'migrated onto the Claude account');
  assert.equal(lease.migratedFromName, 'glm', 'the issuer is the PROVIDER');

  // THE ASSERTION: the issuer is a provider, so the fail-safe must be skipped.
  // This is the exact predicate server.js uses.
  const issuer = am.accounts.find(a => a.name === lease.migratedFromName);
  const issuerIsClaude = issuer && issuer.type !== 'provider';
  assert.equal(issuerIsClaude, false,
    'a provider issuer must NOT satisfy the fail-safe gate — reverting there repairs nothing');
});

test('a CLAUDE issuer DOES trigger the revert fail-safe (the fix stays scoped)', () => {
  const am = new AccountManager([
    { name: 'cc1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'cc2', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  const cc1 = am.accounts[0];
  am._bindSession('sess', cc1, null);
  const lease = am.acquireAccount(
    { profile: 'claude', sessionKey: 'sess', pinnedAccountName: 'cc2' }, new Set(),
  );
  assert.equal(lease.migratedFromName, 'cc1', 'the issuer is another CLAUDE account');
  const issuer = am.accounts.find(a => a.name === lease.migratedFromName);
  const issuerIsClaude = issuer && issuer.type !== 'provider';
  assert.equal(issuerIsClaude, true, 'a Claude issuer still gets the revert fail-safe');
});

test('WIRING: server.js gates the fail-safe on issuerIsClaude', async () => {
  // Pins the actual source predicate so removing it fails.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  assert.match(src, /const issuerIsClaude = issuer && issuer\.type !== 'provider'/,
    'the issuer-type check must exist');
  assert.match(src, /if \(lease\.migratedFromName && issuerIsClaude && requestInfo\.sessionKey/,
    'the fail-safe branch must be gated on issuerIsClaude');
});
