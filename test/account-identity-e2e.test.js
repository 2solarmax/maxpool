// End-to-end: the pool's outbound request to upstream carries the account's device id
// and the one machine profile — not the sending person's install (the z.ai risk-notice
// fix, 2026-11-07). Exercises the REAL proxy handler, not the helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

const seen = [];
function listen(s) { return new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port))); }

test('outbound request presents one fixed identity; config off → verbatim', async () => {
  // Upstream stub captures headers + body per request.
  const up = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => {
    seen.push({ headers: { ...req.headers }, body: b });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-3-5-haiku',
      content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  }); });
  const upPort = await listen(up);

  const mkAcct = (name, uuid) => ({ name, type: 'apikey', apiKey: 'sk-ant-x', accountUuid: uuid,
    upstream: `http://127.0.0.1:${upPort}` });
  // ONE account so both requests must present the SAME identity; per-account distinctness
  // is covered by the unit test (stable per account, differs across accounts).
  const am = new AccountManager([mkAcct('acct-a', 'U-A')], 0.9, { routingMode: 'balance' });
  const cfg = { proxy: { apiKey: 't-key' }, upstream: `http://127.0.0.1:${upPort}`, accountIdentity: true };
  const proxy = createProxyServer(am, cfg);
  const port = await listen(proxy);

  const post = (device, os) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 't-key',
      'user-agent': 'claude-cli/2.1.319 (external, sdk-cli)', 'x-stainless-os': os, 'x-stainless-arch': 'arm64' },
    body: JSON.stringify({ model: 'claude-3-5-haiku', max_tokens: 8,
      metadata: { user_id: JSON.stringify({ device_id: device, account_uuid: '', session_id: 'sess-1' }) },
      messages: [{ role: 'user', content: 'hi' }] }) }).then(r => r.status);

  assert.equal(await post('INSTALL-A-max-mac', 'MacOS'), 200);
  assert.equal(await post('INSTALL-B-windows-box', 'Windows'), 200);

  const ids = seen.map(r => JSON.parse(JSON.parse(r.body).metadata.user_id).device_id);
  const oss = seen.map(r => r.headers['x-stainless-os']);
  assert.notEqual(ids[0], 'INSTALL-A-max-mac', 'install id must not pass through');
  assert.equal(ids[0], ids[1], 'both requests present the same identity');
  assert.deepEqual(oss, ['MacOS', 'MacOS'], 'machine profile pinned');
  assert.match(seen[0].headers['user-agent'], /^claude-cli\//, 'UA still a claude-cli one');

  // Off switch: identity passes through verbatim.
  const proxy2 = createProxyServer(am, { ...cfg, accountIdentity: false });
  const port2 = await listen(proxy2);
  seen.length = 0;
  await fetch(`http://127.0.0.1:${port2}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json',
    'x-api-key': 't-key', 'user-agent': 'claude-cli/2.1.319 (external, sdk-cli)', 'x-stainless-os': 'Linux' },
    body: JSON.stringify({ model: 'claude-3-5-haiku', max_tokens: 8,
      metadata: { user_id: JSON.stringify({ device_id: 'RAW-INSTALL', account_uuid: '', session_id: 's' }) },
      messages: [{ role: 'user', content: 'hi' }] }) });
  assert.equal(JSON.parse(JSON.parse(seen[0].body).metadata.user_id).device_id, 'RAW-INSTALL');
  assert.equal(seen[0].headers['x-stainless-os'], 'Linux');

  proxy.close(); proxy2.close(); up.close();
});
