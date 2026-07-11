import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

function setup(accounts) {
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.90);
  const config = { accounts: accounts.map(a => ({ ...a })) };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {} });
  return { tui, am };
}

const existing = [{
  name: 'max@dubner.io', type: 'oauth', accountUuid: 'uuid-1', source: 'login',
  accessToken: 'old', refreshToken: 'oldR', expiresAt: Date.now() - 1000, enabled: true,
}];

// ── the match that decides "re-authenticate" vs "add new" ─────────────────────

test('_findExistingOAuthAccount: accountUuid wins, email→name is the fallback, else null', () => {
  const { tui } = setup(existing);
  assert.equal(tui._findExistingOAuthAccount({ accountUuid: 'uuid-1', email: 'unrelated@x' })?.name, 'max@dubner.io', 'uuid match');
  assert.equal(tui._findExistingOAuthAccount({ accountUuid: null, email: 'max@dubner.io' })?.name, 'max@dubner.io', 'email→name fallback');
  assert.equal(tui._findExistingOAuthAccount({ accountUuid: 'nope', email: 'nobody@x' }), null, 'no match → new');
  assert.equal(tui._findExistingOAuthAccount({}), null, 'fetchProfile error (no uuid/email) → treated as new');
});

// ── re-auth in place vs add-new, with the authoritative `updated` return ───────

test('_upsertOAuthAccount re-auths an existing (dead) account in place → updated:true, no duplicate, revived', async () => {
  const { tui, am } = setup(existing);
  am.accounts[0].refreshDead = true;
  am.accounts[0].status = 'error';

  const r = await tui._upsertOAuthAccount({
    creds: { accessToken: 'new', refreshToken: 'newR', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-1', email: 'max@dubner.io' },
    name: 'max@dubner.io', source: 'login',
  });

  assert.equal(r.updated, true, 're-auth, not add');
  assert.equal(am.accounts.filter(a => a.name === 'max@dubner.io').length, 1, 'no duplicate');
  assert.equal(am.accounts[0].credential, 'new', 'fresh token swapped in place');
  assert.equal(am.accounts[0].refreshDead, false, 'dead-refresh account revived');
  assert.equal(am.accounts[0].status, 'active');
});

test('_upsertOAuthAccount adds a genuinely new account → updated:false', async () => {
  const { tui, am } = setup(existing);
  const r = await tui._upsertOAuthAccount({
    creds: { accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-2', email: 'brand-new@x' },
    name: 'brand-new@x', source: 'login',
  });
  assert.equal(r.updated, false, 'add, not re-auth');
  assert.equal(am.accounts.length, 2);
  assert.ok(am.accounts.some(a => a.name === 'brand-new@x'));
});

test('a manually-typed name colliding with a DIFFERENT existing account still returns updated:true (message never lies "Added")', async () => {
  // Two existing accounts; a login for a 3rd Claude account, but the user types an
  // existing name → upsert matches by name → in-place overwrite → updated:true.
  const { tui } = setup([
    { name: 'acct-a', type: 'oauth', accountUuid: 'uuid-a', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'acct-b', type: 'oauth', accountUuid: 'uuid-b', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ]);
  const r = await tui._upsertOAuthAccount({
    creds: { accessToken: 'z', refreshToken: 'z', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: 'uuid-c', email: 'c@x' }, // 3rd account, uuid-c not present
    name: 'acct-b', // ...but user typed an existing name
    source: 'login',
  });
  assert.equal(r.updated, true, 'name-collision → in-place update → the flow must NOT print "Added new account"');
});
