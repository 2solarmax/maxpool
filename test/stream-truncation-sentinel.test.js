import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { __serverTest } from '../src/server.js';

const { streamResponse } = __serverTest;

// Reported 2026-08-17: "API Error: JSON Parse error: Unterminated string" in a Claude
// Code session. An upstream that closes mid-event (done=true, no message_stop — z.ai
// dropping a stream often surfaces as a clean FIN) produced a SILENTLY truncated SSE
// body. Claude Code's parser dies on the unterminated JSON. The fix: when the stream
// committed but never saw message_stop, write a terminal error frame so the client
// knows the stream was truncated instead of parsing garbage.

const sseChunk = (obj) => new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);

class FakeRes extends Writable {
  constructor() {
    super();
    this.headersSent = false;
    this.destroyed = false;
    this.chunks = [];
  }
  writeHead(status, headers) { this.headersSent = true; this.status = status; this.headers = headers; }
  // Mirror http.ServerResponse: the first write() implies headers are sent.
  _write(chunk, _enc, cb) { this.headersSent = true; this.chunks.push(Buffer.from(chunk).toString()); cb(null); }
  get text() { return this.chunks.join(''); }
}

const noopAm = { updateUsage() {} };

test('upstream ends mid-event (no message_stop) → terminal error frame written', async () => {
  const upstream = Readable.from([
    sseChunk({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
    // The cut: a partial event WITHOUT its \n\n terminator — the exact shape
    // Claude Code's parser chokes on ("Unterminated string").
    new TextEncoder().encode('data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial json {"unt'),
  ]);
  const webStream = Readable.toWeb(upstream);
  const res = new FakeRes();
  await streamResponse(webStream, res, 200, {}, 0, noopAm, null, {});
  assert.ok(res.headersSent, 'headers committed');
  assert.match(res.text, /event: error/, 'terminal error frame present');
  assert.match(res.text, /closed the stream before the response completed/);
});

test('complete events WITHOUT message_stop (z.ai compat shape) get NO error frame', async () => {
  const upstream = Readable.from([
    sseChunk({ type: 'message_start', message: { usage: { input_tokens: 10 } } }),
    sseChunk({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hello' } }),
  ]);
  const res = new FakeRes();
  await streamResponse(Readable.toWeb(upstream), res, 200, {}, 0, noopAm, null, {});
  assert.doesNotMatch(res.text, /event: error/, 'no spurious error frame on a healthy stream');
});

test('upstream THROWS mid-stream → the error propagates (no silent end)', async () => {
  const upstream = new Readable({ read() {} });
  upstream.push(sseChunk({ type: 'message_start', message: { usage: { input_tokens: 1 } } }));
  process.nextTick(() => upstream.destroy(new Error('fetch failed')));
  const res = new FakeRes();
  await assert.rejects(
    () => streamResponse(Readable.toWeb(upstream), res, 200, {}, 0, noopAm, null, {}),
    /fetch failed/,
  );
});
