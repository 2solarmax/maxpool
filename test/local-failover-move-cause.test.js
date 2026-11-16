// Review 2026-11-16, 5b: a move forced by a LOCAL account's 429 (or 529 / 5xx / network
// fault) was booked with no cause -> 'other', which the TUI never printed and the
// forced-moves red signal ignored. A rate-limit / overload move is 'wall'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { listen, close } from './link-fixture.js';

const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":10,"output_tokens":1}}}\n\n'
  + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

test('a move off a rate-limited local account is booked as a forced "wall" move', async () => {
  const served = [];          // which key answered 200, per request
  let walled = null;          // the key that serves turn 1, then 429s
  const upstream = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = req.headers['x-api-key'];
      if (walled == null) walled = key;
      else if (key === walled) {
        res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'limit' } }));
        return;
      }
      served.push(key);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE);
    });
  });
  const upPort = await listen(upstream);
  const am = new AccountManager([
    { name: 'k1', type: 'apikey', apiKey: 'key-1' },
    { name: 'k2', type: 'apikey', apiKey: 'key-2' },
  ], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: 'tc-test' }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  const body = JSON.stringify({ model: 'claude-opus-5-5', stream: true, system: 'sys', messages: [{ role: 'user', content: 'hello there' }] });
  const post = async () => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'sess-1' },
    });
    await r.text();
    return r.status;
  };
  try {
    assert.equal(await post(), 200, 'turn 1 served');
    assert.equal(await post(), 200, 'turn 2 served after the move');
    assert.equal(served.length, 2);
    assert.notEqual(served[1], walled, 'turn 2 moved off the walled account');
    const c = am.efficiencyOverall('last15m').claude;
    assert.equal(c.moved, 1, `one move booked (got ${c.moved})`);
    assert.equal(c.movedByCause.wall, 1, `booked as wall, not other: ${JSON.stringify(c.movedByCause)}`);
    assert.equal(c.movedByCause.other, 0);
  } finally { await close(proxy); await close(upstream); }
});
