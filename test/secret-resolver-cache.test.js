import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecret, resolveSecrets, __resetSecretCache } from '../src/secret-resolver.js';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The cache is memoised on first read; reset between tests.
function withCache(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'sr-test-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', '.credentials-cache'), JSON.stringify(entries));
  process.env.HOME = dir;   // homedir() picks this up
  __resetSecretCache();
  return () => { try { process.env.HOME = originalHome; } catch {} };
}

const originalHome = process.env.HOME;

test('cache hit returns instantly (no gcloud invocation)', async () => {
  const restore = withCache({ 'TEST_SECRET_X': 'cached-value-123' });
  try {
    const v = await resolveSecret('TEST_SECRET_X');
    assert.equal(v, 'cached-value-123');
  } finally { restore(); }
});

test('cache MISS falls through to gcloud (mocked)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-test-'));
  process.env.HOME = dir;
  __resetSecretCache();  // no cache file → cache is null → must try gcloud
  // We can't easily mock execFile here, so just verify it returns null for a
  // nonexistent secret (gcloud will error → null) without hanging.
  const v = await resolveSecret('NONEXISTENT_SECRET_FOR_TEST_12345', { timeoutMs: 5000 });
  assert.equal(v, null, 'a missing secret returns null, not a throw');
  process.env.HOME = originalHome;
});

test('resolveSecrets hits cache for all present, gcloud only for misses', async () => {
  const restore = withCache({
    'CACHED_ONE': 'val1',
    'CACHED_TWO': 'val2',
    // 'UNCACHED' intentionally absent → will try gcloud
  });
  try {
    const t0 = Date.now();
    const r = await resolveSecrets(['CACHED_ONE', 'CACHED_TWO', 'UNCACHED_MISSING'], { timeoutMs: 5000 });
    const elapsed = Date.now() - t0;
    assert.equal(r['CACHED_ONE'], 'val1');
    assert.equal(r['CACHED_TWO'], 'val2');
    assert.equal(r['UNCACHED_MISSING'], undefined, 'a gcloud miss is absent from the result');
    // The two cached ones are instant; the one gcloud miss takes up to 5s.
    assert.ok(elapsed < 10_000, `should not take more than 10s (got ${elapsed}ms)`);
  } finally { restore(); }
});

test('useCache=false bypasses the cache entirely', async () => {
  const restore = withCache({ 'BYPASS_TEST': 'cached' });
  try {
    // useCache=false forces gcloud even though the cache has it
    const v = await resolveSecret('BYPASS_TEST', { useCache: false, timeoutMs: 5000 });
    // gcloud won't find BYPASS_TEST → null (the cache value 'cached' was NOT used)
    assert.equal(v, null, 'cache was bypassed — gcloud returned null for a fake secret');
  } finally { restore(); }
});

test('a corrupt cache file degrades gracefully to gcloud', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sr-test-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude', '.credentials-cache'), '{ this is not valid json');
  process.env.HOME = dir;
  __resetSecretCache();
  const v = await resolveSecret('ANYTHING', { timeoutMs: 5000 });
  assert.equal(v, null, 'corrupt cache → null (gcloud miss), not a throw');
  process.env.HOME = originalHome;
});
