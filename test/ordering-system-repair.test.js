// ORDERING-SYSTEM REPAIR (2026-09-23). Anthropic changed the mid-conversation system
// rule (Sep: "must follow a 'user' message or an 'assistant' ending in a server tool
// result; directive-only form accepted at any position"). The CLI legitimately emits
// mid-conversation system messages (compaction boundaries), so ordinary long sessions
// started 400ing at messages.NNN. The repair converts an offending system to the
// directive-only form — nothing dropped, nothing orphaned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';
const { directiveOnlySystemMessages } = __serverTest;

const T = (t) => ({ type: 'text', text: t });

test('system after text-assistant violates the Sep rule → converted to directive-only', () => {
  const msgs = [
    { role: 'user', content: [T('hi')] },
    { role: 'assistant', content: [T('answer')] },
    { role: 'system', content: [T('directive')] },
    { role: 'user', content: [T('next')] },
  ];
  const r = directiveOnlySystemMessages(msgs);
  assert.equal(r.converted, 1);
  const sys = r.messages[2];
  assert.deepEqual(sys.content, [], 'directive-only: empty content');
  assert.equal(sys.output_config.directives, 'directive', 'text preserved');
  assert.equal(r.messages[2].role, 'system', 'role preserved');
});

test('legal placements are untouched (after user / start / directive-only / after server-tool-result)', () => {
  const msgs = [
    { role: 'user', content: [T('a')] },
    { role: 'system', content: [T('legal: after user')] },
    { role: 'user', content: [T('b')] },
    { role: 'assistant', content: [{ type: 'server_tool_result', content: [] }] },
    { role: 'system', content: [T('legal: after tool-result assistant')] },
    { role: 'user', content: [T('c')] },
    { role: 'system', content: [] }, // already directive-only
    { role: 'user', content: [T('d')] },
  ];
  const r = directiveOnlySystemMessages(msgs);
  assert.equal(r.converted, 0, 'no false positives');
  assert.deepEqual(r.messages, msgs);
});

test('coordinate-driven: only the named index converts', () => {
  const msgs = [
    { role: 'user', content: [T('a')] },
    { role: 'assistant', content: [T('x')] },
    { role: 'system', content: [T('first offender')] },
    { role: 'assistant', content: [T('y')] },
    { role: 'system', content: [T('second offender')] },
    { role: 'user', content: [T('z')] },
  ];
  const r = directiveOnlySystemMessages(msgs, 2);
  assert.equal(r.converted, 1);
  assert.deepEqual(r.messages[2].content, []);
  assert.equal(r.messages[4].content[0].text, 'second offender', 'untouched');
});

test('idempotent: a second run converts nothing', () => {
  const msgs = [
    { role: 'user', content: [T('a')] },
    { role: 'assistant', content: [T('x')] },
    { role: 'system', content: [T('offender')] },
    { role: 'user', content: [T('b')] },
  ];
  const r1 = directiveOnlySystemMessages(msgs);
  const r2 = directiveOnlySystemMessages(r1.messages);
  assert.equal(r2.converted, 0);
});

test('multi-block system text joins into one directive string', () => {
  const msgs = [
    { role: 'user', content: [T('a')] },
    { role: 'assistant', content: [T('x')] },
    { role: 'system', content: [T('part one'), T('part two')] },
    { role: 'user', content: [T('b')] },
  ];
  const r = directiveOnlySystemMessages(msgs);
  assert.equal(r.messages[2].output_config.directives, 'part one\npart two');
});

test('the LAST block decides for a tool-result assistant (text after tool-result violates)', () => {
  // Kills a mutant reading content[0] instead of the last block: the rule is the
  // assistant must END IN a server tool result, so tool-result-then-text is a violation.
  const msgs = [
    { role: 'user', content: [T('a')] },
    { role: 'assistant', content: [{ type: 'server_tool_result', content: [] }, T('trailing text')] },
    { role: 'system', content: [T('offender')] },
    { role: 'user', content: [T('b')] },
  ];
  const r = directiveOnlySystemMessages(msgs);
  assert.equal(r.converted, 1, 'assistant ending in TEXT does not anchor a system');
  assert.deepEqual(r.messages[2].content, []);
});

test('a system at index 0 is left alone (first-message rules own it, not this repair)', () => {
  // Kills a mutant dropping the i===0 guard: converting messages[0] would fight the
  // separate first-message-must-be-user guard and mask its real defect.
  const msgs = [
    { role: 'system', content: [T('leading system')] },
    { role: 'user', content: [T('a')] },
  ];
  const r = directiveOnlySystemMessages(msgs);
  assert.equal(r.converted, 0);
  assert.equal(r.messages[0].content[0].text, 'leading system', 'untouched');
});


// ── 2026-09-25: the two live defects from the desktop-app test ───────────────
// 1. STRING content was silently dropped (directives: "") — the common CLI shape.
// 2. Some accounts reject the output_config FIELD itself; the repair must fold the
//    directive into a plain assistant turn rather than surface the 400.

test('string-form system content is preserved in the directive (not emptied)', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'system', content: 'mid-conversation reminder' },   // STRING — the real shape
    { role: 'user', content: 'go' },
  ];
  const { messages, converted } = directiveOnlySystemMessages(msgs, 2);
  assert.equal(converted, 1);
  assert.equal(messages[2].output_config.directives, 'mid-conversation reminder',
    'the text must survive the conversion');
});

test('array-form system content is still extracted block-wise', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    { role: 'system', content: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] },
    { role: 'user', content: 'go' },
  ];
  const { messages, converted } = directiveOnlySystemMessages(msgs, 2);
  assert.equal(converted, 1);
  assert.equal(messages[2].output_config.directives, 'line one\nline two');
});

test('a directive-only system mid-array folds to a plain assistant turn on rejection', () => {
  // Simulate exactly what the request path does when an account 400s the field itself:
  const orig = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
    { role: 'system', content: 'keep me' },
    { role: 'user', content: 'c' },
  ];
  const { messages } = directiveOnlySystemMessages(orig, 2);
  // the fold from the request path, verbatim shape:
  let folded = 0;
  const out = messages.map((m, i, arr) => {
    if (m?.role !== 'system' || !('output_config' in m)) return m;
    if (i === arr.length - 1) return m;
    folded++;
    return { role: 'assistant', content: [{ type: 'text', text: String(m.output_config.directives) }] };
  });
  assert.equal(folded, 1);
  assert.equal(out[2].role, 'assistant');
  assert.equal(out[2].content[0].text, 'keep me', 'the directive text is preserved, not dropped');
  assert.ok(!('output_config' in out[2]), 'the field the account rejects is gone');
});

test('an end-of-array directive-only system is left alone in the fold', () => {
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: [] },
    { role: 'system', content: [], output_config: { directives: 'tail' } },
  ];
  const out = messages.map((m, i, arr) => {
    if (m?.role !== 'system' || !('output_config' in m)) return m;
    if (i === arr.length - 1) return m;
    return m;
  });
  assert.equal(out[2].role, 'system', 'tail system is legal everywhere — untouched');
});
