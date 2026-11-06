import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TUI, decideLoginTarget } from '../src/tui.js';

function listen(s) { return new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port))); }
function close(s) { return new Promise(r => s.close(r)); }

let cloud, port, received, status;
beforeEach(async () => {
  received = []; status = 200;
  cloud = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ url: req.url, key: req.headers['x-api-key'], body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status === 200 ? { ok: true, result: 'added' } : { ok: false, error: 'boom' }));
    });
  });
  port = await listen(cloud);
});
afterEach(async () => { await close(cloud); });

// TUI-shaped `this` with scripted answers to the readline prompts.
function stubTui({ links, accounts = [], answers }) {
  const asked = [], local = [], logs = [];
  const t = {
    am: { accounts, poolLinks: links },
    config: { accounts: [] },
    asked, local, logs,
    _addLog: m => logs.push(m),
    _ask: async q => { asked.push(q); return answers.shift(); },
    _upsertOAuthAccount: async a => { local.push(a); return { updated: false }; },
    _findExistingOAuthAccount: () => null,
  };
  for (const k of ['_routeLogin', '_findRemoteMirrorFor', '_sendLoginToRemote', '_sendLoginToTarget']) t[k] = TUI.prototype[k];
  return t;
}
const creds = { accessToken: 'acc', refreshToken: 'ref', expiresAt: 42 };
const profile = { accountUuid: 'NEW1', email: 'new@x.com' };
const link = () => ({ name: 'team', url: `http://127.0.0.1:${port}`, key: 'k1' });

test('decideLoginTarget: mirror > existing > keyed link > local', () => {
  assert.equal(decideLoginTarget({ mirror: { a: 1 }, links: [link()] }).kind, 'mirror');
  assert.equal(decideLoginTarget({ links: [link()], existing: {}, accountUuid: 'u' }).kind, 'local');
  assert.equal(decideLoginTarget({ links: [{ name: 'x', url: 'u' }], accountUuid: 'u' }).kind, 'local', 'link without key');
  assert.equal(decideLoginTarget({ links: [], accountUuid: 'u' }).kind, 'local');
  assert.equal(decideLoginTarget({ links: [{ name: 'a', url: 'u' }, { name: 'b', url: 'u', key: 'k' }], accountUuid: 'u' }).link.name, 'b');
});

test('(a) new account + linked pool + default answer → one POST, nothing local', async () => {
  const t = stubTui({ links: [link()], answers: ['', ''] });
  await t._routeLogin(creds, profile);
  assert.match(t.asked[0], /Add it to the team pool "team"/);
  assert.equal(received.length, 1);
  assert.equal(received[0].url, '/maxpool/accounts');
  assert.equal(received[0].key, 'k1');
  assert.deepEqual(received[0].body.account, {
    name: 'new@x.com', type: 'oauth', accountUuid: 'NEW1',
    accessToken: 'acc', refreshToken: 'ref', expiresAt: 42, source: 'remote-login',
  });
  assert.equal(t.local.length, 0);
});

test("(b) answer 'l' → local save, no POST", async () => {
  const t = stubTui({ links: [link()], answers: ['L', 'mine'] });
  await t._routeLogin(creds, profile);
  assert.equal(received.length, 0);
  assert.equal(t.local.length, 1);
  assert.equal(t.local[0].name, 'mine');
});

test('(c) no linked pool → no team prompt, local save', async () => {
  const t = stubTui({ links: [], answers: [''] });
  await t._routeLogin(creds, profile);
  assert.equal(t.asked.length, 1);
  assert.match(t.asked[0], /Name this NEW account/);
  assert.equal(received.length, 0);
  assert.equal(t.local.length, 1);
});

test('(d) cloud 500 → nothing saved locally', async () => {
  status = 500;
  const t = stubTui({ links: [link()], answers: ['t', ''] });
  await t._routeLogin(creds, profile);
  assert.equal(received.length, 1);
  assert.equal(t.local.length, 0);
});

test('(e) existing mirror re-login: POST with remote name, no prompt', async () => {
  const mirror = { name: 'm', remoteUuid: 'NEW1', remote: { linkName: 'team', remoteName: 'rn', url: `http://127.0.0.1:${port}`, key: 'k1' } };
  const t = stubTui({ links: [link()], accounts: [mirror], answers: [] });
  await t._routeLogin(creds, profile);
  assert.equal(t.asked.length, 0);
  assert.equal(received.length, 1);
  assert.equal(received[0].body.account.name, 'rn');
  assert.equal(t.local.length, 0);
});

test('decideLoginTarget: keyed link but no account id → no-uuid (never offered)', () => {
  assert.equal(decideLoginTarget({ links: [link()] }).kind, 'no-uuid');
  assert.equal(decideLoginTarget({ links: [link()], existing: {} }).kind, 'local', 'existing local still re-auths');
});

test('(f) uuid-less profile + linked pool → message, no prompt, no POST, nothing local', async () => {
  const t = stubTui({ links: [link()], answers: [] });
  const out = [];
  const orig = process.stdout.write;
  process.stdout.write = (c) => { out.push(String(c)); return true; };
  try { await t._routeLogin(creds, { email: 'new@x.com' }); } finally { process.stdout.write = orig; }
  assert.match(out.join(''), /Could not read this account's id/);
  assert.equal(t.asked.length, 0);
  assert.equal(received.length, 0);
  assert.equal(t.local.length, 0);
});
