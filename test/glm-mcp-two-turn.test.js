import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server, host = '127.0.0.1') {
  return new Promise(resolve => server.listen(0, host, () => resolve(server.address().port)));
}
function close(server) { return new Promise(resolve => server.close(resolve)); }

const MCP_USE = { type: 'mcp_tool_use', id: 'call_76647c971f9d4ea6a9d64f43', name: 'webReader', server_name: 'web_reader', input: { url: 'https://dubner.io' } };
const MCP_RES = { type: 'mcp_tool_result', tool_use_id: 'call_76647c971f9d4ea6a9d64f43', content: [{ type: 'text', text: 'Dubner Ventures' }] };
const PLAIN_400 = `messages.1.content.1: Input tag 'mcp_tool_use' found using 'type' does not match any of the expected tags: 'server_tool_use', 'text', 'thinking', 'tool_result', 'tool_use'`;

const poisoned = [
  { role: 'user', content: [{ type: 'text', text: 'read dubner.io' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'Reading.' }, MCP_USE] },
  { role: 'assistant', content: [MCP_RES, { type: 'text', text: 'Done.' }] },
];
const base = (msgs) => JSON.stringify({ model: 'claude-opus-4-5', max_tokens: 16, messages: msgs });

test('F2: mcp-contaminated session never sends a poisoned body — turn 1 pre-stripped, turn 2 one upstream call', async () => {
  let calls = 0; let sawPoison = 0;
  const upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      calls++;
      if (b.includes('mcp_tool_use')) { sawPoison++; res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: PLAIN_400 } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_011Cx', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }], 0.90);
  const proxy = createProxyServer(am, {
    proxy: { apiKey: 'tc-test' },
    upstream: `http://127.0.0.1:${upstreamPort}`,
    retry: { maxRetryBufferBytes: 1024 * 1024 },
  });
  const proxyPort = await listen(proxy);
  const post = (messages, sess) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': sess },
    body: base(messages),
  });
  try {
    const before = calls;
    const r1 = await post(poisoned, 'f2-sess');
    assert.equal(r1.status, 200, 'turn 1 ends 200');
    assert.equal(sawPoison, 0, 'turn 1: detectTranscriptOrigin predicts the mcp contamination and the pre-strip cures it BEFORE any upstream call — zero 400s');
    assert.equal(calls - before, 1, 'turn 1 makes exactly one upstream call (the repaired body)');

    const before2 = calls;
    const poisoned2 = [...poisoned, { role: 'user', content: [{ type: 'text', text: 'and then?' }] }];
    const r2 = await post(poisoned2, 'f2-sess');
    assert.equal(r2.status, 200);
    assert.equal(calls - before2, 1, 'turn 2 makes exactly ONE upstream call (repaired up front, no 400 round-trip)');
    assert.equal(sawPoison, 0, 'no poisoned body was ever sent on any turn');
  } finally { await close(proxy); await close(upstream); }
});

test('F2 backstop: an UNPREDICTED mcp 400 with nothing convertible is NOT retried or latched — the 400 surfaces once per turn', async () => {
  // Hide the mcp block from detectTranscriptOrigin's walk by nesting it under a key the
  // walker never visits — a stand-in for any future shape the forecast misses. The
  // upstream still rejects it, so this exercises the REACTIVE repair-before-pin branch.
  // Here the reactive repair can't convert the hidden block either. Since review r2
  // (coordinator 2026-11-09) that means NO retry and NO latch: stripping thinking cannot
  // cure an mcp-tag 400, so the retry was a guaranteed identical 400 and the latch only
  // degraded every later turn. (This fixture's upstream also rejects on "thinking" — a
  // mock convenience; the real mcp 400 is about the tag, not the thinking.)
  let calls = 0;
  const upstream = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      calls++;
      const j = JSON.parse(b);
      const hasThinking = JSON.stringify(j.messages).includes('"thinking"');
      if (hasThinking) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: PLAIN_400 } })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_011Cy', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 5, output_tokens: 1 } }));
    });
  });
  const upstreamPort = await listen(upstream);
  const am = new AccountManager([{ name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 }], 0.90);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upstreamPort}`, retry: { maxRetryBufferBytes: 1024 * 1024 } });
  const proxyPort = await listen(proxy);
  // Foreign thinking (unsigned-by-Anthropic) the forecast does NOT flag; the upstream
  // answers with the mcp-wording 400 so ONLY the incompat branch (not the signature
  // branch) can catch it — the before-pin repair strips the thinking and retries.
  const msgs = [
    { role: 'user', content: [{ type: 'text', text: 'q' }] },
    { role: 'assistant', content: [{ type: 'thinking', thinking: 'glm plan', signature: 'glmhex' }, { type: 'text', text: 'a' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
  ];
  const post = (m) => fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'f2b' }, body: base(m),
  });
  try {
    const c0 = calls; const r1 = await post(msgs);
    assert.equal(r1.status, 400, 'turn 1: the original 400 surfaces');
    assert.equal(calls - c0, 1, 'turn 1: one call — no identical retry');
    assert.equal(am.isSessionThinkingContaminated('f2b'), false, 'no latch: later turns keep their thinking');
    assert.equal(am._effectiveIncompatible({ sessionKey: 'f2b' }).incompatible, false, 'session was NOT pinned provider-only');
    const c1 = calls; const r2 = await post([...msgs, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, { role: 'user', content: [{ type: 'text', text: 'more' }] }]);
    assert.equal(r2.status, 400);
    assert.equal(calls - c1, 1, 'turn 2: one call, body untouched (nothing latched)');
  } finally { await close(proxy); await close(upstream); }
});
