// Every request log line carries [cv <conversation> <terminal>] so a transcript
// turn joins to its serving ACCOUNT exactly (peer audit 2026-11-08: timestamp
// windows cannot separate an account switch from cache expiry).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';

const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const CC = "You are Claude Code, Anthropic's official CLI for Claude.";

test('completion line names the account with [cv <hash> <sess>]', async () => {
  const lines = [];
  const orig = console.log;
  const tui = Object.create(TUI.prototype);
  tui.am = { accounts: [] };
  tui.log = []; tui.running = false; tui.render = () => {}; tui.active = new Map();
  tui._addLog = m => lines.push(m);
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_01X', type: 'message', role: 'assistant', model: 'claude-3-5-haiku',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  const upPort = await listen(up);
  const am = new AccountManager([{ name: 'acct-a', type: 'apikey', apiKey: 'sk', upstream: `http://127.0.0.1:${upPort}` }], 0.9, {});
  const proxy = createProxyServer(am, { proxy: { apiKey: 't' }, upstream: `http://127.0.0.1:${upPort}` }, {
    onRequestStart: (id, i) => tui.onRequestStart(id, i),
    onRequestRouted: (id, i) => tui.onRequestRouted(id, i),
    onRequestEnd: (id, i) => tui.onRequestEnd(id, i),
  });
  const port = await listen(proxy);
  try {
    console.log = () => {};
    await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 't', 'x-maxpool-session': 'term-abcdef-1234' },
      body: JSON.stringify({ model: 'claude-3-5-haiku', max_tokens: 8, system: [{ type: 'text', text: CC }],
        messages: [{ role: 'user', content: 'build X' }] }) });
    const line = lines.find(l => l.includes('→ acct-a') && l.includes('[cv '));
    assert.ok(line, `tagged line present among: ${lines.join(' | ')}`);
    assert.match(line, /\[cv [0-9a-f]{8} term-abc\]/, 'short conversation hash + first 8 of session id');
  } finally { console.log = orig; proxy.close(); up.close(); }
});

test('conversation hash is STABLE across turns (cache_control marker moves, content identical)', async () => {
  const { __serverTest } = await import('../src/server.js');
  const req = { method: 'POST', url: '/v1/messages' };
  const sys = [{ type: 'text', text: CC, cache_control: { type: 'ephemeral' } }];
  const body = (msgs) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5', system: sys, messages: msgs }));
  const turn1 = __serverTest.describeRequest(req, body([{ role: 'user', content: [{ type: 'text', text: 'build X', cache_control: { type: 'ephemeral' } }] }]));
  const turn2 = __serverTest.describeRequest(req, body([
    { role: 'user', content: [{ type: 'text', text: 'build X' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'next', cache_control: { type: 'ephemeral' } }] }]));
  const turn3 = __serverTest.describeRequest(req, body([
    { role: 'user', content: [{ type: 'text', text: 'build X' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    { role: 'user', content: [{ type: 'text', text: 'next' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    { role: 'user', content: [{ type: 'text', text: 'again', cache_control: { type: 'ephemeral' } }] }]));
  assert.ok(turn1.conversationHash && turn1.conversationHash === turn2.conversationHash, `turn1==turn2 (${turn1.conversationHash} vs ${turn2.conversationHash})`);
  assert.equal(turn2.conversationHash, turn3.conversationHash, 'stable on every later turn');
});

test('conversation hash ignores the per-request billing header (live-traffic cause #2, 2026-11-08)', async () => {
  const { __serverTest } = await import('../src/server.js');
  const req = { method: 'POST', url: '/v1/messages' };
  const body = (cch, prev) => Buffer.from(JSON.stringify({ model: 'claude-opus-5-5',
    system: [
      { type: 'text', text: `x-anthropic-billing-header: cc_version=2.1.314.3e7; cch=${cch}; cc_is_subagent=true; cc_prev_req=${prev}; cc_prompt_id=76a20dda;` },
      { type: 'text', text: CC },
    ],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'build X' }] }] }));
  const t1 = __serverTest.describeRequest(req, body('e0527', 'req_011Cgqp9eavYPLre6M8Bighd'));
  const t2 = __serverTest.describeRequest(req, body('39f9e', 'req_011DabcDEFghiJKLmnoPQRS'));
  assert.equal(t1.conversationHash, t2.conversationHash, 'same conversation, different billing checksums → same id');
  const other = __serverTest.describeRequest(req, Buffer.from(JSON.stringify({ model: 'claude-opus-5-5',
    system: [{ type: 'text', text: `x-anthropic-billing-header: cch=39f9e;` }, { type: 'text', text: CC }],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'DIFFERENT task' }] }] })));
  assert.notEqual(t1.conversationHash, other.conversationHash, 'different first message still differs');
});
