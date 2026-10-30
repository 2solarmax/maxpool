import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { TUI } from '../src/tui.js';

function listen(server) { return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function close(server) { return new Promise(r => server.close(r)); }

// Minimal TUI-shaped this: only the surfaces _sendLoginToRemote/_findRemoteMirrorFor touch.
function stubTui(accounts, logs = []) {
  return {
    am: { accounts },
    _addLog: m => logs.push(m),
    _findRemoteMirrorFor: TUI.prototype._findRemoteMirrorFor,
    _sendLoginToRemote: TUI.prototype._sendLoginToRemote,
    logs,
  };
}

let remote;   // stub team pool capturing the inject
let remotePort;
let received;

beforeEach(async () => {
  received = [];
  remote = http.createServer((req, res) => {
    if (req.url !== '/maxpool/accounts') { res.writeHead(404); res.end('{}'); return; }
    if (req.headers['x-api-key'] !== 'mp-link-key') { res.writeHead(401); res.end('{}'); return; }
    const chunks = []; req.on('data', c => chunks.push(c));
    req.on('end', () => {
      received.push({ body: JSON.parse(Buffer.concat(chunks).toString()) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'reauthed', name: 'reports@gomokka.com' }));
    });
  });
  remotePort = await listen(remote);
});

afterEach(async () => { await close(remote); });

// Built per-test: the stub pool's port only exists after beforeEach listens.
const makeMirror = () => ({
  name: 'reports@gomokka.com',
  remote: { linkName: 'team', remoteName: 'reports@gomokka.com', url: `http://127.0.0.1:${remotePort}`, key: 'mp-link-key' },
  remoteUuid: 'R1',
  refreshDead: true,
  status: 'error',
});

test('mirror match: uuid on a mirror row routes remote; local uuid and no-uuid do not', () => {
  const MIRROR = makeMirror();
  const t = stubTui([MIRROR, { name: 'kira', type: 'oauth', accountUuid: 'L1', refreshToken: 'x' }]);
  assert.equal(t._findRemoteMirrorFor({ accountUuid: 'R1' }), MIRROR);
  assert.equal(t._findRemoteMirrorFor({ accountUuid: 'L1' }), null, 'local account → local path');
  assert.equal(t._findRemoteMirrorFor({ accountUuid: 'ZZZ' }), null);
  assert.equal(t._findRemoteMirrorFor({}), null, 'no uuid → local path (existing behavior)');
});

test('remote login is POSTed with the remote name, dead row implies replace, nothing local', async () => {
  const MIRROR = makeMirror();
  const t = stubTui([MIRROR]);
  const creds = { accessToken: 'acc-1', refreshToken: 'ref-1', expiresAt: 42 };
  await t._sendLoginToRemote(MIRROR, creds, { accountUuid: 'R1', email: 'reports@gomokka.com' });
  assert.equal(received.length, 1);
  const b = received[0].body;
  assert.equal(b.replace, true, 'dead mirror → replace semantics');
  assert.equal(b.account.accountUuid, 'R1');
  assert.equal(b.account.refreshToken, 'ref-1');
  assert.equal(b.account.name, 'reports@gomokka.com', 'remote name used, not any local alias');
  assert.ok(t.logs.some(l => l.includes('team pool')), 'log line written');
});

test('healthy mirror sends replace:false (the pool decides 409 vs apply)', async () => {
  const MIRROR = makeMirror();
  const healthy = { ...MIRROR, refreshDead: false, status: 'active' };
  const t = stubTui([healthy]);
  await t._sendLoginToRemote(healthy, { accessToken: 'a', refreshToken: 'r', expiresAt: 1 }, { accountUuid: 'R1' });
  assert.equal(received[0].body.replace, false);
});

test('unreachable pool surfaces the error and never writes anything locally', async () => {
  const MIRROR = makeMirror();
  const t = stubTui([MIRROR]);
  MIRROR.remote.url = 'http://127.0.0.1:1'; // nothing listens
  const before = JSON.stringify(t.am.accounts);
  await t._sendLoginToRemote(MIRROR, { accessToken: 'a', refreshToken: 'r', expiresAt: 1 }, { accountUuid: 'R1' });
  assert.equal(JSON.stringify(t.am.accounts), before, 'NO local mutation on remote failure');
});
