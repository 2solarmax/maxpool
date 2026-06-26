import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAccounts } from '../src/account-config.js';

test('stored-token oauth account preserves routing and disabled metadata at startup', async () => {
  // Import was removed; oauth accounts now carry their own stored token
  // (browser-login grant), and resolveAccounts must preserve their metadata
  // without re-reading any external credential source.
  const [account] = await resolveAccounts({
    accounts: [{
      name: 'personal',
      type: 'oauth',
      accessToken: 'stored-access',
      refreshToken: 'stored-refresh',
      expiresAt: Date.now() + 3600_000,
      enabled: false,
      priority: 7,
      profiles: ['claude'],
    }],
  });

  assert.equal(account.enabled, false);
  assert.equal(account.priority, 7);
  assert.deepEqual(account.profiles, ['claude']);
  assert.equal(account.accessToken, 'stored-access');
});

test('oauth account with no token is skipped (re-add via login)', async () => {
  const accounts = await resolveAccounts({
    accounts: [{ name: 'broken', type: 'oauth' }],
  });
  assert.equal(accounts.length, 0);
});
