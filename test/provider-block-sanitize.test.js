// z.ai rejects an Anthropic-only `tool_reference` content block with
// `[1210] Invalid API parameter`, refusing the WHOLE request — measured 2026-09-13 on the
// owner's real 5.5MB session: 12 such blocks among 1,093 messages killed every turn, and
// the identical body with ONLY those blocks rewritten returned 200 OK.
//
// Not a size/token limit: z.ai has a distinct `[1261] Prompt too long`, and a 34KB body
// carrying the block fails while 5.5MB without it passes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { rewriteBodyForAccount, sanitizeBlocksForProvider } = __serverTest;
const provider = { type: 'provider', name: 'glm max', modelMap: { default: 'glm-5.3' } };
const anthropic = { type: 'oauth', name: 'mk@gomokka' };

const bodyWith = (inner) => Buffer.from(JSON.stringify({
  model: 'claude-opus-5',
  messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'ToolSearch', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: inner }] },
  ],
}));

test('provider: tool_reference becomes text naming the tool', () => {
  const out = JSON.parse(rewriteBodyForAccount(
    bodyWith([{ type: 'tool_reference', tool_name: 'Monitor' }]), provider).toString());
  const inner = out.messages[2].content[0].content[0];
  assert.equal(inner.type, 'text');
  assert.match(inner.text, /Monitor/, 'the tool name must survive — the transcript refers to it');
  assert.equal(JSON.stringify(out).includes('tool_reference'), false);
});

test('provider: every tool_reference in a multi-block result is rewritten', () => {
  const out = JSON.parse(rewriteBodyForAccount(bodyWith([
    { type: 'text', text: 'keep me' },
    { type: 'tool_reference', tool_name: 'A' },
    { type: 'tool_reference', tool_name: 'B' },
  ]), provider).toString());
  const blocks = out.messages[2].content[0].content;
  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].text, 'keep me', 'sibling blocks are untouched');
  assert.deepEqual(blocks.slice(1).map(b => b.type), ['text', 'text']);
  assert.match(blocks[1].text, /A/);
  assert.match(blocks[2].text, /B/);
});

test('anthropic accounts keep tool_reference verbatim', () => {
  const out = JSON.parse(rewriteBodyForAccount(
    bodyWith([{ type: 'tool_reference', tool_name: 'Monitor' }]), anthropic).toString());
  assert.equal(out.messages[2].content[0].content[0].type, 'tool_reference',
    'Anthropic understands the block natively — rewriting it there would be a regression');
});

test('provider rewrite still maps the model', () => {
  const out = JSON.parse(rewriteBodyForAccount(
    bodyWith([{ type: 'tool_reference', tool_name: 'X' }]), provider).toString());
  assert.equal(out.model, 'glm-5.3');
});

test('sanitize leaves ordinary tool_result content alone', () => {
  const json = JSON.parse(bodyWith([{ type: 'text', text: 'plain' }]).toString());
  const before = JSON.stringify(json);
  sanitizeBlocksForProvider(json);
  assert.equal(JSON.stringify(json), before);
});

test('sanitize tolerates string content and missing fields', () => {
  const json = {
    model: 'm',
    messages: [
      { role: 'user', content: 'str' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'str result' }] },
      { role: 'assistant' },
      {},
    ],
  };
  assert.doesNotThrow(() => sanitizeBlocksForProvider(json));
});

test('a tool_reference with no tool_name still becomes valid text', () => {
  const out = JSON.parse(rewriteBodyForAccount(
    bodyWith([{ type: 'tool_reference' }]), provider).toString());
  const inner = out.messages[2].content[0].content[0];
  assert.equal(inner.type, 'text');
  assert.equal(typeof inner.text, 'string');
  assert.ok(inner.text.length > 0);
});
