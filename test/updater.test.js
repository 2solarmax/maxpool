import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, checkForUpdate, maybeCheckForUpdate } from '../src/updater.js';

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
