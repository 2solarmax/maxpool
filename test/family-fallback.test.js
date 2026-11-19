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

test('MaxPool gives address families more time than the Node runtime default', () => {
  // Node 20 uses 250ms and newer Node versions use 500ms. Both can cut off
  // the slow fallback documented above. This process does not import index.js.
  const runtimeDefault = net.getDefaultAutoSelectFamilyAttemptTimeout();
  assert.ok(runtimeDefault > 0 && runtimeDefault < 2000);
});
