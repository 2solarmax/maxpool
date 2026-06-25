import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, checkForUpdate } from '../src/updater.js';

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
