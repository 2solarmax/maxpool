import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { return new Promise(r => server.close(r)); }

const KEY = 'mp-inject-test';

// Manager with one DEAD oauth row (uuid D1) and one HEALTHY oauth row (uuid H1).
// refreshDead/status are RUNTIME verdicts (set by the refresher at failure time),
// not config fields the constructor keeps — set them the way production does.
function managerWithRows() {
  const am = new AccountManager([
    { name: 'dead-row', type: 'oauth', accountUuid: 'D1', accessToken: 'old-acc', refreshToken: 'dead-ref', enabled: true },
    { name: 'healthy-row', type: 'oauth', accountUuid: 'H1', accessToken: 'h-acc', refreshToken: 'h-ref', enabled: true },
  ], 0.9);
  am.accounts[0].refreshDead = true;
  am.accounts[0].status = 'error';
  return am;
}

function injectBody(uuid, { replace, name } = {}) {
  return JSON.stringify({
    account: { name: name || 'injected', type: 'oauth', accountUuid: uuid, accessToken: 'new-acc', refreshToken: 'new-ref', expiresAt: 123456, source: 'remote-login' },
    ...(replace === undefined ? {} : { replace }),
  });
}

async function post(port, body, key = KEY) {
  const res = await fetch(`http://127.0.0.1:${port}/maxpool/accounts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

let am, server, port;

beforeEach(async () => {
  am = managerWithRows();
  server = createProxyServer(am, {
    proxy: { apiKey: KEY, clients: [{ name: 'max', key: KEY }] },
    upstream: 'http://127.0.0.1:1',
    accounts: am.accounts.map(a => ({ ...a })),
  });
  port = await listen(server);
});

afterEach(async () => { await close(server); });

test('re-auth of a dead row: tokens replaced in place, refreshDead cleared, caps/name kept', async () => {
  const { status, json } = await post(port, injectBody('D1'));
  assert.equal(status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.result, 'reauthed');
  const row = am.accounts.find(a => a.accountUuid === 'D1');
  assert.equal(row.refreshToken, 'new-ref');
  assert.equal(row.credential ?? row.accessToken, 'new-acc');
  assert.equal(row.refreshDead, false);
  assert.equal(row.status, 'active');
  assert.equal(row.name, 'dead-row', 'name preserved — inject renames nothing');
});

test('healthy row re-auth (uuid match = same account, always applies — D16 door model)', async () => {
  const { status, json } = await post(port, injectBody('H1'));
  assert.equal(status, 200);
  assert.equal(json.result, 'reauthed');
  assert.equal(am.accounts.find(a => a.accountUuid === 'H1').refreshToken, 'new-ref');
  assert.equal(am.accounts.find(a => a.accountUuid === 'H1').name, 'healthy-row', 'name preserved');
});

test('unknown uuid is ADDED (D16: adds open to any valid key)', async () => {
  const { status, json } = await post(port, injectBody('N3', { name: 'fresh@x.io' }));
  assert.equal(status, 200);
  assert.equal(json.result, 'added');
  const row = am.accounts.find(a => a.accountUuid === 'N3');
  assert.ok(row, 'added to the running manager');
  assert.equal(row.name, 'fresh@x.io');
});

test('keyless caller is rejected 401', async () => {
  const { status } = await post(port, injectBody('D1'), 'wrong-key');
  assert.equal(status, 401);
});

test('malformed body is 400, nothing applied', async () => {
  const { status } = await post(port, JSON.stringify({ account: { type: 'oauth' } }));
  assert.equal(status, 400);
  assert.equal(am.accounts.find(a => a.accountUuid === 'D1').refreshToken, 'dead-ref');
});
