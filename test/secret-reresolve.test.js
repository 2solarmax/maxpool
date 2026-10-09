import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pendingProviders, reresolveProviders } from '../src/secret-resolver.js';

const acct = (over) => ({ name: 'p', type: 'provider', configSourced: true, secretName: 'S', status: 'active', ...over });

test('a provider whose key loaded is never touched (v1.24.6 regression: status reset to unknown)', async () => {
  const a = acct({ credential: 'k', status: 'active' });
  let called = false;
  const n = await reresolveProviders([a], async () => { called = true; return { S: 'other' }; });
  assert.equal(n, 0);
  assert.equal(called, false, 'resolver must not run when nothing is pending');
  assert.equal(a.status, 'active');
  assert.equal(a.credential, 'k');
});

test('an unresolved provider gets its key into `credential` and leaves the error state', async () => {
  const a = acct({ credential: null, status: 'error', lastError: 'secret-unresolved' });
  const n = await reresolveProviders([a], async () => ({ S: 'fresh' }));
  assert.equal(n, 1);
  assert.equal(a.credential, 'fresh', 'routing reads credential — authToken would be inert');
  assert.equal(a.status, 'active');
  assert.equal(a.lastError, null);
});

test('only config-sourced providers with a secret name are pending', () => {
  const list = [
    acct({ credential: null }),
    acct({ credential: null, configSourced: false }),
    acct({ credential: null, type: 'oauth' }),
    acct({ credential: null, secretName: null }),
  ];
  assert.equal(pendingProviders(list).length, 1);
});

test('a failed resolve leaves the account unchanged for the next tick', async () => {
  const a = acct({ credential: null, status: 'error', lastError: 'secret-unresolved' });
  const n = await reresolveProviders([a], async () => ({}));
  assert.equal(n, 0);
  assert.equal(a.status, 'error');
});

import { refreshRotatedProviders } from '../src/secret-resolver.js';

test('a rotated secret replaces the loaded key', async () => {
  const a = acct({ credential: 'old' });
  const n = await refreshRotatedProviders([a], async () => ({ S: 'new' }));
  assert.equal(n, 1);
  assert.equal(a.credential, 'new');
});

test('an unchanged secret is not counted as a rotation', async () => {
  const a = acct({ credential: 'same' });
  assert.equal(await refreshRotatedProviders([a], async () => ({ S: 'same' })), 0);
  assert.equal(a.credential, 'same');
});

test('a failed read keeps the current key', async () => {
  const a = acct({ credential: 'old' });
  assert.equal(await refreshRotatedProviders([a], async () => ({})), 0);
  assert.equal(a.credential, 'old');
});

test('rotation skips unloaded and non-config providers', async () => {
  const unloaded = acct({ credential: null });
  const header = acct({ credential: 'h', configSourced: false });
  let asked = null;
  const n = await refreshRotatedProviders([unloaded, header], async (names) => { asked = names; return { S: 'x' }; });
  assert.equal(n, 0);
  assert.equal(asked, null, 'nothing loaded → no Secret Manager read');
  assert.equal(header.credential, 'h');
});

test('the default resolver bypasses the local credentials cache', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../src/secret-resolver.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('export async function refreshRotatedProviders'));
  assert.match(fn.slice(0, 200), /useCache: false/);
});
