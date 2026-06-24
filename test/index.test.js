import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAccounts } from '../src/account-config.js';

test('importFrom account preserves routing and disabled metadata at startup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'teamclaude-import-'));
  const credentialPath = join(dir, 'credentials.json');
  await writeFile(credentialPath, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'fresh-access',
      refreshToken: 'fresh-refresh',
      expiresAt: Date.now() + 3600_000,
    },
  }));

  try {
    const [account] = await resolveAccounts({
      accounts: [{
        name: 'personal',
        type: 'oauth',
        importFrom: credentialPath,
        enabled: false,
        priority: 7,
        profiles: ['claude'],
      }],
    });

    assert.equal(account.enabled, false);
    assert.equal(account.priority, 7);
    assert.deepEqual(account.profiles, ['claude']);
    assert.equal(account.accessToken, 'fresh-access');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
