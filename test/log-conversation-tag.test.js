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
