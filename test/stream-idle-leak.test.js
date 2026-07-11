import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { __serverTest } from '../src/server.js';

const { streamResponse } = __serverTest;

// Minimal mock http response.
function mockRes() {
  const listeners = {};
  return {
    headersSent: false, destroyed: false, writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() { return true; },
    end() { this.writableEnded = true; },
    once(ev, cb) { (listeners[ev] ||= []).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== cb); },
    emit(ev) { (listeners[ev] || []).forEach(cb => cb()); },
  };
}
const mockAM = { updateUsage() {}, updateQuota() {}, markThinkingProtected() {}, markSessionIncompatible() {} };

// The idle timer is unref'd (in prod the live socket keeps the loop alive); in this
// harness there's no socket, so hold a ref'd keepalive while awaiting.
async function withKeepAlive(fn) {
  const ka = setInterval(() => {}, 10_000);
  try { return await fn(); } finally { clearInterval(ka); }
}

// ── the leak: a half-open upstream (headers, then silence) must NOT hang forever ──

test('a stalled upstream stream throws UPSTREAM_IDLE within the idle window (lease can free)', async () => withKeepAlive(async () => {
  // A stream that emits nothing and never closes → reader.read() blocks forever.
  const hung = new ReadableStream({ start() { /* never enqueue, never close */ } });
  const res = mockRes();
  const t0 = Date.now();
  await assert.rejects(
    streamResponse(hung, res, 200, {}, 0, mockAM, null, {}, 60),
    (err) => err.code === 'UPSTREAM_IDLE',
    'must reject with UPSTREAM_IDLE so the caller (isTransient) frees the lease + ends the client SSE',
  );
  assert.ok(Date.now() - t0 < 2000, 'fired on the idle timer, not blocked forever');
}));

test('a client disconnect during a blocked read cancels the reader and returns (no hang)', async () => withKeepAlive(async () => {
  let canceled = false;
  const hung = new ReadableStream({ cancel() { canceled = true; } });
  const res = mockRes();
  const p = streamResponse(hung, res, 200, {}, 0, mockAM, null, {}, 60_000); // long idle — close must drive it
  await new Promise(r => setTimeout(r, 20));
  res.destroyed = true;
  res.emit('close'); // → onClose → reader.cancel() → pending read resolves done → loop breaks
  await p; // resolves (does not hang, does not reject)
  assert.equal(canceled, true, 'reader was canceled on client close');
}));

test('a healthy stream completes normally — no idle throw, chunk forwarded', async () => withKeepAlive(async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'));
      c.close();
    },
  });
  const res = mockRes();
  let wrote = false;
  res.write = () => { wrote = true; return true; };
  await streamResponse(stream, res, 200, {}, 0, mockAM, null, {}, 60);
  assert.ok(wrote, 'forwarded the chunk');
  assert.equal(res.writableEnded, true, 'ended the response cleanly');
}));

test('the idle timer RESETS per chunk — a slow-but-alive stream is not cut', async () => withKeepAlive(async () => {
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      // 4 chunks, 40ms apart, with a 120ms idle window → each gap (40ms) < idle → survives.
      for (let i = 0; i < 4; i++) { c.enqueue(enc.encode(`: ping ${i}\n\n`)); await new Promise(r => setTimeout(r, 40)); }
      c.close();
    },
  });
  const res = mockRes();
  await assert.doesNotReject(
    streamResponse(stream, res, 200, {}, 0, mockAM, null, {}, 120),
    'a stream that keeps sending (gap < idle) must not trip the idle timeout',
  );
  assert.equal(res.writableEnded, true);
}));
