import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// Mimics the REAL index.js saveConfig callback (index.js:903-917): it derives the
// PERSISTED tokens from the AccountManager (`am.credential/refreshToken/expiresAt`),
// NOT from config.accounts ("Use live tokens from AccountManager, not the stale
// config.accounts copy"). That is the invariant the re-auth path MUST satisfy — the
// AM has to hold the fresh tokens BEFORE saveConfig runs, or the stale AM token is
// written to disk and the account is dead on the next restart.
function amDerivedSaveConfig(config, accountManager, disk) {
  return async () => {
    disk.accounts = config.accounts.map(a => {
      const am = accountManager.accounts.find(c =>
        (a.accountUuid && c.accountUuid === a.accountUuid) || c.name === a.name);
      return am
        ? { ...a, accessToken: am.credential, refreshToken: am.refreshToken, expiresAt: am.expiresAt }
        : { ...a };
    });
  };
}

// ── the reported fire: re-auth, then dead on the very next restart ────────────

test('re-auth persists the FRESH token to disk, not the stale AccountManager token', async () => {
  const dead = {
    name: 'personal', type: 'oauth', accountUuid: 'uuid-p',
    accessToken: 'DEAD-access', refreshToken: 'DEAD-refresh', expiresAt: Date.now() - 1000, enabled: true,
  };
  const am = new AccountManager([{ ...dead }], 0.90);
  am.accounts[0].status = 'error';
  am.accounts[0].refreshDead = true;
  const config = { accounts: [{ ...dead }] };
  const disk = { accounts: [] };
  const tui = new TUI({ accountManager: am, config, saveConfig: amDerivedSaveConfig(config, am, disk) });

  await tui._upsertOAuthAccount({
    creds: { accessToken: 'FRESH-access', refreshToken: 'FRESH-refresh', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-p', email: 'personal' },
    name: 'personal', source: 'login',
  });

  // Disk is what a restart reads. It MUST carry the fresh re-auth token — otherwise
  // the next boot POSTs the consumed/dead token → invalid_grant → forced re-auth.
  const persisted = disk.accounts.find(a => a.name === 'personal');
  assert.equal(persisted.refreshToken, 'FRESH-refresh', 'the FRESH re-auth refresh token must be on disk (else dead on next restart)');
  assert.equal(persisted.accessToken, 'FRESH-access', 'the FRESH access token too');
  // And the in-memory AM is fresh + revived (already true today; guards against regressing it).
  assert.equal(am.accounts[0].refreshToken, 'FRESH-refresh');
  assert.equal(am.accounts[0].refreshDead, false);
  assert.equal(am.accounts[0].status, 'active');
});

test('adding a NEW account persists its token to disk (AM-derived writer sees it)', async () => {
  const am = new AccountManager([{
    name: 'existing', type: 'oauth', accountUuid: 'uuid-e',
    accessToken: 'e-a', refreshToken: 'e-r', expiresAt: Date.now() + 3600_000,
  }], 0.90);
  const config = { accounts: [{ name: 'existing', type: 'oauth', accountUuid: 'uuid-e', accessToken: 'e-a', refreshToken: 'e-r', expiresAt: Date.now() + 3600_000 }] };
  const disk = { accounts: [] };
  const tui = new TUI({ accountManager: am, config, saveConfig: amDerivedSaveConfig(config, am, disk) });

  await tui._upsertOAuthAccount({
    creds: { accessToken: 'NEW-a', refreshToken: 'NEW-r', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-new', email: 'brand-new' },
    name: 'brand-new', source: 'login',
  });

  const persisted = disk.accounts.find(a => a.name === 'brand-new');
  assert.ok(persisted, 'the new account reached disk');
  assert.equal(persisted.refreshToken, 'NEW-r', 'with its real token, not undefined (AM must know it before persist)');
});

test('re-auth persist FAILURE keeps the AM on the fresh token (never re-bricks a working account)', async () => {
  // The re-auth genuinely succeeded (fresh tokens in hand); a disk-write failure
  // must NOT revert the in-memory AccountManager to the dead token — that would
  // brick a working account. Only the config.accounts mirror rolls back.
  const dead = {
    name: 'personal', type: 'oauth', accountUuid: 'uuid-p',
    accessToken: 'DEAD-access', refreshToken: 'DEAD-refresh', expiresAt: Date.now() - 1000, enabled: true,
  };
  const am = new AccountManager([{ ...dead }], 0.90);
  am.accounts[0].status = 'error';
  am.accounts[0].refreshDead = true;
  const config = { accounts: [{ ...dead }] };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => { throw new Error('disk full'); } });

  await assert.rejects(() => tui._upsertOAuthAccount({
    creds: { accessToken: 'FRESH-access', refreshToken: 'FRESH-refresh', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-p', email: 'personal' },
    name: 'personal', source: 'login',
  }), /disk full/, 'the persist error is surfaced');

  // AM kept fresh + revived (usable this session; the pre-mortem CHANGE-1 invariant).
  assert.equal(am.accounts[0].refreshToken, 'FRESH-refresh', 'AM NOT reverted to the dead token');
  assert.equal(am.accounts[0].refreshDead, false, 'stays revived');
  assert.equal(am.accounts[0].status, 'active');
  // The config mirror rolls back to the previous entry (disk write did not happen).
  assert.equal(config.accounts[0].refreshToken, 'DEAD-refresh', 'config.accounts reverted');
});
