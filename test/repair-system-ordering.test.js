// Anthropic (2026-08) accepts a mid-array `system` message under one constraint, stated
// verbatim in its own 400:
//   "role 'system' must precede an 'assistant' message or end the array; the
//    directive-only form (content: [] with output_config) is accepted at any position"
//
// maxpool's transcript repairs DROP a turn whose content strips empty. When the dropped
// turn is the assistant anchoring a preceding system, that system is orphaned and the
// NEXT request 400s — the repair converts a recoverable error into an unrecoverable one.
//
// Production 2026-08-24: 06:12:13.278Z "stripped 21 provider thinking block(s)" →
// 06:12:13.835Z "messages.58: role 'system' must precede an 'assistant' message…".
// 4 occurrences in one day on mk@dubner.io.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { stripForeignThinkingBlocks, stripRejectedBlockClass } = __serverTest;

const roles = buf => JSON.parse(buf).messages.map(m => m.role);
const foreignThinking = () => ({ type: 'thinking', thinking: 'x', signature: 'foreign-sig' });

/** The API's rule, as an assertion: every `system` either ends the array, is followed by
 *  an `assistant`, or is the directive-only form (`content: []`) which is legal at ANY
 *  position. The exemption is ENCODED, not just described — a helper that flags a legal
 *  directive-only system would drive a "fix" that mutates a transcript the API accepts. */
function assertSystemOrdering(buf, label) {
  const msgs = JSON.parse(buf).messages;
  msgs.forEach((m, i) => {
    if (m.role !== 'system') return;
    if (Array.isArray(m.content) && m.content.length === 0) return;   // directive-only
    const last = i === msgs.length - 1;
    assert.ok(last || msgs[i + 1]?.role === 'assistant',
      `${label}: system at ${i} is followed by '${msgs[i + 1]?.role}' — must be 'assistant' or end the array (got ${JSON.stringify(msgs.map(x => x.role))})`);
  });
}

test('S1: stripping an assistant turn must not orphan the system before it', () => {
  // The exact production shape: the assistant that anchors the system is thinking-only,
  // so the strip empties it and the old code dropped it outright.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'a load-bearing directive' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.ok(r.body, 'the repair produced a body');
  assertSystemOrdering(r.body, 'stripForeignThinkingBlocks');
  // Without this, DROPPING the system passes the ordering walk (it iterates `system`
  // entries; zero entries = zero assertions) — i.e. the wrong fix would look correct.
  assert.ok(roles(r.body).includes('system'), 'the system is re-anchored, not deleted');
});

test('S2: the same hazard in the rejected-block repair path', () => {
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'directive' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripRejectedBlockClass(body, JSON.stringify({
    error: { message: 'messages.2.content.0: Invalid `signature` in `thinking` block' },
  }));
  assert.ok(r.body, 'the coordinate repair produced a body — a bail-out would pass the ordering check vacuously');
  assertSystemOrdering(r.body, 'stripRejectedBlockClass');
  assert.ok(roles(r.body).includes('system'), 'and the system survives');
});

test('S3: a system left LAST after repair is legal — do not "fix" it away', () => {
  // "…or end the array". Dropping a trailing system would silently discard a directive
  // that the API accepts as-is.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'system', content: [{ type: 'text', text: 'trailing directive' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.ok(r.body);
  assertSystemOrdering(r.body, 'trailing system');
  assert.ok(roles(r.body).includes('system'), 'the trailing directive survives the repair');
  // "…or end the array" — a trailing system is ALREADY legal, so the pass must add
  // nothing. Without this, appending a needless placeholder still ends the array
  // legally and the ordering walk stays green (mutation-verified 2026-08-24).
  assert.deepEqual(roles(r.body), ['user', 'system'], 'no synthetic turn after a legal trailing system');
  assert.doesNotMatch(r.body.toString(), /\(content removed\)/);
});

test('S4: the directive itself survives — a repair must not silently delete instructions', () => {
  // Dropping the orphaned system would satisfy the API and change the user's session
  // behaviour with no signal. Whatever the fix does, the directive text stays.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'ALWAYS answer in French' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.match(r.body.toString(), /ALWAYS answer in French/, 'the directive is not silently dropped');
});

test('S5: no system in the transcript → the re-anchor pass changes NOTHING', () => {
  // The fix must not perturb the overwhelmingly common shape.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [foreignThinking(), { type: 'text', text: 'kept' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  // Deep-equal against the exact expected array, not just roles: a pass that cloned,
  // reordered or inserted blocks would slip through a roles-only assertion.
  assert.deepEqual(JSON.parse(r.body).messages, [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'kept' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ]);
  assert.equal(r.removed, 1);
});

// ── The shapes a fix keyed only on the obvious case would miss (red team, 2026-08-24) ──

test('S6: a STRING-content system is orphaned too — array-content is not the trigger', () => {
  // `{role:'system', content:'be brief'}` early-returns from the strip loop untouched,
  // so a fix that inspects only array-content messages never sees it — yet the assistant
  // after it is still dropped and the system still orphaned.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: 'be brief' },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assertSystemOrdering(r.body, 'string-content system');
  assert.match(r.body.toString(), /be brief/, 'the directive survives');
});

test('S7: TWO consecutive emptied assistants after a system', () => {
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'directive' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assertSystemOrdering(r.body, 'double drop');
});

test('S8: an already-legal transcript gets NO placeholder (no over-firing)', () => {
  // [user, system, assistant(thinking-only), assistant(text)] → the second assistant
  // survives and still anchors the system. Inserting anyway would pad every transcript.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'directive' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'assistant', content: [{ type: 'text', text: 'real reply' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.deepEqual(roles(r.body), ['user', 'system', 'assistant'], 'no synthetic turn added');
  assert.doesNotMatch(r.body.toString(), /\(content removed\)/);
});

test('S9: the directive-only form is legal ANYWHERE — never re-anchored', () => {
  // "the directive-only form (content: [] with output_config) is accepted at any
  // position". A naive "system must be followed by assistant" pass mutates this.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [], output_config: { format: 'json' } },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const r = stripForeignThinkingBlocks(body);
  assert.deepEqual(roles(r.body), ['user', 'system', 'user'], 'left exactly as sent');
  assert.doesNotMatch(r.body.toString(), /\(content removed\)/, 'no placeholder for a legal shape');
});

test('S12: IDEMPOTENT — the latched re-strip runs every turn and must not grow the array', () => {
  // markSessionThinkingContaminated makes the pre-strip run on EVERY later turn. A pass
  // that appends a placeholder each time would grow the transcript without bound.
  const body = Buffer.from(JSON.stringify({ messages: [
    { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    { role: 'system', content: [{ type: 'text', text: 'directive' }] },
    { role: 'assistant', content: [foreignThinking()] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ] }));
  const once = stripForeignThinkingBlocks(body).body;
  const twice = stripForeignThinkingBlocks(once);
  // Second pass finds nothing to strip → returns null (no rewrite), which is itself the
  // idempotency proof; if it did rewrite, the array must be unchanged.
  const final = twice.body || once;
  assert.deepEqual(JSON.parse(final).messages, JSON.parse(once).messages, 'stable under re-run');
});

test('S13: the coordinate path gets the same battery, unconditionally', () => {
  for (const [label, msgs] of [
    ['string-system', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: 'be brief' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
      { role: 'user', content: [{ type: 'text', text: 'n' }] }]],
    ['double-drop', [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'system', content: [{ type: 'text', text: 'd' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: 's' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'y', signature: 's' }] },
      { role: 'user', content: [{ type: 'text', text: 'n' }] }]],
  ]) {
    const r = stripRejectedBlockClass(Buffer.from(JSON.stringify({ messages: msgs })),
      JSON.stringify({ error: { message: 'messages.2.content.0: Invalid `signature` in `thinking` block' } }));
    assert.ok(r.body, `${label}: the coordinate repair produced a body`);
    assertSystemOrdering(r.body, `coordinate/${label}`);
  }
});
