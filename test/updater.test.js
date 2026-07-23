import { test } from 'node:test';
import assert from 'node:assert/strict';
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
