import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('the queue keepalive is a real SSE EVENT, never a comment', () => {
  // THE BUG (2026-07-28): the keepalive was `: maxpool queued\n\n`. Claude Code's stall
  // watchdog is reset only when its SSE iterator YIELDS an event; per the SSE spec a `:`
  // comment is discarded by the parser and never yields. So a 10s heartbeat reset nothing
  // and held requests died at EXACTLY the client's 300s floor — 60 deaths in 2.4 days,
  // surfacing to the user as "Response stalled mid-stream".
  const m = /const QUEUE_KEEPALIVE = '([^']*)'/.exec(SRC);
  assert.ok(m, 'the keepalive frame is a named constant');
  const frame = m[1].replace(/\\n/g, '\n');
  assert.ok(!frame.trimStart().startsWith(':'), 'MUST NOT be an SSE comment — it resets nothing');
  assert.match(frame, /^event: \w+\n/, 'is a named SSE event');
  assert.match(frame, /\ndata: /, 'carries a data line, so the parser yields it');
  assert.ok(frame.endsWith('\n\n'), 'terminated by a blank line');
  assert.equal(SRC.includes("': maxpool queued"), false, 'no comment-frame keepalive remains');
});

test('maxpool\'s stream idle bound stays strictly BELOW the client 300s floor', () => {
  // Claude Code: max(CLAUDE_STREAM_IDLE_TIMEOUT_MS, 300_000). At a 300_000 default the two
  // timers tied and the client always won (maxpool's clock starts when the chunk is READ,
  // before the client parses it) — so maxpool's guard fired 0 times in 2.4 days while the
  // user ate silent stalls. Below the floor, maxpool wins and labels the failure.
  const m = /const STREAM_IDLE_MS = Math\.max\(30_000, Number\(process\.env\.MAXPOOL_STREAM_IDLE_MS\) \|\| ([0-9_]+)\)/.exec(SRC);
  assert.ok(m, 'the idle bound is where the test expects it');
  const v = Number(m[1].replace(/_/g, ''));
  assert.ok(v < 300_000, `must be < the 300s client floor (got ${v})`);
  assert.ok(v >= 120_000, `must stay well above a real thinking gap (got ${v})`);
});

test('a long hold is only taken when the client watchdog was actually raised', () => {
  // The 3h tolerance was hardcoded, matching the `cc` alias. A session started any other
  // way keeps the 300s floor, so holding its request for hours parks a caller that left.
  assert.ok(!/streamClientToleranceMs: Math\.max\(60_000, Number\(process\.env\.MAXPOOL_STREAM_CLIENT_TOLERANCE_MS\) \|\| 3 \* 60 \* 60 \* 1000\)/.test(SRC),
    'the unconditional 3h hold is gone');
  assert.match(SRC, /CLAUDE_STREAM_IDLE_TIMEOUT_MS\) > 300_000/,
    'the hold is derived from the observable client watchdog');
});

test('undici root causes are logged, and network classification reads err.cause', () => {
  // 588 "fetch failed" lines and ZERO error codes in the whole log: err.code is undefined
  // on an undici fetch rejection — the real code lives on err.cause.
  assert.match(SRC, /err\.cause\?\.code \|\| err\.cause\?\.message/, 'root cause is logged');
  assert.match(SRC, /isNetworkCode\(err\.code\) \|\| isNetworkCode\(err\.cause\?\.code\)/,
    'classification reads both, so the previously-dead code branches work');
});

test('the client-abort path is no longer silent', () => {
  assert.match(SRC, /Client left after .*headersSent \? 'mid-response/s,
    'logs elapsed + whether output had already been sent');
});

test('the post-commit error write cannot crash the worker', () => {
  // No res.on('error') exists here; an uncaught write error hits uncaughtException, which
  // process.exit()s and bounces every OTHER in-flight stream.
  const fn = /function sendErrorResponse\([^)]*\) \{[\s\S]*?\n\}/.exec(SRC)[0];
  assert.match(fn, /try \{\s*res\.write\(/, 'the SSE error write is guarded');
  assert.match(fn, /try \{ res\.end\(\)/, 'the end() is guarded too');
});
