import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __serverTest } from '../src/server.js';

const { stripForeignThinkingBlocks, detectTranscriptOrigin } = __serverTest;

// The exact shape of the 2026-11-06 "customer fups" incident: GLM authored an
// `mcp_tool_use` (webReader, `call_…` id) on an assistant turn and placed the
// `mcp_tool_result` on the FOLLOWING ASSISTANT turn — the plain Messages API rejects
// the block type outright and the mcp beta rejects the mis-roled pair (measured live).
// Conversion to text is accepted (count_tokens 200, 2026-11-06).
const MCP_USE = { type: 'mcp_tool_use', id: 'call_76647c971f9d4ea6a9d64f43', name: 'webReader', server_name: 'web_reader', input: { url: 'https://dubner.io' } };
const MCP_RES = { type: 'mcp_tool_result', tool_use_id: 'call_76647c971f9d4ea6a9d64f43', content: [{ type: 'text', text: 'Dubner Ventures' }] };

function incidentBody() {
  return JSON.stringify({
    model: 'claude-opus-4-5',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'read dubner.io' }] },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'plan', signature: 'glmhexsig' }, { type: 'text', text: 'Reading.' }, MCP_USE] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_OK1', content: 'ok' }] },
      { role: 'assistant', content: [MCP_RES, { type: 'text', text: 'Done.' }] },
      { role: 'user', content: [{ type: 'text', text: 'summarise' }] },
    ],
  });
}

test('a GLM mcp_tool_use + mis-roled mcp_tool_result pair is converted to text', () => {
  const { body: out, removed, converted } = stripForeignThinkingBlocks(incidentBody());
  assert.ok(out, 'repair produces a body');
  assert.equal(removed, 1, 'the foreign thinking block is stripped');
  assert.equal(converted, 2, 'the mcp call AND its result are converted');
  const s = out.toString();
  assert.ok(!s.includes('mcp_tool_use'), 'no foreign mcp call survives');
  assert.ok(!s.includes('mcp_tool_result'), 'no foreign mcp result survives');
  assert.ok(/\[called webReader \(web_reader\) on .*dubner\.io/.test(s), 'call becomes labelled text');
  assert.ok(/\[mcp tool result: .*Dubner Ventures/.test(s), 'result keeps what the tool found');
  assert.ok(s.includes('toolu_OK1'), "Claude's own client tool wiring is untouched");
});

test('the converted body passes detectTranscriptOrigin — the pin can never re-latch', () => {
  const { body: out } = stripForeignThinkingBlocks(incidentBody());
  const verdict = detectTranscriptOrigin(JSON.parse(out));
  assert.equal(verdict.anthropicIncompatible, false, 'repaired transcript is Claude-replayable');
});

test("an ANTHROPIC mcp_tool_use (toolu_/srvtoolu_ id) is never touched", () => {
  const body = JSON.stringify({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [{ type: 'mcp_tool_use', id: 'toolu_native1', name: 'search', server_name: 's', input: { q: 'x' } }] },
      { role: 'user', content: [{ type: 'mcp_tool_result', tool_use_id: 'toolu_native1', content: [{ type: 'text', text: 'found' }] }] },
    ],
  });
  assert.deepEqual(stripForeignThinkingBlocks(body), { body: null, removed: 0, converted: 0 });
});

test('an mcp_tool_use id a client tool_use also owns is not converted (orphan guard)', () => {
  const body = JSON.stringify({
    messages: [
      { role: 'user', content: 'x' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'call_collision1', name: 'Bash', input: {} },
        { type: 'mcp_tool_use', id: 'call_collision1', name: 'webReader', server_name: 'w', input: {} },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_collision1', content: 'ok' }] },
    ],
  });
  const { body: out, converted } = stripForeignThinkingBlocks(body);
  assert.equal(converted, 0, 'collision id is left alone');
  assert.equal(out, null);
});

// F1/F3 fixtures: the two verbatim 400 shapes captured live on 2026-11-06.
const PLAIN_400 = `messages.1.content.1: Input tag 'mcp_tool_use' found using 'type' does not match any of the expected tags: 'bash_code_execution_tool_result', 'code_execution_tool_result', 'connector_text', 'server_tool_use', 'text', 'thinking', 'tool_result', 'tool_use'`;
const BETA_400 = 'messages.1: `mcp_tool_use` with id `call_76647c` was found without a corresponding `mcp_tool_result` block';

test('F3: isAnthropicIncompatBody matches BOTH verbatim MCP 400 shapes, not just the server_tool_use accident', () => {
  const { isAnthropicIncompatBody: m } = __serverTest;
  assert.equal(m(PLAIN_400), true, 'plain-API unknown-tag rejection trips the detector');
  assert.equal(m(BETA_400), true, 'mcp-beta mis-roled pair trips the detector');
  assert.equal(m("messages.2: unknown field 'mcp_tool_use_config'"), false, "a shape mentioning mcp_tool_use that isn't either verbatim pattern does not");
  assert.equal(m('user asked about mcp_tool_result blocks in prose'), false, 'prose mention alone does not');
});

test('F1: detectTranscriptOrigin flags the foreign mcp pair pre-repair and clears post-repair', () => {
  const raw = JSON.parse(incidentBody());
  const before = detectTranscriptOrigin(raw);
  assert.equal(before.anthropicIncompatible, true, 'the UNCONVERTED incident body is predicted incompatible (drives the up-front pre-strip)');
  assert.equal(before.homeProvider, 'zai');
  const { body: out } = stripForeignThinkingBlocks(incidentBody());
  const after = detectTranscriptOrigin(JSON.parse(out));
  assert.equal(after.anthropicIncompatible, false, 'the converted body is clean — pin can never latch');
});

test('M1: a 300-char cut never splits a surrogate pair (emoji at the boundary)', () => {
  // Fixture self-check: emoji must sit at CODE POINT 299 of the stringified input so
  // a raw .slice(0,300) keeps its high surrogate and drops its low half.
  const use = { type: 'mcp_tool_use', id: 'call_m1', name: 'webReader', server_name: 'w', input: { text: 'a'.repeat(290) + '🙂tail' } };
  const inp = JSON.stringify(use.input);
  assert.equal(Array.from(inp).indexOf('🙂'), 299, 'fixture places the emoji exactly at the cut boundary');
  const res = { type: 'mcp_tool_result', tool_use_id: 'call_m1', content: [{ type: 'text', text: 'a'.repeat(290) + '🎉tail' }] };
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: [use] },
    { role: 'assistant', content: [res] },
  ] });
  const { body: out, converted } = stripForeignThinkingBlocks(body);
  assert.equal(converted, 2);
  for (const m of JSON.parse(out).messages) {
    for (const b of m.content) {
      if (b.type !== 'text') continue;
      for (let i = 0; i < b.text.length; i++) {
        const c = b.text.charCodeAt(i);
        if (c >= 0xD800 && c <= 0xDBFF) { const n = b.text.charCodeAt(i + 1); assert.ok(n >= 0xDC00 && n <= 0xDFFF, `high surrogate at ${i} is followed by a LOW surrogate`); i++; }
        if (c >= 0xDC00 && c <= 0xDFFF) { const pv = b.text.charCodeAt(i - 1); assert.ok(pv >= 0xD800 && pv <= 0xDBFF, `low surrogate at ${i} is preceded by a HIGH surrogate`); }
      }
    }
  }
});

test('M6: a plain-string mcp_tool_result keeps its content', () => {
  const use = { type: 'mcp_tool_use', id: 'call_m6', name: 'webReader', server_name: 'w', input: {} };
  const res = { type: 'mcp_tool_result', tool_use_id: 'call_m6', content: 'error: page blocked' };
  const body = JSON.stringify({ messages: [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: [use] },
    { role: 'assistant', content: [res] },
  ] });
  const { body: out, converted } = stripForeignThinkingBlocks(body);
  assert.equal(converted, 2);
  assert.ok(out.toString().includes('error: page blocked'), 'string content survives');
});
