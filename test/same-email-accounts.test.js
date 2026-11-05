import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

// One Claude user (one email) with a personal Max org and a Team org: two pool
// accounts that must never be merged, while a login to an org already in the
// pool still re-authenticates that entry in place.

const EMAIL = 'user@example.com';
const USER = 'user-1111';
const PERSONAL_ORG = 'org-personal';
const TEAM_ORG = 'org-team';

const fresh = () => ({ accessToken: 'new-a', refreshToken: 'new-r', expiresAt: Date.now() + 3600_000 });
const personalProfile = { accountUuid: USER, organizationUuid: PERSONAL_ORG, email: EMAIL, orgType: 'claude_max' };
const teamProfile = { accountUuid: USER, organizationUuid: TEAM_ORG, email: EMAIL, orgType: 'claude_team' };

function personalEntry(extra = {}) {
  return {
    name: 'personal', type: 'oauth', source: 'login', accountUuid: USER, organizationUuid: PERSONAL_ORG,
    accessToken: 'p-a', refreshToken: 'p-r', expiresAt: Date.now() + 3600_000, enabled: true, ...extra,
  };
}

function setup(accounts) {
  const am = new AccountManager(accounts.map(a => ({ ...a })), 0.90);
  const config = { accounts: accounts.map(a => ({ ...a })) };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {} });
  return { tui, am, config };
}

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// -- AccountManager carries the organization --

test('AccountManager keeps organizationUuid from config and from addAccount', () => {
  const am = new AccountManager([personalEntry()], 0.90);
  assert.equal(am.accounts[0].organizationUuid, PERSONAL_ORG);
  am.addAccount(personalEntry({ name: 'team', organizationUuid: TEAM_ORG }));
  assert.equal(am.accounts[1].organizationUuid, TEAM_ORG);
  am.addAccount({ name: 'old', type: 'oauth', accountUuid: USER, accessToken: 't' });
  assert.equal(am.accounts[2].organizationUuid, null);
});

test('quota state is restored to the right org of the same user', () => {
  const am = new AccountManager([personalEntry(), personalEntry({ name: 'team', organizationUuid: TEAM_ORG })], 0.90);
  am.accounts[1].quota.unified7d = 0.42;
  am.accounts[1].quota.unified7dReset = Date.now() + 86_400_000;
  const saved = am.exportQuotaState();
  assert.equal(saved[1].organizationUuid, TEAM_ORG, 'state.json names the org');

  const again = new AccountManager([personalEntry(), personalEntry({ name: 'team', organizationUuid: TEAM_ORG })], 0.90);
  again.restoreQuotaState(saved);
  assert.equal(again.accounts[0].quota.unified7d, null, 'the personal org did not inherit the Team quota');
  assert.equal(again.accounts[1].quota.unified7d, 0.42);
});

test('quota saved before organizations were recorded is restored to the same user with the same name', () => {
  const saved = [{ accountUuid: USER, name: 'personal', quota: { unified7d: 0.31, unified7dReset: Date.now() + 86_400_000 } }];
  const am = new AccountManager([personalEntry(), personalEntry({ name: 'team', organizationUuid: TEAM_ORG })], 0.90);
  am.restoreQuotaState(saved);
  assert.equal(am.accounts[0].quota.unified7d, 0.31, 'the healed personal account keeps its quota across the upgrade');
  assert.equal(am.accounts[1].quota.unified7d, null, 'the Team account of the same user is not touched');
});

// -- the match that decides re-authenticate vs add --

test('_findExistingOAuthAccount: the same user in another org is a new account', () => {
  const { tui } = setup([personalEntry()]);
  assert.equal(tui._findExistingOAuthAccount(teamProfile), null, 'Team org of the same user: add');
  assert.equal(tui._findExistingOAuthAccount(personalProfile)?.name, 'personal', 'same org: re-authenticate');
});

test('_findExistingOAuthAccount: an entry that does not know its org is returned so the login can ask', () => {
  const { tui } = setup([personalEntry({ organizationUuid: undefined })]);
  assert.equal(tui._findExistingOAuthAccount(teamProfile)?.name, 'personal');
  assert.equal(tui._organizationUnknown(tui._findExistingOAuthAccount(teamProfile), teamProfile), true);
  const { tui: known } = setup([personalEntry()]);
  assert.equal(known._organizationUnknown(known._findExistingOAuthAccount(personalProfile), personalProfile), false);
});

test('_findExistingOAuthAccount: an exact match wins over a same-user entry with an unknown org', () => {
  const { tui } = setup([personalEntry({ organizationUuid: undefined }), personalEntry({ name: 'team', organizationUuid: TEAM_ORG })]);
  const found = tui._findExistingOAuthAccount(teamProfile);
  assert.equal(found?.name, 'team');
  assert.equal(tui._organizationUnknown(found, teamProfile), false, 'no question when the login matches exactly');
});

test('_findExistingOAuthAccount: an entry saved before uuids existed still matches by its email name, without a question', () => {
  const { tui } = setup([{ name: EMAIL, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 }]);
  const found = tui._findExistingOAuthAccount(personalProfile);
  assert.equal(found?.name, EMAIL);
  assert.equal(tui._organizationUnknown(found, personalProfile), false);
});

test('_confirmReauth: Enter or r keeps the entry, a drops it, anything else asks again', async () => {
  const { tui } = setup([personalEntry()]);
  const existing = tui.config.accounts[0];
  const answers = (...list) => { tui._askLine = async () => list.shift(); };
  answers(''); assert.equal(await tui._confirmReauth(existing), existing);
  answers('R'); assert.equal(await tui._confirmReauth(existing), existing);
  answers('a'); assert.equal(await tui._confirmReauth(existing), null);
  answers('add'); assert.equal(await tui._confirmReauth(existing), null);
  answers('re-authenticate'); assert.equal(await tui._confirmReauth(existing), existing);
  let asked = 0;
  tui._askLine = async () => (++asked === 1 ? 'x' : 'a');
  assert.equal(await tui._confirmReauth(existing), null);
  assert.equal(asked, 2, 'an unknown answer is asked again');
});

test('_matchLogin heals an old entry from its live token and then adds the Team org without asking', async () => {
  const { tui, am, config } = setup([personalEntry({ organizationUuid: undefined })]);
  am.accounts[0].credential = 'live-token';
  tui._askLine = async () => { throw new Error('must not ask'); };
  const seen = [];
  const existing = await withFetch(async (_url, init) => {
    seen.push(init.headers.Authorization);
    return { ok: true, json: async () => ({ account: { uuid: USER }, organization: { uuid: PERSONAL_ORG } }) };
  }, () => tui._matchLogin(teamProfile));
  assert.equal(existing, null, 'Team org: a second account');
  assert.deepEqual(seen, ['Bearer live-token'], 'read with the running account\'s live token');
  assert.equal(config.accounts[0].organizationUuid, PERSONAL_ORG, 'config entry healed');
  assert.equal(am.accounts[0].organizationUuid, PERSONAL_ORG, 'running account healed');
});

test('_matchLogin asks when the old entry\'s org cannot be read', async () => {
  const { tui, am } = setup([personalEntry({ organizationUuid: undefined })]);
  am.accounts[0].expiresAt = Date.now() - 1000;
  let fetched = 0;
  tui._askLine = async () => 'a';
  const existing = await withFetch(async () => { fetched++; throw new Error('must not be called'); },
    () => tui._matchLogin(teamProfile));
  assert.equal(fetched, 0, 'an expired token is never used or refreshed');
  assert.equal(existing, null, 'the user chose to add a second account');
  tui._askLine = async () => 'r';
  assert.equal((await tui._matchLogin(teamProfile))?.name, 'personal', 'the user chose to re-authenticate');
});

// -- upsert: two orgs of one user coexist --

test('_upsertOAuthAccount adds the Team org beside the personal org and leaves the first untouched', async () => {
  const { tui, am, config } = setup([personalEntry()]);
  const r = await tui._upsertOAuthAccount({ creds: fresh(), profile: teamProfile, name: `${EMAIL} (team)`, source: 'login' });
  assert.equal(r.updated, false, 'added, not re-authenticated');
  assert.equal(config.accounts.length, 2);
  assert.equal(config.accounts[0].accessToken, 'p-a', 'the personal token was not replaced');
  assert.equal(config.accounts[1].organizationUuid, TEAM_ORG);
  assert.equal(am.accounts.length, 2);
  assert.equal(am.accounts[1].organizationUuid, TEAM_ORG);
  assert.equal(am.accounts[0].credential, 'p-a');
});

test('_upsertOAuthAccount re-authenticates the same org in place and records the org on an old entry', async () => {
  const { tui, am, config } = setup([personalEntry({ organizationUuid: undefined })]);
  const r = await tui._upsertOAuthAccount({ creds: fresh(), profile: personalProfile, name: 'personal', source: 'login' });
  assert.equal(r.updated, true);
  assert.equal(config.accounts.length, 1);
  assert.equal(config.accounts[0].organizationUuid, PERSONAL_ORG);
  assert.equal(am.accounts[0].organizationUuid, PERSONAL_ORG);
  assert.equal(am.accounts[0].credential, 'new-a');
});

test('_configAccountIndex tells the two orgs of one user apart', () => {
  const { tui, am } = setup([personalEntry(), personalEntry({ name: 'team', organizationUuid: TEAM_ORG })]);
  assert.equal(tui._configAccountIndex(am.accounts[1]), 1);
  assert.equal(tui._configAccountIndex(am.accounts[0]), 0);
});

// -- the confirm texts stay true --

test('both browser-login confirms say that another org of the same user is added, not merged', () => {
  const { tui } = setup([personalEntry()]);
  tui.mode = 'accounts';
  tui._keyAccounts('l');
  assert.match(tui.confirmDetail, /same organization/i);
  assert.match(tui.confirmDetail, /another organization/i);
  tui._clearConfirm();
  tui._addAccountOfType('anthropic-oauth');
  assert.match(tui.confirmDetail, /another organization/i);
});
