import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const SRC = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');

test('the 503 never tells the user to check an internet connection that is fine', () => {
  // 2026-08-04: a session died with "Check your internet connection and try again" while
  // every other session kept working at that exact moment. The real cause was a mid-flight
  // connection drop (`terminated`) on each account tried — not the machine being offline.
  // Blaming the user's link sends them to debug the wrong thing.
  const block = SRC.slice(SRC.indexOf("type: 'connection_unavailable'"));
  const msg = /message: ([\s\S]*?)\n\s*\},/.exec(block)[1];
  assert.doesNotMatch(msg, /Check your internet connection/,
    'must not blame the local connection for an upstream mid-flight drop');
  assert.match(msg, /dropped on every account/, 'says what actually happened');
  assert.match(msg, /\$\{lastCode\}/, 'carries the real error code so it is diagnosable');
  assert.match(msg, /not a quota problem/, 'still rules out the thing users assume first');
  assert.match(msg, /sending the message again/, 'gives an actionable next step');
});
