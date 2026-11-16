// LINK USAGE TAP (2026-11-15): a link-served response's usage is read off the relayed
// bytes for THIS pool's efficiency figures — and ONLY there. The capacity ledger, the
// account usage counters and the caller token counts are the SERVING pool's to book
// (SC22): the tap must not book a single token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { bootLink, bigBody, postTurn } from './link-fixture.js';
import { __serverTest } from '../src/server.js';

function httpRemote(handler) {
  return http.createServer((req, res) => {
    if (req.url === '/maxpool/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ accounts: [{ name: 'a', type: 'oauth', accountUuid: 'U1', enabled: true, status: 'active', quota: {} }] }));
      return;
    }
    if (req.url !== '/v1/messages') { res.writeHead(404); res.end('{}'); return; }
    handler(req, res);
  });
}

const SSE_USAGE_START = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":1000,"cache_read_input_tokens":180000,"cache_creation_input_tokens":3000}}}\n\n';
const SSE_USAGE_DELTA = 'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":500,"input_tokens":1000,"cache_read_input_tokens":180000}}\n\n';

test('pure helpers: usage from an SSE event and from a JSON body tail', () => {
  const { usageFromSseData, usageFromBodyTail } = __serverTest;
  const start = usageFromSseData(JSON.parse('{"type":"message_start","message":{"usage":{"input_tokens":2}}}'));
  assert.equal(start.input_tokens, 2);
  assert.equal(usageFromSseData(JSON.parse('{"type":"message_delta","usage":{"output_tokens":1}}')).output_tokens, 1);
  assert.equal(usageFromSseData(JSON.parse('{"type":"ping"}')), null);
  const json = `{"id":"m","content":[],"usage":{"input_tokens":7,"output_tokens":3,"cache_read_input_tokens":9}}`;
  assert.equal(usageFromBodyTail(json).cache_read_input_tokens, 9);
  assert.equal(usageFromBodyTail('{"no":"usage"}'), null);
});

test('a link-served stream feeds the request capacity figures and the mirror load event — and books nothing', async () => {
  const remote = httpRemote((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(SSE_USAGE_START + SSE_USAGE_DELTA + 'event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
  });
  const { am, port, cleanup } = await bootLink({ server: remote });
  const row = am.accounts[0];
  const usageBefore = { ...row.usage };
  const callerBefore = am.callerCounts?.get?.('legacy-key');
  try {
    const r = await postTurn(port, bigBody(2_000, true));
    assert.equal(r.status, 200);
    const ev = row.loadEvents.filter(e => e.success).at(-1);
    assert.ok(ev, 'a served load event exists');
    assert.deepEqual(ev.usage, { in: 1000, out: 500, cr: 180000, cc: 3000 }, 'the tap fed the event');
    assert.equal(row.usage.totalInputTokens, usageBefore.totalInputTokens, 'account usage untouched');
    assert.equal(row.usage.totalOutputTokens, usageBefore.totalOutputTokens, 'account usage untouched');
    assert.equal(am.callerCounts?.get?.('legacy-key') ?? callerBefore ?? 0, callerBefore ?? 0, 'caller tokens untouched');
  } finally { await cleanup(); }
});

test('a link-served non-stream body is parsed from its tail', async () => {
  const remote = httpRemote((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 40, output_tokens: 4, cache_read_input_tokens: 440 } }));
    });
  });
  const { am, port, cleanup } = await bootLink({ server: remote });
  const row = am.accounts[0];
  try {
    const r = await postTurn(port, bigBody(2_000, false));
    assert.equal(r.status, 200);
    const ev = row.loadEvents.filter(e => e.success).at(-1);
    assert.deepEqual(ev.usage, { in: 40, out: 4, cr: 440, cc: 0 });
  } finally { await cleanup(); }
});

