// Two pre-existing defects on the transcript-repair surface, found while fixing the
// orphaned-system 400 (2026-08-24) and deliberately left for their own change.
//
// A. A `system` turn whose OWN content is thinking-only is DELETED by the strip. The
//    strip runs on every role by design (a signature is validated wherever it sits), and
//    a turn stripped empty is dropped — so the directive vanishes with no signal. Silent
//    instruction loss is the worst failure mode on this surface: the session keeps
//    working and quietly behaves differently.
// B. The messages[0] guard's comment says the first turn "must survive as a `user` turn",
//    but the code does `{...msg, content:[…]}` — preserving the ORIGINAL role. A
//    system-first transcript stays system-first, which is exactly what the guard exists
//    to prevent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { stripForeignThinkingBlocks, stripRejectedBlockClass } = __serverTest;
const msgs = buf => JSON.parse(buf).messages;
const roles = buf => msgs(buf).map(m => m.role);
const foreign = () => ({ type: 'thinking', thinking: 'x', signature: 'foreign-sig' });

test('P1: a thinking-only SYSTEM turn is never deleted — the directive survives', () => {
  // The system carries nothing but a poisoned thinking block. Dropping the turn is how
  // every other role is handled, but a system is an INSTRUCTION channel: its presence is
  // itself meaningful, and its loss is invisible to the user.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [foreign()] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.ok(r.body, 'the repair produced a body');
  assert.deepEqual(roles(r.body), ['user', 'system', 'assistant'], 'the system turn keeps its POSITION');
  assert.deepEqual(msgs(r.body)[1].content, [{ type: 'text', text: '(content removed)' }],
    'held open by a placeholder rather than dropped');
});

test('P2: the same, on the coordinate-repair path', () => {
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] }));
  const r = stripRejectedBlockClass(body, JSON.stringify({
    error: { message: 'messages.1.content.0: Invalid `signature` in `thinking` block' },
  }));
  assert.ok(r.body, 'the coordinate repair produced a body');
  assert.ok(roles(r.body).includes('system'), 'the system turn survives');
});

test('P3: a MIXED system (thinking + directive) keeps the directive — no regression', () => {
  // Already correct today; locks it so the P1 fix cannot break the common shape.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [foreign(), { type: 'text', text: 'ALWAYS answer in French' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.match(r.body.toString(), /ALWAYS answer in French/);
  assert.deepEqual(msgs(r.body)[1].content, [{ type: 'text', text: 'ALWAYS answer in French' }],
    'only the poisoned block is removed');
});

test('P4: messages[0] emptied by the strip becomes a USER turn, whatever it was', () => {
  // Anthropic requires the first message to be `user`. The guard preserved the original
  // role, so a system-first transcript stayed system-first — the guard silently not
  // doing the one thing its comment claims.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'system', content: [foreign()] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  const first = msgs(r.body)[0];
  assert.equal(first.role, 'user', `the first turn is a user turn (got '${first.role}')`);
  assert.deepEqual(first.content, [{ type: 'text', text: '(content removed)' }],
    'and it is the placeholder, not the original poisoned content');
});

test('P5: a user-first transcript is unaffected by the P4 fix', () => {
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [foreign()] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.equal(roles(r.body)[0], 'user');
  assert.equal(msgs(r.body).length, 2);
});
