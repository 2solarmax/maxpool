import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Static-source assertions on the rc-gate remote-leg wiring (the gate itself is a
// long-running MITM daemon we don't boot in unit tests; these pin the contract).
const src = readFileSync(fileURLToPath(new URL('../tools/rc-gate/rc-gate.js', import.meta.url)), 'utf8');

test('rc-gate: MAXPOOL_HOST defaults to 127.0.0.1 and is env-overridable', () => {
  assert.match(src, /RC_GATE_MAXPOOL_HOST \|\| '127\.0\.0\.1'/);
});

test('rc-gate: MAXPOOL_KEY env adds x-api-key to pool-bound requests only when set', () => {
  // Header is conditional — unset KEY must not alter headers for local pools.
  assert.match(src, /if \(MAXPOOL_KEY\) headers\['x-api-key'\] = MAXPOOL_KEY;/);
});

test('rc-gate: forward leg uses MAXPOOL_HOST (no hardcoded 127.0.0.1 remains)', () => {
  assert.match(src, /host: MAXPOOL_HOST, port: MAXPOOL_PORT/);
  assert.ok(!/host:\s*'127\.0\.0\.1',\s*port: MAXPOOL_PORT/.test(src), 'hardcoded pool host must be gone');
});

test('rc-gate: authorization strip preserved (pool accounts supply upstream auth)', () => {
  assert.match(src, /delete headers\.authorization/);
});

test('rc-gate: a pool key (mp-…) is stripped from the DIRECT-to-Anthropic leg (redteam 2026-10-29)', () => {
  // Static pin, like its neighbours: rc-gate runs as a standalone daemon with no
  // importable seam for the direct leg.
  assert.match(src, /if \(String\(dirHeaders\['x-api-key'\] \|\| ''\)\.startsWith\('mp-'\)\) delete dirHeaders\['x-api-key'\];/);
});

test('rc-gate: the pool key is stripped by VALUE too, not only by mp- prefix (security review 2026-10-31)', () => {
  // Per-person keys minted into Secret Manager carry no guaranteed prefix; only an
  // exact-value comparison stops one from riding the direct leg to api.anthropic.com.
  assert.match(src, /if \(MAXPOOL_KEY && dirHeaders\['x-api-key'\] === MAXPOOL_KEY\) delete dirHeaders\['x-api-key'\];/);
});
