import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { TUI } from '../src/tui.js';
import { remoteIdentities, computeDuplicates } from '../src/pool-link.js';
import { suggestAccountName } from '../src/oauth.js';

// One Claude login (accountUuid) can belong to two organizations. Rows saved
// before organizations were recorded ("org-less") must heal instead of
// duplicating, and two KNOWN organizations must never share tokens by name.

// ISOLATION: the inject endpoint persists through atomicConfigUpdate(), which
// resolves the config path from the environment. Pin it to a temp file before
// any request is made so the developer's real config is never touched.
const ISOLATED_DIR = mkdtempSync(join(tmpdir(), 'mp-org-legacy-'));
const ISOLATED_CONFIG = join(ISOLATED_DIR, 'config.json');
writeFileSync(ISOLATED_CONFIG, JSON.stringify({ proxy: {}, accounts: [] }));
process.env.MAXPOOL_CONFIG = ISOLATED_CONFIG;
import('../src/config.js').then(({ getConfigPath }) => {
  assert.equal(getConfigPath(), ISOLATED_CONFIG, 'test config isolation broken — ABORT before touching a real config');
});

const U1 = 'user-1111';
const O1 = 'org-one';
const O2 = 'org-two';
const NAME = 'me@x.io';
const KEY = 'mp-org-legacy-key';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { return new Promise(r => server.close(r)); }

const row = (over = {}) => ({
  name: NAME, type: 'oauth', accountUuid: U1, accessToken: 'T1-acc', refreshToken: 'T1-ref',
  expiresAt: Date.now() + 3600_000, enabled: true, ...over,
});

const readDisk = () => JSON.parse(readFileSync(ISOLATED_CONFIG, 'utf8'));

async function inject(port, account) {
  const res = await fetch(`http://127.0.0.1:${port}/maxpool/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': KEY },
    body: JSON.stringify({ account: { type: 'oauth', source: 'remote-login', expiresAt: 123456, ...account } }),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

// -- server inject --

let server;
async function startPool(entries) {
  writeFileSync(ISOLATED_CONFIG, JSON.stringify({ proxy: {}, accounts: entries.map(e => ({ ...e })) }));
  const am = new AccountManager(entries.map(e => ({ ...e })), 0.9);
  const config = { proxy: { apiKey: KEY, clients: [{ name: 'max', key: KEY }] }, upstream: 'http://127.0.0.1:1', accounts: entries.map(e => ({ ...e })) };
  server = createProxyServer(am, config);
  const port = await listen(server);
  return { am, config, port };
}
afterEach(async () => { if (server) { await close(server); server = null; } });

test('inject: a login with an org re-authenticates the pool\'s org-less row of that user (no duplicate, org stamped everywhere)', async () => {
  const { am, config, port } = await startPool([row()]);
  const { status, json } = await inject(port, { name: NAME, accountUuid: U1, organizationUuid: O1, accessToken: 'T2-acc', refreshToken: 'T2-ref' });
  assert.equal(status, 200);
  assert.equal(json.result, 'reauthed');

  const amRows = am.accounts.filter(a => a.accountUuid === U1);
  assert.equal(amRows.length, 1, 'exactly one AccountManager row for the user');
  assert.equal(amRows[0].refreshToken, 'T2-ref');
  assert.equal(amRows[0].credential, 'T2-acc');
  assert.equal(amRows[0].organizationUuid, O1);

  const diskRows = readDisk().accounts.filter(a => a.accountUuid === U1);
  assert.equal(diskRows.length, 1, 'exactly one disk entry');
  assert.equal(diskRows[0].refreshToken, 'T2-ref');
  assert.equal(diskRows[0].organizationUuid, O1);

  const memRows = config.accounts.filter(a => a.accountUuid === U1);
  assert.equal(memRows.length, 1, 'exactly one config-mirror entry');
  assert.equal(memRows[0].refreshToken, 'T2-ref');
  assert.equal(memRows[0].organizationUuid, O1);
});

test('inject: the same user in a second org with the same name is ADDED under a different name; the first org keeps its tokens', async () => {
  const { am, config, port } = await startPool([row({ organizationUuid: O1 })]);
  const { status, json } = await inject(port, { name: NAME, accountUuid: U1, organizationUuid: O2, orgType: 'claude_team', accessToken: 'T2-acc', refreshToken: 'T2-ref' });
  assert.equal(status, 200);
  assert.equal(json.result, 'added');

  const added = am.accounts.find(a => a.organizationUuid === O2);
  assert.ok(added, 'the second org is a new row');
  assert.equal(added.refreshToken, 'T2-ref');

  const first = am.accounts.find(a => a.organizationUuid === O1);
  assert.equal(first.name, NAME);
  assert.equal(first.refreshToken, 'T1-ref', 'AccountManager: org one keeps its tokens');
  assert.equal(first.credential, 'T1-acc');

  const disk = readDisk().accounts;
  assert.equal(disk.length, 2);
  assert.equal(disk.find(a => a.organizationUuid === O1).refreshToken, 'T1-ref', 'disk: org one keeps its tokens');
  assert.equal(disk.find(a => a.organizationUuid === O2).refreshToken, 'T2-ref');
  assert.notEqual(disk.find(a => a.organizationUuid === O2).name, NAME);

  assert.equal(config.accounts.length, 2);
  assert.equal(config.accounts.find(a => a.organizationUuid === O1).refreshToken, 'T1-ref', 'mirror: org one keeps its tokens');
  assert.notEqual(config.accounts.find(a => a.organizationUuid === O2).name, NAME);
});

// The running AccountManager row takes the same unique name as the disk row and the
// config mirror, so name-keyed lookups inside the live pool never collide.
test('inject: the running AccountManager row of a second org also gets a unique name', async () => {
  const { am, port } = await startPool([row({ organizationUuid: O1 })]);
  await inject(port, { name: NAME, accountUuid: U1, organizationUuid: O2, orgType: 'claude_team', accessToken: 'T2-acc', refreshToken: 'T2-ref' });
  assert.notEqual(am.accounts.find(a => a.organizationUuid === O2).name, NAME);
});

// -- duplicate guard against a linked pool --

const status = (...accounts) => ({ accounts: accounts.map(a => ({ type: 'oauth', enabled: true, name: 'remote', ...a })) });
const local = (over) => ({ index: 0, type: 'oauth', accountUuid: U1, ...over });
const dupes = (localRow, remoteStatus) => computeDuplicates([localRow], remoteIdentities(remoteStatus));

test('duplicate guard: org-bearing and org-less copies of one user bench in both directions; two known different orgs do not; ambiguity does not', () => {
  // (a) local U1/O1 vs remote org-less U1
  assert.equal(dupes(local({ organizationUuid: O1 }), status({ accountUuid: U1 })).length, 1, '3a: local org vs remote org-less → benched');
  // (b) local org-less U1 vs remote U1/O1
  assert.equal(dupes(local({}), status({ accountUuid: U1, organizationUuid: O1 })).length, 1, '3b: local org-less vs remote org → benched');
  // (c) local U1/O1 vs remote U1/O2
  assert.equal(dupes(local({ organizationUuid: O1 }), status({ accountUuid: U1, organizationUuid: O2 })).length, 0, '3c: two known different orgs → not benched');
  // (e) local U1/O1 vs remote U1/O1
  assert.equal(dupes(local({ organizationUuid: O1 }), status({ accountUuid: U1, organizationUuid: O1 })).length, 1, '3e: same org → benched');
});

test('duplicate guard: an org-less local copy against two remote orgs of the user is ambiguous and not benched', () => {
  const remote = status({ accountUuid: U1, organizationUuid: O1 }, { accountUuid: U1, organizationUuid: O2 });
  assert.equal(dupes(local({}), remote).length, 0, '3d: ambiguous → not benched');
  // control: an exact org-bearing local copy still benches against the same remote
  assert.equal(dupes(local({ organizationUuid: O2 }), remote).length, 1);
});

// -- TUI: remote mirror lookup --

const mirror = (name, over = {}) => ({ name, remote: { linkName: 'team', remoteName: name, url: 'http://127.0.0.1:1', key: 'k' }, remoteUuid: U1, ...over });
const mirrorLookup = (accounts, profile) => TUI.prototype._findRemoteMirrorFor.call({ am: { accounts } }, profile);
const PROFILE = { accountUuid: U1, organizationUuid: O1 };

test('mirror lookup: a login finds the single org-less mirror of its user', () => {
  const m = mirror('cloud-1');
  assert.equal(mirrorLookup([m], PROFILE), m);
});

test('mirror lookup: a mirror of a known DIFFERENT org is not the login\'s', () => {
  assert.equal(mirrorLookup([mirror('cloud-2', { remoteOrganizationUuid: O2 })], PROFILE), null);
});

test('mirror lookup: the exact org mirror wins over an org-less mirror of the same user', () => {
  const exact = mirror('cloud-exact', { remoteOrganizationUuid: O1 });
  const legacy = mirror('cloud-legacy');
  assert.equal(mirrorLookup([legacy, exact], PROFILE), exact);
  assert.equal(mirrorLookup([exact, legacy], PROFILE), exact);
});

test('mirror lookup: two org-less mirrors of the user are ambiguous → null', () => {
  assert.equal(mirrorLookup([mirror('cloud-a'), mirror('cloud-b')], PROFILE), null);
});

// -- TUI: upsert never crosses organizations by name --

test('upsert: a login to a second org under the same name adds a row and leaves the first org\'s tokens alone', async () => {
  const entries = [row({ organizationUuid: O1 })];
  const am = new AccountManager(entries.map(e => ({ ...e })), 0.9);
  const config = { accounts: entries.map(e => ({ ...e })) };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {} });
  const result = await tui._upsertOAuthAccount({
    creds: { accessToken: 'T2-acc', refreshToken: 'T2-ref', expiresAt: Date.now() + 3600_000 },
    profile: { accountUuid: U1, organizationUuid: O2, email: NAME, orgType: 'claude_team' },
    name: NAME, source: 'login',
  });
  assert.equal(result.updated, false, 'a new row, not a re-auth');

  const cfgRows = config.accounts.filter(a => a.accountUuid === U1);
  assert.equal(cfgRows.length, 2);
  assert.equal(cfgRows.find(a => a.organizationUuid === O1).refreshToken, 'T1-ref', 'config: org one still has T1');
  assert.equal(cfgRows.find(a => a.organizationUuid === O2).refreshToken, 'T2-ref');

  const amOne = am.accounts.find(a => a.organizationUuid === O1);
  assert.equal(amOne.refreshToken, 'T1-ref', 'AccountManager: org one still has T1');
  assert.equal(amOne.credential, 'T1-acc');
});

// -- naming --

test('suggestAccountName: a third org never reuses a name that is taken', () => {
  const accounts = [{ name: NAME }, { name: `${NAME} (team)` }];
  const name = suggestAccountName(accounts, { email: NAME, orgType: 'claude_team' });
  assert.ok(![NAME, `${NAME} (team)`].includes(name), `got a taken name: ${name}`);
  assert.equal(name, `${NAME} (team 2)`);
});

// -- capacity: peers and groups --

function roomy(am, now) {
  for (const a of am.accounts) {
    a.quota.unified7d = 0.3; a.quota.unified7dReset = now + 3 * 86400_000;
    a.quota.unified5h = 0.2; a.quota.unified5hReset = now + 3 * 3600_000;
    a.quota.lastProbeOkAt = now;
  }
}

test('countPeersWithRoom: the same user\'s OTHER organization is a separate subscription and counts as a peer', () => {
  const now = Date.now();
  const am = new AccountManager([
    row({ name: 'one', organizationUuid: O1, accessToken: 'a1', refreshToken: 'r1' }),
    row({ name: 'two', organizationUuid: O2, accessToken: 'a2', refreshToken: 'r2' }),
  ], 0.9);
  roomy(am, now);
  assert.equal(am.countPeersWithRoom(am.accounts[0], now), 1);
});

test('capacityGroupOf: an org-less mirror groups with the one-org local row; a second known org splits them', () => {
  const am = new AccountManager([
    row({ name: 'one', organizationUuid: O1, accessToken: 'a1', refreshToken: 'r1' }),
    row({ name: 'cloud-legacy', accessToken: 'a9', refreshToken: 'r9' }),
  ], 0.9);
  const localOne = am.accounts[0];
  // The second constructor entry stands in for a mirror: it carries only the remote's uuid, no org.
  const mir = am.accounts[1];
  mir.remote = { linkName: 'team', remoteName: 'cloud-legacy', url: 'http://127.0.0.1:1', key: 'k' };
  mir.remoteUuid = U1;
  mir.accountUuid = null;
  mir.organizationUuid = null;

  const group = am.capacityGroupOf(localOne);
  assert.ok(group.includes(localOne) && group.includes(mir), 'single known org: local row and org-less mirror are one group');

  am.addAccount(row({ name: 'two', organizationUuid: O2, accessToken: 'a2', refreshToken: 'r2' }));
  const other = am.accounts.find(a => a.organizationUuid === O2);
  const split = am.capacityGroupOf(localOne);
  assert.ok(!split.includes(other), 'the second org is not in the first org\'s group');
  assert.ok(split.includes(localOne));
});

// ── round-2 verification: the reverse healing direction and wildcard ambiguity ──

test('inject from an OLDER client (no organizationUuid) re-authenticates the one org-bearing row, no duplicate', async () => {
  const { am, port } = await startPool([row({ organizationUuid: O1 })]);
  await inject(port, { name: NAME, accountUuid: U1, accessToken: 'T2-acc', refreshToken: 'T2-ref' }); // no org
  const rows = am.accounts.filter(a => a.accountUuid === U1);
  assert.equal(rows.length, 1, 'no second row for the same subscription');
  assert.equal(rows[0].organizationUuid, O1, 'the row keeps its known org');
  assert.equal(rows[0].refreshToken, 'T2-ref');
});

test('one org-less remote row never benches BOTH local orgs of a user (local-side ambiguity)', async () => {
  const { remoteIdentities, computeDuplicates } = await import('../src/pool-link.js');
  const ids = remoteIdentities({ accounts: [{ name: 'u@x (cloud)', type: 'oauth', accountUuid: U1, enabled: true }] });
  const local = [
    { name: 'u@x', type: 'oauth', accountUuid: U1, organizationUuid: O1, index: 0 },
    { name: 'u@x (team)', type: 'oauth', accountUuid: U1, organizationUuid: 'org-two', index: 1 },
  ];
  assert.equal(computeDuplicates(local, ids).length, 0, 'ambiguous: bench neither local org');
  // control: a single local org still benches against the org-less remote row
  const single = [local[0]];
  single[0] = { ...local[0], index: 0 };
  assert.equal(computeDuplicates([single[0]], ids).length, 1, 'one local org → benched');
});
