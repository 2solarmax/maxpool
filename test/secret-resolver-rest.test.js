import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSecret, __setRestDeps, __resetRestDeps, __resetSecretCache } from '../src/secret-resolver.js';

const ok = (val) => async () => ({ status: 200, ok: true, json: async () => ({ payload: { data: Buffer.from(val).toString('base64') } }) });

test('REST path resolves without touching the CLI (the CLI hangs on IPv6-broken networks)', async () => {
  __resetSecretCache();
  let urls = [];
  __setRestDeps({ token: async () => 'tok', fetch: async (url, o) => { urls.push(url); assert.equal(o.headers.Authorization, 'Bearer tok'); return ok('secret-value')(); } });
  try {
    const v = await resolveSecret('MY_SECRET', { useCache: false, project: 'p1' });
    assert.equal(v, 'secret-value');
    assert.equal(urls.length, 1);
    assert.match(urls[0], /projects\/p1\/secrets\/MY_SECRET\/versions\/latest:access$/);
  } finally { __resetRestDeps(); }
});

test('a REST failure falls through (returns null here, never throws)', async () => {
  __resetSecretCache();
  __setRestDeps({ token: async () => 'tok', fetch: async () => ({ status: 403, ok: false, json: async () => ({}) }) });
  try {
    const v = await resolveSecret('MISSING_SECRET_XYZ_' + Date.now(), { useCache: false, timeoutMs: 1500 });
    assert.equal(v, null);
  } finally { __resetRestDeps(); }
});

test('the default REST transport pins IPv4 (family: 4)', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/secret-resolver.js', import.meta.url), 'utf8');
  assert.match(src, /https\.get\(url, \{ headers, family: 4, signal \}/, 'IPv6 black-hole immunity is pinned');
});
