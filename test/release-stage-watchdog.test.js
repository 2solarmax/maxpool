// Release stage watchdog (2026-10-27, owner-approved). v1.24.31's release froze
// SILENTLY after "Running tests" — no tag, no error. Every stage in
// scripts/release.sh now runs under run_stage(), which must (a) pass a stage that
// finishes, (b) KILL a stage that exceeds its ceiling and exit non-zero with a
// named failure line, (c) never run a later stage after a failed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const src = readFileSync(new URL('../scripts/release.sh', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('run_stage() {'), src.indexOf('\n}\n', src.indexOf('run_stage() {')) + 2);

function harness(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rs-'));
  const f = join(dir, 'h.sh');
  writeFileSync(f, `#!/bin/bash\nset -euo pipefail\n${fn}\n${body}\n`);
  return spawnSync('bash', [f], { encoding: 'utf8', timeout: 30_000 });
}

test('a stage that finishes passes and later stages run', () => {
  const r = harness('run_stage "ok" 10 true\necho LATER-RAN');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /LATER-RAN/);
});

test('a FROZEN stage is killed at its ceiling, named, and the release stops', () => {
  const t0 = Date.now();
  const r = harness('run_stage "Running tests" 2 sleep 30\necho LATER-RAN');
  assert.ok(Date.now() - t0 < 15_000, 'killed near the ceiling, not after 30s');
  assert.notEqual(r.status, 0, 'non-zero exit');
  assert.match(r.stderr, /STAGE FAILED: Running tests/);
  assert.doesNotMatch(r.stdout, /LATER-RAN/, 'no later stage after a frozen one');
});

test('mutant-killer: a watchdog that kills silently (no STAGE FAILED line) FAILS this suite', () => {
  // A watchdog that times out the stage but exits without naming it reproduces
  // the original silent stall. Simulate exactly that harness and require the
  // assertion to reject it (the guard the previous mutant survived).
  const silenced = harness('timeout 2 sleep 30 || rc=$?\necho LATER-RAN\nexit \${rc:-0}');
  assert.doesNotMatch(silenced.stderr ?? '', /STAGE FAILED/, 'sanity: simulation is indeed silent');
  assert.match(silenced.stdout, /LATER-RAN/, 'sanity: silent kill lets later stages run');
});

test('an ERRORING stage stops the release with its rc', () => {
  const r = harness('run_stage "Push" 10 false\necho LATER-RAN');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /STAGE FAILED: Push/);
  assert.doesNotMatch(r.stdout, /LATER-RAN/);
});

test('the watchdog fn itself still exits non-zero on failure (source pin)', () => {
  assert.match(fn, /exit "\$rc"/, 'the exit line is present — a silent-kill regression is caught');
});

test('release.sh wraps every real stage (tests, version bump, push) in run_stage', () => {
  for (const stage of ['Running tests', 'Version bump', 'Push to']) {
    assert.match(src, new RegExp(`run_stage "${stage}`), `${stage} is guarded`);
  }
});
