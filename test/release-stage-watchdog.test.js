// Release stage watchdog (2026-10-27, owner-approved). v1.24.31's release froze
// SILENTLY after "Running tests" — no tag, no error. Every stage in
// scripts/release.sh now runs under run_stage(), which must (a) pass a stage that
// finishes, (b) KILL a stage that exceeds its ceiling and exit non-zero with a
// named failure line, (c) never run a later stage after a failed one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = readFileSync(new URL('../scripts/release.sh', import.meta.url), 'utf8');
const fn = src.slice(src.indexOf('run_stage() {'), src.indexOf('\n}\n', src.indexOf('run_stage() {')) + 2);

const GUARDS = fileURLToPath(new URL('../scripts/release-guards.sh', import.meta.url));

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

test('a stage banner goes to stderr, so a stage never pollutes captured stdout', () => {
  const r = harness('V="$(run_stage "Version bump" 10 echo v9.9.9)"\necho "CAPTURED=[$V]"');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CAPTURED=\[v9\.9\.9\]/, 'only the command stdout is captured');
  assert.match(r.stderr, /==> Version bump/, 'the banner still reaches the operator (stderr)');
});

test('a failed stage prints the recovery text produced by RELEASE_STAGE_RECOVERY_FN, computed at failure time', () => {
  const r = harness('rec() { echo "git tag -d v1.2.3 && git reset --hard origin/main"; }\nRELEASE_STAGE_RECOVERY_FN=rec\nrun_stage "Push" 10 false\necho LATER-RAN');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /To undo this attempt:\s+git tag -d v1\.2\.3 && git reset --hard origin\/main/);
  assert.doesNotMatch(r.stdout, /LATER-RAN/);
  // computed when the stage FAILS, not when the variable is set: state changed in between is seen
  const late = harness('X=before\nrec() { echo "state=$X"; }\nRELEASE_STAGE_RECOVERY_FN=rec\nX=after\nrun_stage "Push" 10 false');
  assert.match(late.stderr, /state=after/);
});

test('a failed stage with no recovery set prints no undo line', () => {
  const r = harness('run_stage "Push" 10 false');
  assert.doesNotMatch(r.stderr, /To undo this attempt/);
  assert.doesNotMatch(src, /RELEASE_STAGE_RECOVERY=/, 'the old static-string variable is gone');
});

test('release.sh refuses a non-main/detached checkout BEFORE the remote sync check', () => {
  const branchAt = src.indexOf('release_require_on_base_branch "$BASE_BRANCH"');
  const syncAt = src.indexOf('release_require_synced_with_remote "$REMOTE" "$BASE_BRANCH"');
  assert.ok(branchAt > 0, 'branch guard is called');
  assert.ok(branchAt < syncAt, 'branch guard runs before the first sync check');
});

test('release.sh recovery hints delete only tags THIS attempt created (source pin: release.sh cannot run here)', () => {
  // Not --points-at HEAD (main's tip usually carries the previous release's tag) and not
  // --no-merged (a clone carries dozens of unmerged v* tags): snapshot before, diff after.
  assert.doesNotMatch(src, /--points-at/);
  assert.doesNotMatch(src, /--no-merged/);
  const snap = src.indexOf(`TAGS_BEFORE="$(git tag -l 'v*')"`);
  const bump = src.indexOf('run_stage "Version bump"');
  assert.ok(snap > 0 && snap < bump, 'tag snapshot is taken BEFORE the bump stage');
  assert.match(src, /recovery_bump\(\) \{ release_recovery_bump "\$OLD_SHA" "\$TAGS_BEFORE"; \}/);
  assert.match(src, /recovery_push\(\) \{ release_recovery_push "\$REMOTE" "\$NEW_VERSION" "\$BASE_BRANCH"; \}/);
  const pushAt = src.indexOf('RELEASE_STAGE_RECOVERY_FN=recovery_push');
  assert.ok(pushAt > bump && pushAt < src.indexOf('run_stage "Push to'), 'push recovery armed right before the push stage');
});

test('release.sh reads the new version from package.json, never from npm stdout (source pin)', () => {
  assert.doesNotMatch(src, /NEW_VERSION="\$\(run_stage/, 'the version hook output polluted the captured value');
  assert.match(src, /NEW_VERSION="\$\(release_package_version\)"/);
  assert.ok(src.indexOf('release_package_version') > src.indexOf('run_stage "Version bump"'), 'read AFTER the bump');
});

test('the base branch is fixed to main; no env override (source pin)', () => {
  assert.doesNotMatch(src, /RELEASE_BASE_BRANCH/);
  assert.match(src, /^BASE_BRANCH=main$/m);
  assert.match(src, /release_require_ci_green "\$GH_REPO" "\$CI_SHA" "\$BASE_BRANCH"/, 'CI lookup is told the base');
  assert.doesNotMatch(src, /rev-parse --abbrev-ref/, 'branch identity comes from the symbolic ref in the guard');
  assert.match(src, /git remote get-url --push "\$REMOTE"/, 'the CI repo is derived from the PUSH url');
});

test('the publish watch goes through release_gh_watch, not the 60s release_gh (source pin)', () => {
  assert.match(src, /release_gh_watch run watch "\$RUN_ID"/);
  assert.doesNotMatch(src, /release_gh run watch/);
});

// ── executable: the watch ceiling and the package.json version read ────────────────────
function guardsHarness(body, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rg-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  // `timeout` stub: log the ceiling, then run the wrapped command. `gh` stub: log + succeed.
  writeFileSync(join(bin, 'timeout'), '#!/bin/bash\necho "timeout $*" >>"$CALLS"\nshift\nexec "$@"\n');
  writeFileSync(join(bin, 'gh'), '#!/bin/bash\necho "gh $*" >>"$CALLS"\nexit 0\n');
  chmodSync(join(bin, 'timeout'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  const f = join(dir, 'g.sh');
  writeFileSync(f, `#!/bin/bash\nset -uo pipefail\nsource "${GUARDS}"\n${body}\n`);
  const env = { ...process.env, CALLS: calls, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}` };
  delete env.RELEASE_WATCH_TIMEOUT; // the operator's own overrides must not leak into the defaults under test
  delete env.RELEASE_GH_TIMEOUT;
  Object.assign(env, extraEnv);
  const r = spawnSync('bash', [f], { encoding: 'utf8', timeout: 30_000, env });
  return { ...r, calls: readFileSync(calls, 'utf8'), dir };
}

test('the publish watch runs under its OWN 1800s ceiling, not the 60s per-call one', () => {
  const r = guardsHarness('release_gh_watch run watch 99 --repo o/r --exit-status\nrelease_gh run list --repo o/r');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.calls, /^timeout 1800 gh run watch 99 --repo o\/r --exit-status$/m, 'watch ceiling is 1800s');
  assert.match(r.calls, /^timeout 60 gh run list --repo o\/r$/m, 'short calls keep their 60s ceiling');
});

test('RELEASE_WATCH_TIMEOUT overrides the watch ceiling and leaves short calls alone', () => {
  const r = guardsHarness('release_gh_watch run watch 99\nrelease_gh run list', { RELEASE_WATCH_TIMEOUT: '2400' });
  assert.match(r.calls, /^timeout 2400 gh run watch 99$/m);
  assert.match(r.calls, /^timeout 60 gh run list$/m);
});

test('a watch that outlives 60s is NOT killed at 60s (the regression: rc 124 after the tag was pushed)', () => {
  // Real timeout is absent on stock macOS, so use the stub: assert the ceiling number handed
  // to it is far above any realistic Publish duration (checkout + npm publish + release).
  const r = guardsHarness('release_gh_watch run watch 1');
  const ceiling = Number(/^timeout (\d+) gh run watch/m.exec(r.calls)?.[1]);
  assert.ok(ceiling >= 600, `watch ceiling ${ceiling}s must comfortably exceed a normal publish run`);
});

function pkgVersion(pkgJson) {
  const dir = mkdtempSync(join(tmpdir(), 'pv-'));
  writeFileSync(join(dir, 'package.json'), pkgJson);
  return guardsHarness(`release_package_version "${join(dir, 'package.json')}"`);
}

test('release_package_version reads the TOP-LEVEL version from package.json', () => {
  const r = pkgVersion(JSON.stringify({ name: 'x', dependencies: { a: { version: '9.9.9' } }, version: '1.24.122' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), '1.24.122');
});

test('release_package_version accepts a prerelease version and prints nothing but the version', () => {
  const r = pkgVersion(JSON.stringify({ name: 'x', version: '2.0.0-rc.1' }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '2.0.0-rc.1\n', 'stdout is exactly the version, so TAG="v$NEW_VERSION" is clean');
});

test('release_package_version fails (rc 1) on a missing or non-semver version', () => {
  assert.equal(pkgVersion(JSON.stringify({ name: 'x' })).status, 1, 'no version field');
  assert.equal(pkgVersion(JSON.stringify({ name: 'x', version: 'not-a-version' })).status, 1, 'garbage version');
  assert.equal(pkgVersion('{ not json').status, 1, 'unparseable package.json');
  const missing = guardsHarness('release_package_version /nonexistent/package.json');
  assert.equal(missing.status, 1, 'missing file');
});

test('MAXPOOL_GH_REPO can never supply the repo: derivation failure is a refusal', () => {
  assert.doesNotMatch(src, /GH_REPO="\$\{MAXPOOL_GH_REPO:-/);
  assert.match(src, /must be a github\.com URL\. Release refused/);
});

test('release.sh wraps every real stage (version bump, push) in run_stage', () => {
  for (const stage of ['Version bump', 'Push to']) {
    assert.match(src, new RegExp(`run_stage "${stage}`), `${stage} is guarded`);
  }
  // CI is the proof now, not a local test stage (2026-11-21): the tests/lint stages
  // were removed from release.sh; a lingering local "Running tests" stage would be
  // a regression back to trusting this Mac's working copy.
  assert.doesNotMatch(src, /run_stage "Running tests/, 'no local test stage');
});
