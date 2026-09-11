// The failing-body capture is OFF by default — it writes the user's transcript.
//
// Driver 2026-09-11: a [1210] rejection could not be reproduced from the content-free
// shape line. Every top-level field of the failing body, and the full combination, replayed
// 200 OK against z.ai; the cause is inside the 940-message content. Diagnosing that needs
// the real body — which is exactly why the switch must be explicit and bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('capture is off unless a directory is explicitly named', () => {
  // No default path, no "/tmp" fallback: absent env => empty string => falsy => no writes.
  assert.match(src, /const PROVIDER_4XX_CAPTURE_DIR = process\.env\.MAXPOOL_CAPTURE_PROVIDER_4XX \|\| ''/);
  assert.ok(!/MAXPOOL_CAPTURE_PROVIDER_4XX \|\| ['"][^'"]+['"]/.test(src),
    'must not default to any real directory');
});

test('capture is bounded — it cannot fill the disk with transcripts', () => {
  assert.match(src, /PROVIDER_4XX_CAPTURE_MAX/);
  assert.match(src, /_provider4xxCaptured < PROVIDER_4XX_CAPTURE_MAX/);
});

test('capture only ever runs on a PROVIDER 4xx, never on an Anthropic one', () => {
  const i = src.indexOf('PROVIDER_4XX_CAPTURE_DIR &&');
  const guard = src.lastIndexOf("account.type === 'provider'", i);
  assert.ok(guard > 0 && i - guard < 1400, 'capture sits inside the provider-only branch');
});

test('a capture failure never breaks the request path', () => {
  const i = src.indexOf('captured failing body');
  const seg = src.slice(Math.max(0, i - 900), i + 300);
  assert.match(seg, /try\s*\{/, 'wrapped in try');
  assert.match(seg, /catch\s*\(/, 'and catches — a diagnostic must never fail a request');
});
