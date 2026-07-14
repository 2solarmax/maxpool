import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReadableStream } from 'node:stream/web';
import { __serverTest } from '../src/server.js';

const { streamResponse, startIdleRequestReaper } = __serverTest;

// A fake interval clock so the reaper can be driven deterministically without wall time.
function fakeClock() {
  let t = 0; const tasks = [];
  return {
    now: () => t,
    setIntervalFn: (fn, ms) => { const task = { fn, ms, next: ms }; tasks.push(task); return { _task: task, unref() {} }; },
    advance(ms) {
      t += ms;
      for (const task of tasks) while (t >= task.next) { task.next += task.ms; task.fn(); }
    },
  };
}

// ── the backstop reaper: idle-keyed via bytesWritten, never age-keyed ──────────

test('reaper force-aborts a request making ZERO write progress past the idle window', () => {
  const clk = fakeClock();
  let destroyed = false;
  const res = { socket: { bytesWritten: 0 }, writableEnded: false, destroyed: false, destroy() { destroyed = true; this.destroyed = true; } };
  startIdleRequestReaper(res, 1, 10_000, clk);
  clk.advance(9_000);
  assert.equal(destroyed, false, 'not yet — inside the idle window');
  clk.advance(2_000); // 11s total, no bytes written
  assert.equal(destroyed, true, 'stuck request (no write progress) is reaped');
});

test('reaper NEVER trips a heartbeating hold (bytesWritten advances) — the legit 24h/7d hold', () => {
  const clk = fakeClock();
  let destroyed = false;
  const res = { socket: { bytesWritten: 0 }, writableEnded: false, destroyed: false, destroy() { destroyed = true; } };
  startIdleRequestReaper(res, 2, 10_000, clk);
  // Simulate an SSE heartbeat advancing the socket every 8s for a "long" hold.
  for (let i = 0; i < 20; i++) { res.socket.bytesWritten += 30; clk.advance(8_000); }
  assert.equal(destroyed, false, 'a heartbeating hold advances bytesWritten → its idle clock resets → never reaped');
});

test('reaper does NOT destroy an already-finished response', () => {
  const clk = fakeClock();
  let destroyed = false;
  const res = { socket: { bytesWritten: 0 }, writableEnded: true, destroyed: false, destroy() { destroyed = true; } };
  startIdleRequestReaper(res, 3, 10_000, clk);
  clk.advance(30_000);
  assert.equal(destroyed, false, 'writableEnded → nothing to abort');
});
const mockAM = { updateUsage() {}, updateQuota() {}, markThinkingProtected() {}, markSessionIncompatible() {}, markSessionThinkingProtected() {} };

// A ref'd keepalive so the process loop stays alive while we observe a would-be
// hang (the drain/idle timers are unref'd; in prod the live server socket refs it).
async function withKeepAlive(fn) {
  const ka = setInterval(() => {}, 10_000);
  try { return await fn(); } finally { clearInterval(ka); }
}

// A response whose kernel send buffer is FULL (write→false → backpressure branch),
// with controllable drain behavior. Half-open case (drainEachEpisodeAfterMs=null)
// emits NEITHER 'drain' nor 'close' — the vanished-peer condition.
function backpressuredRes({ drainEachEpisodeAfterMs = null } = {}) {
  const listeners = {};
  const res = {
    headersSent: false, destroyed: false, writableEnded: false,
    writeHead() { this.headersSent = true; },
    write() {
      // A healthy-but-slow client drains shortly after each backpressure episode.
      if (drainEachEpisodeAfterMs != null) {
        const t = setTimeout(() => res.emit('drain'), drainEachEpisodeAfterMs);
        t.unref?.();
      }
      return false; // buffer full → streamResponse enters the backpressure await
    },
    end() { this.writableEnded = true; },
    once(ev, cb) { (listeners[ev] ||= []).push(cb); },
    off(ev, cb) { if (listeners[ev]) listeners[ev] = listeners[ev].filter(f => f !== cb); },
    emit(ev) { (listeners[ev] || []).splice(0).forEach(cb => cb()); },
  };
  return res;
}

// ── the leak: a half-open client (no drain, no close) must NOT hang forever ────

test('a backpressured HALF-OPEN client (no drain, no close) is bounded — streamResponse settles, never hangs', async () => withKeepAlive(async () => {
  const enc = new TextEncoder();
  // Healthy, always-producing upstream → the read-idle guard never trips; the ONLY
  // thing that can hang is the client-side backpressure await.
  const stream = new ReadableStream({ pull(c) { c.enqueue(enc.encode(': ping\n\n')); } });
  const res = backpressuredRes(); // never emits drain or close

  const outcome = await Promise.race([
    // idleMs=150ms → the drain-stall bound (CLIENT_DRAIN_MS is min-floored at 5s in
    // prod, but streamResponse's idleMs param is what the drain race uses here).
    streamResponse(stream, res, 200, {}, 0, mockAM, null, {}, 150)
      .then(() => 'settled', () => 'settled'),
    new Promise(r => setTimeout(() => r('HUNG'), 2000)),
  ]);

  assert.equal(outcome, 'settled', 'the drain-stall must be bounded, not an unbounded await (else the lease + onRequestEnd leak forever)');
  assert.ok(res.writableEnded, 'the finally ran res.end() — the request completed and its lease/onRequestEnd released');
}));

// ── the guard against over-correction: a legit slow client must NOT be cut ─────

test('a healthy slow client that DOES drain within the window is not cut off', async () => withKeepAlive(async () => {
  const enc = new TextEncoder();
  let chunks = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (chunks++ >= 3) { c.close(); return; }
      c.enqueue(enc.encode(': ping\n\n'));
    },
  });
  // Client is briefly backpressured but drains after 50ms every episode (< 150ms bound).
  const res = backpressuredRes({ drainEachEpisodeAfterMs: 50 });

  const outcome = await Promise.race([
    streamResponse(stream, res, 200, {}, 0, mockAM, null, {}, 150).then(() => 'completed', e => `err:${e.message}`),
    new Promise(r => setTimeout(() => r('HUNG'), 2000)),
  ]);

  assert.equal(outcome, 'completed', 'a slow-but-alive client that drains each episode streams to completion — not cut by the stall guard');
  assert.ok(res.writableEnded);
}));
