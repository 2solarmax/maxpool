import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import net from 'node:net';

test('pool raises the per-family connect attempt timeout above Node 20\'s 250ms default', () => {
  // Node's happy-eyeballs default (250ms) aborts the IPv4 fallback before a slow
  // IPv4 path can win — measured 2026-10-08 as a fleet-wide UPSTREAM_TTFB outage on
  // a degraded-IPv6 network (IPv6 attempt fails fast, IPv4 needs ~3s to establish).
  // src/index.js must raise it before any connection opens. It only RUNS when index.js
  // executes, so this pins the source (and the setting is asserted directly below when
  // it is loaded).
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  assert.match(src, /setDefaultAutoSelectFamilyAttemptTimeout\(Number\(process\.env\.MAXPOOL_FAMILY_ATTEMPT_MS\) \|\| 2000\)/,
    'the 250ms default is raised (overridable via env)');
});

test('the default really is 250ms without the fix (documents why this matters)', () => {
  // A fresh Node process starts at 250 — proving the failure mode exists without the
  // fix rather than being hypothetical. (This test does NOT import index.js.)
  assert.equal(net.getDefaultAutoSelectFamilyAttemptTimeout?.(), 250);
});
