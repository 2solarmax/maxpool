import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compareVersions, checkForUpdate, maybeCheckForUpdate, __resetUpdaterState, markApplied } from '../src/updater.js';

test('compareVersions orders semver correctly', () => {
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.2.0', '1.2.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1); // numeric, not lexical
});

test('checkForUpdate flags a newer published version', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '1.0.5' }) });
  try {
    const r = await checkForUpdate('1.0.3');
    assert.equal(r.latest, '1.0.5');
    assert.equal(r.hasUpdate, true);
    const same = await checkForUpdate('1.0.5');
    assert.equal(same.hasUpdate, false);
  } finally {
    globalThis.fetch = orig;
  }
});

test('checkForUpdate is failure-safe (returns null on network error)', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('offline'); };
  try {
    assert.equal(await checkForUpdate('1.0.3'), null);
  } finally {
    globalThis.fetch = orig;
  }
});

test('maybeCheckForUpdate always reports version info (feeds the header indicator)', async () => {
  const orig = globalThis.fetch;
  // Newer published version → hasUpdate true, and the indicator carries latest.
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '999.0.0' }) });
  let info = null;
  try {
    await maybeCheckForUpdate({ updateCheck: true }, () => {}, i => { info = i; });
  } finally {
    globalThis.fetch = orig;
  }
  assert.ok(info, 'onVersionInfo invoked');
  assert.equal(typeof info.current, 'string', 'running version known');
  assert.equal(info.latest, '999.0.0');
  assert.equal(info.hasUpdate, true);
  assert.ok(Number.isFinite(info.checkedAt));
});

test('maybeCheckForUpdate reports version info even when update checks are off (no npm call)', async () => {
  const orig = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = async () => { fetched = true; return { ok: true, json: async () => ({ version: '999.0.0' }) }; };
  let info = null;
  try {
    await maybeCheckForUpdate({ updateCheck: false }, () => {}, i => { info = i; });
  } finally {
    globalThis.fetch = orig;
  }
  assert.equal(fetched, false, 'updateCheck:false skips the npm round-trip');
  assert.ok(info && typeof info.current === 'string', 'still reports the running version');
  assert.equal(info.latest, null);
  assert.equal(info.hasUpdate, false);
});

// ── auto-apply loop-safety (the judge's I1–I5) ───────────────────────────────────
// Injectable deps model the running code vs the on-disk package: selfUpdate() mutates
// the DISK version; the RUNNING version only changes when a new process boots (which a
// test models by __resetUpdaterState() + a fresh harness).

function harness({ running, latest, installOk = true }) {
  let disk = running;
  let _latest = latest;
  return {
    deps: {
      getCurrentVersion: async () => disk,
      checkForUpdate: async (current) => ({ latest: _latest, current, hasUpdate: compareVersions(_latest, current) > 0 }),
      selfUpdate: async () => { if (installOk) disk = _latest; return installOk ? { ok: true } : { ok: false, error: 'boom' }; },
    },
    setDisk: v => { disk = v; },
    getDisk: () => disk,
    setLatest: v => { _latest = v; },
  };
}
const CFG_AUTO = { autoUpdate: true, autoApply: true };

// Model the index.js CALLER: it applies (markApplied + "reload") iff applicable & autoApply.
// The mark is the caller's action — maybeCheckForUpdate has no side effect on the floor.
async function checkAndMaybeApply(cfg, deps) {
  const r = await maybeCheckForUpdate(cfg, () => {}, null, deps);
  const applied = Boolean(r.applicable && cfg.autoApply);
  if (applied) markApplied(r.installedVersion);   // caller marks BEFORE the reload
  return { ...r, applied };
}

test('I1 auto-apply fires ONCE, then quiescent after the reload', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  const r1 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r1.applied, true, 'applies 1.0.1 once');
  assert.equal(r1.installedVersion, '1.0.1');
  __resetUpdaterState();                              // the seamless reload → a new process now runs 1.0.1
  const h2 = harness({ running: '1.0.1', latest: '1.0.1' });
  const r2 = await checkAndMaybeApply(CFG_AUTO, h2.deps);
  assert.equal(r2.hasUpdate, false, 'now on latest');
  assert.equal(r2.applied, false, 'no further reload');
});

test('I2 a boot-broken version is attempted ONCE, never loops (rollback → quarantine)', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  const r1 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r1.applied, true, 'first attempt applies 1.0.1');
  // Reload ROLLED BACK: SAME process still runs 1.0.0 (no reset), disk is 1.0.1.
  const r2 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r2.applied, false, 'the rolled-back version is quarantined — no 2nd apply');
  const r3 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r3.applied, false, 'still no loop on the next check');
  // A genuinely NEWER release breaks the quarantine.
  h.setLatest('1.0.2');
  const r4 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r4.applied, true, 'a newer 1.0.2 still auto-applies');
  assert.equal(r4.installedVersion, '1.0.2');
});

test('S1 an ignored `applicable` return never strands the version (no internal marking)', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  // This is the exact M1 shape: a caller that discards the result (never markApplied).
  const r1 = await maybeCheckForUpdate(CFG_AUTO, () => {}, null, h.deps);
  assert.equal(r1.applicable, true, '1.0.1 is applicable');
  const r2 = await maybeCheckForUpdate(CFG_AUTO, () => {}, null, h.deps);
  assert.equal(r2.applicable, true, 'STILL applicable — an ignored return cannot poison the quarantine floor');
});

test('I3 no reinstall churn: selfUpdate runs once across many checks (autoApply off)', async () => {
  __resetUpdaterState();
  let installs = 0;
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  const deps = { ...h.deps, selfUpdate: async () => { installs++; h.setDisk('1.0.1'); return { ok: true }; } };
  const cfg = { autoUpdate: true, autoApply: false };
  for (let i = 0; i < 4; i++) await maybeCheckForUpdate(cfg, () => {}, null, deps);
  assert.equal(installs, 1, 'downloaded once, not once per check');
});

test('I5 advance-only: a failed self-install is never applicable', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1', installOk: false });
  const r = await maybeCheckForUpdate(CFG_AUTO, () => {}, null, h.deps);
  assert.equal(r.applicable, false, 'npm failed → nothing to apply');
});

test('autoApply off downloads but the caller never applies', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  const r = await checkAndMaybeApply({ autoUpdate: true, autoApply: false }, h.deps);
  assert.equal(r.hasUpdate, true);
  assert.equal(r.applied, false);
  assert.equal(h.getDisk(), '1.0.1', 'still downloaded in the background');
});

test('hasUpdate keys on the RUNNING version — banner stays accurate after a background download', async () => {
  __resetUpdaterState();
  const h = harness({ running: '1.0.0', latest: '1.0.1' });
  await maybeCheckForUpdate({ autoUpdate: true, autoApply: false }, () => {}, null, h.deps); // downloads to disk
  let info;
  await maybeCheckForUpdate({ autoUpdate: true, autoApply: false }, () => {}, i => { info = i; }, h.deps);
  assert.equal(info.current, '1.0.0', 'current = RUNNING version, not the downloaded disk version');
  assert.equal(info.hasUpdate, true, 'banner still shows the update until a restart applies it');
});

test('the MANUAL apply path installs even when autoUpdate is off (the forceInstall shim)', async () => {
  // index.js "check & apply now" passes { ...config, autoUpdate: true } so the manual
  // action downloads+applies regardless of the user's automatic-update choice — else
  // maybeCheckForUpdate short-circuits before installing and the user is stuck on the old
  // version (the quit/relaunch dance). This locks that boundary.
  __resetUpdaterState();
  let installed = false;
  const deps = {
    getCurrentVersion: async () => (installed ? '2.0.0' : '1.0.0'),
    checkForUpdate: async () => ({ latest: '2.0.0', current: '1.0.0', hasUpdate: true }),
    selfUpdate: async () => { installed = true; return { ok: true, output: '' }; },
  };
  // AUTO path with autoUpdate:false → respects the choice, no npm install, not applicable.
  const auto = await maybeCheckForUpdate({ updateCheck: true, autoUpdate: false }, () => {}, () => {}, deps);
  assert.equal(installed, false, 'auto path honors autoUpdate:false');
  assert.equal(auto.applicable, false);
  // MANUAL path (index.js forces autoUpdate:true) → installs + becomes applicable→reload.
  const manual = await maybeCheckForUpdate({ updateCheck: true, autoUpdate: true }, () => {}, () => {}, deps);
  assert.equal(installed, true, 'the forced manual path installs despite the base config being autoUpdate:false');
  assert.equal(manual.applicable, true, 'so applyNow (autoApply-agnostic) will seamless-reload');
});

test('clearQuarantine lets a manual apply re-attempt a version a prior rolled-back auto-reload stranded', async () => {
  // Reproduce the bug: an auto-apply markApplied(1.5.43) BEFORE a reload that then ROLLED
  // BACK (slow readiness on a loaded machine). The version is now quarantined, so a manual
  // 'u'→'c' would dead-end on "already attempted". clearQuarantine (called by the manual
  // path) must un-strand it.
  const { clearQuarantine } = await import('../src/updater.js');
  __resetUpdaterState();
  let onDisk = '1.5.42';                              // running version; the install rewrites it
  const deps = {
    getCurrentVersion: async () => onDisk,
    checkForUpdate: async () => ({ latest: '1.5.43', current: '1.5.42', hasUpdate: true }),
    selfUpdate: async () => { onDisk = '1.5.43'; return { ok: true, output: '' }; },
  };
  markApplied('1.5.43');                              // the pre-reload mark that then rolled back
  const stranded = await maybeCheckForUpdate({ updateCheck: true, autoUpdate: true }, () => {}, () => {}, deps);
  assert.equal(stranded.applicable, false, 'quarantined: auto path will NOT re-apply a rolled-back version');

  clearQuarantine();                                  // what the manual 'u'→'c' path now does first
  const retry = await maybeCheckForUpdate({ updateCheck: true, autoUpdate: true }, () => {}, () => {}, deps);
  assert.equal(retry.applicable, true, 'after clearQuarantine the manual apply re-attempts 1.5.43');
});

test('the update check cadence is 30 minutes, env-tunable, floored at 60s', () => {
  // A 6-hour default meant a fix published minutes ago could sit unapplied for hours —
  // indistinguishable from "auto-update is broken" (2026-07-26: it worked, but a 4h gap
  // between publish and pickup was the whole complaint).
  const src = readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
  const m = /const updateIntervalMs = Math\.max\(60_000, Number\(process\.env\.MAXPOOL_UPDATE_CHECK_INTERVAL_MS\) \|\| ([^)]+)\);/.exec(src);
  assert.ok(m, 'the interval expression is where the test expects it');
  // eslint-disable-next-line no-eval
  assert.equal(eval(m[1].replace(/_/g, '')), 30 * 60 * 1000, 'default is 30 minutes');
  assert.match(m[0], /Math\.max\(60_000/, 'still floored at 60s so a bad env value cannot hammer npm');
});

// ── the auto-update dead-end (reported 2026-08-08) ──────────────────────────────
//
// Each failed seamless reload calls markApplied(version). Once every published version
// has been quarantined, the timer keeps firing but `applicable` is always false — the
// user is stuck on old code forever, with auto-update silently doing nothing.
// The ONLY escape is a manual quit+relaunch (which clears the in-memory quarantine).
// This test PROVES the dead-end exists so a future fix to clearQuarantine or the timer
// can demonstrate it resolves the scenario.

test('DEAD-END: successive failed reloads quarantine every version — auto-update stuck', async () => {
  __resetUpdaterState();
  // Running 1.0.0. npm publishes 1.0.1, 1.0.2, 1.0.3 in sequence.
  // Each reload fails (the TTY bug), old worker resumes, markApplied quarantines.
  const h = harness({ running: '1.0.0', latest: '1.0.1' });

  // First cycle: 1.0.1 published, installs, reload fails
  const r1 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r1.applied, true, '1.0.1 installed + reload attempted');
  // Reload FAILED — running is still 1.0.0, disk is 1.0.1

  // Second cycle: npm now has 1.0.2 (time passes, new release)
  h.setLatest('1.0.2');
  const r2 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r2.applied, true, '1.0.2 > quarantined 1.0.1, so it applies');
  // Reload FAILED again — running still 1.0.0

  // Third cycle: npm now has 1.0.3
  h.setLatest('1.0.3');
  const r3 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r3.applied, true, '1.0.3 > quarantined 1.0.2');

  // Now: npm STAYS at 1.0.3. No newer release comes. The timer fires again.
  const r4 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r4.applied, false, 'DEAD-END: 1.0.3 is quarantined, nothing newer exists');
  assert.equal(r4.applicable, false);
  assert.equal(r4.hasUpdate, true, 'npm still reports 1.0.3 > running 1.0.0');
  assert.equal(r4.installedVersion, '1.0.3', 'on-disk IS 1.0.3');

  // The running process is STILL on 1.0.0. The on-disk is 1.0.3. Auto-update
  // will NEVER apply it — the quarantine floor is 1.0.3 and nothing exceeds it.
  // This is the exact state reported: stuck on old code with the new version
  // sitting on disk.
  const h2 = harness({ running: '1.0.0', latest: '1.0.3' });
  h2.setDisk('1.0.3');   // disk already has it from the install above
  const r5 = await checkAndMaybeApply(CFG_AUTO, h2.deps);
  assert.equal(r5.applied, false, 'confirmed: stuck forever without manual restart');
});

test('ESCAPE: a manual quit+relaunch clears the quarantine (fresh process)', async () => {
  // The only escape today: __resetUpdaterState() models a new process boot.
  // After it, the quarantine is empty and the on-disk version applies immediately.
  __resetUpdaterState();
  // Simulate: the user quit, disk had 1.0.3, they relaunch → running 1.0.3
  const h = harness({ running: '1.0.3', latest: '1.0.3' });
  const r = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r.hasUpdate, false, 'fresh process on 1.0.3 — no update needed');
  assert.equal(r.applied, false);
  // Auto-update is healthy again — next time npm publishes 1.0.4, it applies.
  h.setLatest('1.0.4');
  const r2 = await checkAndMaybeApply(CFG_AUTO, h.deps);
  assert.equal(r2.applied, true, 'quarantine cleared — 1.0.4 applies cleanly');
});
