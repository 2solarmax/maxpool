import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  sameUser, sameAccountIdentity, organizationUnknownMatch, fetchProfile, resolveOrganizations, suggestAccountName,
} from '../src/oauth.js';

// A Claude login is one user (account.uuid) inside one organization
// (organization.uuid). The same user can hold a personal Max org and a Team org
// under one email; each is its own pool account.

const PROFILE_BODY = {
  account: { uuid: 'user-1111', email: 'user@example.com', display_name: 'User', has_claude_max: true, has_claude_pro: false },
  organization: { uuid: 'org-aaaa', name: 'Example Team', organization_type: 'claude_team' },
};

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

// -- the two predicates --

test('sameUser: equal accountUuids only; a missing uuid never matches', () => {
  assert.equal(sameUser({ accountUuid: 'u1' }, { accountUuid: 'u1' }), true);
  assert.equal(sameUser({ accountUuid: 'u1' }, { accountUuid: 'u2' }), false);
  assert.equal(sameUser({ accountUuid: null }, { accountUuid: null }), false, 'two unknown users are not the same user');
  assert.equal(sameUser({}, { accountUuid: 'u1' }), false);
  assert.equal(sameUser(null, { accountUuid: 'u1' }), false);
  assert.equal(sameUser({ accountUuid: 'u1' }, undefined), false);
});

test('sameAccountIdentity: same user AND same organization', () => {
  const personal = { accountUuid: 'u1', organizationUuid: 'org-p' };
  const team = { accountUuid: 'u1', organizationUuid: 'org-t' };
  assert.equal(sameAccountIdentity(personal, { ...personal }), true);
  assert.equal(sameAccountIdentity(personal, team), false, 'same email, same user, another org = another account');
  assert.equal(sameAccountIdentity({ accountUuid: 'u2', organizationUuid: 'org-p' }, personal), false);
});

test('sameAccountIdentity: entries saved before organizations were recorded', () => {
  const old = { accountUuid: 'u1' };
  assert.equal(sameAccountIdentity(old, { accountUuid: 'u1', organizationUuid: null }), true, 'no org on either side = today\'s uuid match');
  assert.equal(sameAccountIdentity(old, { accountUuid: 'u1', organizationUuid: 'org-p' }), false, 'an entry with an org never matches one without');
  assert.equal(sameAccountIdentity({ accountUuid: 'u1', organizationUuid: 'org-p' }, old), false, 'in either direction');
  assert.equal(sameAccountIdentity({}, {}), false);
});

test('organizationUnknownMatch: a same-user entry without an org, only when nothing matches exactly', () => {
  const login = { accountUuid: 'u1', organizationUuid: 'org-t' };
  const unknown = { name: 'old', type: 'oauth', accountUuid: 'u1' };
  const exact = { name: 'team', type: 'oauth', accountUuid: 'u1', organizationUuid: 'org-t' };
  assert.equal(organizationUnknownMatch([unknown], login), unknown, 'the org of this entry could not be read: ask');
  assert.equal(organizationUnknownMatch([unknown, exact], login), null, 'an exact match wins, no question');
  assert.equal(organizationUnknownMatch([{ name: 'other', type: 'oauth', accountUuid: 'u2' }], login), null, 'another user');
  assert.equal(organizationUnknownMatch([{ name: 'api-1', type: 'apikey' }], login), null, 'API key entries never match');
});

// -- the profile carries the organization --

test('fetchProfile returns organizationUuid next to accountUuid', async () => {
  const profile = await withFetch(async () => ({ ok: true, json: async () => PROFILE_BODY }), () => fetchProfile('tok'));
  assert.equal(profile.accountUuid, 'user-1111');
  assert.equal(profile.organizationUuid, 'org-aaaa');
  assert.equal(profile.email, 'user@example.com');
  assert.equal(profile.orgType, 'claude_team');
});

// -- healing old entries: read only, never a refresh --

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

test('resolveOrganizations fills the org of same-user entries that lack one, using their own token', async () => {
  const accounts = [
    { name: 'personal', type: 'oauth', accountUuid: 'u1', accessToken: 'tok-personal', expiresAt: Date.now() + 3600_000 },
    { name: 'other', type: 'oauth', accountUuid: 'u9', accessToken: 'tok-other', expiresAt: Date.now() + 3600_000 },
    { name: 'known', type: 'oauth', accountUuid: 'u1', organizationUuid: 'org-k', accessToken: 'tok-known', expiresAt: Date.now() + 3600_000 },
  ];
  const calls = [];
  const unresolved = await withFetch(async (url, init) => {
    calls.push({ url, auth: init?.headers?.Authorization });
    return { ok: true, json: async () => ({ account: { uuid: 'u1' }, organization: { uuid: 'org-p' } }) };
  }, () => resolveOrganizations(accounts, 'u1'));
  assert.deepEqual(unresolved, []);
  assert.equal(accounts[0].organizationUuid, 'org-p', 'healed from its own profile');
  assert.equal(accounts[1].organizationUuid, undefined, 'another user is not touched');
  assert.equal(accounts[2].organizationUuid, 'org-k', 'an entry that knows its org is not re-read');
  assert.deepEqual(calls, [{ url: PROFILE_URL, auth: 'Bearer tok-personal' }], 'exactly one read-only profile GET');
});

test('resolveOrganizations skips expired or missing tokens and reports them unresolved (never refreshes)', async () => {
  const accounts = [
    { name: 'expired', type: 'oauth', accountUuid: 'u1', accessToken: 'tok', refreshToken: 'r', expiresAt: Date.now() - 1000 },
    { name: 'no-token', type: 'oauth', accountUuid: 'u1', refreshToken: 'r' },
  ];
  let fetched = 0;
  const unresolved = await withFetch(async () => { fetched++; throw new Error('must not be called'); },
    () => resolveOrganizations(accounts, 'u1'));
  assert.equal(fetched, 0, 'no network call at all');
  assert.deepEqual(unresolved.map(a => a.name), ['expired', 'no-token']);
  assert.equal(accounts[0].organizationUuid, undefined);
});

test('resolveOrganizations leaves an entry unresolved when the profile read fails', async () => {
  const accounts = [{ name: 'p', type: 'oauth', accountUuid: 'u1', accessToken: 'tok', expiresAt: Date.now() + 3600_000 }];
  const unresolved = await withFetch(async () => ({ ok: false, status: 401, json: async () => ({}) }),
    () => resolveOrganizations(accounts, 'u1'));
  assert.deepEqual(unresolved.map(a => a.name), ['p']);
  assert.equal(accounts[0].organizationUuid, undefined);
});

test('resolveOrganizations reads the live token through accessTokenOf when given', async () => {
  const accounts = [{ name: 'p', type: 'oauth', accountUuid: 'u1', accessToken: 'stale', expiresAt: Date.now() + 3600_000 }];
  const seen = [];
  await withFetch(async (_url, init) => {
    seen.push(init.headers.Authorization);
    return { ok: true, json: async () => ({ account: { uuid: 'u1' }, organization: { uuid: 'org-p' } }) };
  }, () => resolveOrganizations(accounts, 'u1', () => ({ accessToken: 'live', expiresAt: Date.now() + 3600_000 })));
  assert.deepEqual(seen, ['Bearer live']);
  assert.equal(accounts[0].organizationUuid, 'org-p');
});

// -- the suggested name of a second account under the same email --

test('suggestAccountName: the email when free, "<email> (<type>)" when taken, a counter without a type', () => {
  const taken = [{ name: 'user@example.com', type: 'oauth' }];
  assert.equal(suggestAccountName([], { email: 'user@example.com', orgType: 'claude_team' }), 'user@example.com');
  assert.equal(suggestAccountName(taken, { email: 'user@example.com', orgType: 'claude_team' }), 'user@example.com (team)');
  assert.equal(suggestAccountName(taken, { email: 'user@example.com', orgType: 'claude_max' }), 'user@example.com (max)');
  assert.equal(suggestAccountName(taken, { email: 'user@example.com' }), 'user@example.com (2)');
  assert.equal(suggestAccountName([{ name: 'account-1' }], {}), 'account-2', 'no email: the numbered fallback as before');
  assert.equal(suggestAccountName([], { error: 'HTTP 500' }), 'account-1');
});

// -- every dedupe site goes through the predicates --

test('no raw accountUuid comparison outside oauth.js (a missed site would merge two orgs of one user)', () => {
  const srcDir = fileURLToPath(new URL('../src/', import.meta.url));
  const hits = [];
  for (const f of readdirSync(srcDir)) {
    if (!f.endsWith('.js') || f === 'oauth.js') continue;
    const lines = readFileSync(srcDir + f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/accountUuid\s*[!=]==?/.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(hits, [], `use sameAccountIdentity / sameUser instead:\n${hits.join('\n')}`);
});
