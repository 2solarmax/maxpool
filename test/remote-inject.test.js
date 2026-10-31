import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';

// ISOLATION (2026-10-30 incident): the inject endpoint persists through
// atomicConfigUpdate(), which resolves the config path from the ENVIRONMENT.
// Without this pin, `node --test test/remote-inject.test.js` on a dev machine
// wrote "injected"/"fresh@x.io" test rows into the developer's REAL pool config
// (owner report: "What the hell is all this crap?"). node:test runs each file
// in its own process, so pinning here cannot leak into other test files.
const ISOLATED_DIR = mkdtempSync(join(tmpdir(), 'mp-inject-test-'));
const ISOLATED_CONFIG = join(ISOLATED_DIR, 'config.json');
writeFileSync(ISOLATED_CONFIG, JSON.stringify({ proxy: {}, accounts: [] }));
process.env.MAXPOOL_CONFIG = ISOLATED_CONFIG;
// The pin must be in effect before any import reads the path lazily at call
// time — assert it so a future refactor to import-time resolution fails here
// instead of writing to the real config again.
import('../src/config.js').then(({ getConfigPath }) => {
  assert.equal(getConfigPath(), ISOLATED_CONFIG, 'test config isolation broken — ABORT before touching a real config');
});

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

test('disk persist lands in the ISOLATED test config, never the real one', async () => {
  await post(port, injectBody('N9', { name: 'disk-check' }));
  const isolated = JSON.parse(readFileSync(ISOLATED_CONFIG, 'utf8'));
  assert.ok(isolated.accounts.some(a => a.accountUuid === 'N9'), 'persisted to isolated config');
});

test('inject: terminal control characters are stripped from the account name before it is stored', async () => {
  const am = new AccountManager([], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: KEY } });
  const port = await listen(proxy);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: injectBody('NEW1', { name: 'evil\x1b]52;c;aGk=\x07row' }),
    });
    assert.equal(res.status, 200);
    const names = am.accounts.map(a => a.name).join('|') + JSON.parse(readFileSync(ISOLATED_CONFIG, 'utf8')).accounts.map(a => a.name).join('|');
    assert.doesNotMatch(names, /\x1b|\x07/, 'no control byte reaches memory or disk');
    assert.match(names, /evil\]52;c;aGk=row/);
  } finally { await close(proxy); }
});

test('inject: an oversized body answers 413 and stores nothing', async () => {
  const am = new AccountManager([], 0.9);
  const proxy = createProxyServer(am, { proxy: { apiKey: KEY } });
  const port = await listen(proxy);
  try {
    const before = am.accounts.length;
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: 'x'.repeat(300 * 1024),
    });
    assert.equal(res.status, 413);
    assert.equal(am.accounts.length, before);
  } finally { await close(proxy); }
});

test('inject: a disk-persist failure answers an error, never "ok" (the login must be retried)', async () => {
  const am = managerWithRows();
  const proxy = createProxyServer(am, { proxy: { apiKey: KEY } });
  const port = await listen(proxy);
  // Poisons nothing: config.js caches the resolved path per process, so the
  // endpoint still targets the ISOLATED config. Force the persist to fail by
  // making the isolated file a DIRECTORY (rename aside, mkdir in its place).
  const { renameSync, mkdirSync, rmSync } = await import('node:fs');
  renameSync(ISOLATED_CONFIG, ISOLATED_CONFIG + '.aside');
  mkdirSync(ISOLATED_CONFIG);
  try {
    const res = await fetch(`http://127.0.0.1:${port}/maxpool/accounts`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY },
      body: injectBody('D1'),
    });
    const json = await res.json();
    assert.notEqual(res.status, 200);
    assert.equal(json.ok, false);
    assert.equal(json.error, 'not_persisted');
  } finally {
    rmSync(ISOLATED_CONFIG, { recursive: true });
    renameSync(ISOLATED_CONFIG + '.aside', ISOLATED_CONFIG);
    await close(proxy);
  }
});
