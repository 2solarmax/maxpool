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
