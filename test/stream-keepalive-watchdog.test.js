import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

// MEASURED against real Claude Code 2.1.220 (4 arms, live clients, 2026-08-02):
//   comment keepalive  -> client survived 610s
//   `event: ping`      -> client survived 620s     (i.e. IDENTICAL — one heartbeat of phase)
//   no keepalive       -> died at 180s
//   ping WITHOUT _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL=1 -> died at exactly 300.0s
// The bundled Anthropic SDK discards BOTH shapes (`if(a.event==="ping")continue;` and
// `if(e.startsWith(":"))return null`). What actually holds a stream open is RAW BYTES, seen
// by a byte-level watchdog that only exists when the first-party bridge env var is set.
// So the keepalive FRAME SHAPE is not the load-bearing thing — its existence is.

test('a keepalive is emitted at all — bytes are what hold the stream open', () => {
  assert.match(SRC, /const QUEUE_KEEPALIVE = '[^']+'/, 'a keepalive frame exists');
  const m = /const QUEUE_KEEPALIVE = '([^']*)'/.exec(SRC);
  assert.ok(m[1].length > 0, 'non-empty: zero bytes would reset nothing');
  assert.ok(m[1].endsWith('\\n\\n'), 'terminated so the client parser never buffers a partial frame');
});

test('the hold window comes from the CLIENT, not from maxpool\'s own environment', () => {
  // The category error that clamped every hold to 4 minutes: the cc alias exports
  // CLAUDE_STREAM_IDLE_TIMEOUT_MS to the Claude Code process, never to maxpool.
  assert.match(SRC, /x-maxpool-client-stream-idle-ms/, 'tolerance is read from a per-request header');
  assert.doesNotMatch(SRC, /process\.env\.CLAUDE_STREAM_IDLE_TIMEOUT_MS/,
    "maxpool must not infer the client's patience from its own env");
});

test('a queue-HELD request is exempt from the idle reaper', () => {
  // A held request already released its account lease, so reaping frees nothing — and
  // reaping at 20min made any longer hold window inert (the socket died with no error frame).
  const fn = /function startIdleRequestReaper\([\s\S]*?\n\}/.exec(SRC)[0];
  assert.match(fn, /queueHeartbeatActive\)\s*\{\s*lastProgressAt = now\(\); return;/,
    'held requests reset the watchdog and are never reaped here');
});
