// title-sync unit tests — the /rename name must reach the Remote Control title,
// and must never do anything else.
//
// The defects this suite keeps dead:
//   1. pushes a `derived` or missing name (would overwrite a good title with junk)
//   2. pushes a session with no bridgeSessionId (nothing to address)
//   3. re-pushes an unchanged name every cycle (write amplification on every tick)
//   4. keeps hammering a session the server rejects (archived/deleted)
//   5. keeps using a credential the server has rejected (401 must disarm)
//   6. acts before any authenticated request has been observed
import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GATE_DIR = join(__dirname, '..', 'tools', 'rc-gate');

// A TLS upstream standing in for api.anthropic.com, using the gate's own mkcert pair.
function fakeUpstream(handler) {
  const server = https.createServer({
    cert: readFileSync(join(GATE_DIR, 'anthropic-mitm.crt')),
    key: readFileSync(join(GATE_DIR, 'anthropic-mitm.key')),
  }, (req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => handler(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  return server;
}

function listen(server) {
  return new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

function sessionsDir(entries) {
  const dir = mkdtempSync(join(tmpdir(), 'ts-sessions-'));
  entries.forEach((e, i) => writeFileSync(join(dir, `${1000 + i}.json`), JSON.stringify(e)));
  return dir;
}

// Deliberately WITHOUT anthropic-version: /api/* flag and profile calls omit it, and
// sampling one of those is what produced the live 400s on 2026-09-08.
const AUTH = { authorization: 'Bearer sk-ant-oat01-testtoken' };

// Load a FRESH module instance per test — authTemplate is module-level state.
async function freshModule(dir) {
  process.env.RC_GATE_SESSIONS_DIR = dir;
  return await import(`${join(GATE_DIR, 'title-sync.js')}?t=${Math.random()}`);
}

async function runOneCycle(mod, port, stateFile, intervalMs = 25) {
  const stop = mod.startTitleSync({ host: '127.0.0.1', port, stateFile, intervalMs, log: () => {} });
  await new Promise(r => setTimeout(r, intervalMs * 6));
  stop();
}

test('pushes a user-renamed session, once, and records it', async () => {
  const puts = [];
  const server = fakeUpstream((req, res, body) => {
    puts.push({ method: req.method, url: req.url, body, auth: req.headers.authorization, version: req.headers['anthropic-version'] });
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  const port = await listen(server);
  const dir = sessionsDir([{ bridgeSessionId: 'sess_abc', name: 'maxpool', nameSource: 'user' }]);
  const stateFile = join(dir, 'state.json');
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions/sess_abc', AUTH);

  await runOneCycle(mod, port, stateFile);
  assert.equal(puts.length, 1, 'exactly one PUT');
  assert.equal(puts[0].method, 'PUT');
  assert.equal(puts[0].url, '/v1/code/sessions/sess_abc');
  assert.deepEqual(JSON.parse(puts[0].body), { title: 'maxpool' });
  assert.equal(puts[0].auth, AUTH.authorization, 'borrows the observed credential');
  assert.equal(puts[0].version, '2023-06-01', 'anthropic-version is always sent — the sessions API 400s without it');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sess_abc.title, 'maxpool');

  // Second run over the same state must be silent — no re-push of an unchanged name.
  await runOneCycle(mod, port, stateFile);
  assert.equal(puts.length, 1, 'no re-push when the name has not changed');
  server.closeAllConnections?.(); server.close();
});

test('a later rename IS pushed', async () => {
  const puts = [];
  const server = fakeUpstream((req, res, body) => { puts.push(body); res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const dir = sessionsDir([{ bridgeSessionId: 'sess_r', name: 'first', nameSource: 'user' }]);
  const stateFile = join(dir, 'state.json');
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions', AUTH);

  await runOneCycle(mod, port, stateFile);
  writeFileSync(join(dir, '1000.json'), JSON.stringify({ bridgeSessionId: 'sess_r', name: 'second', nameSource: 'user' }));
  await runOneCycle(mod, port, stateFile);

  assert.deepEqual(puts.map(b => JSON.parse(b).title), ['first', 'second']);
  server.closeAllConnections?.(); server.close();
});

test('never pushes derived names, unnamed sessions, or sessions with no bridge id', async () => {
  const puts = [];
  const server = fakeUpstream((req, res, body) => { puts.push(body); res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const dir = sessionsDir([
    { bridgeSessionId: 'sess_d', name: 'team-workspace-5e', nameSource: 'derived' },
    { bridgeSessionId: 'sess_n' },
    { name: 'no bridge here', nameSource: 'user' },
    { bridgeSessionId: 'sess_ok', name: 'real name', nameSource: 'user' },
  ]);
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions', AUTH);
  await runOneCycle(mod, port, join(dir, 'state.json'));

  assert.deepEqual(puts.map(b => JSON.parse(b).title), ['real name']);
  server.closeAllConnections?.(); server.close();
});

test('does nothing until an authenticated request has been observed', async () => {
  const puts = [];
  const server = fakeUpstream((req, res, body) => { puts.push(body); res.writeHead(200); res.end('{}'); });
  const port = await listen(server);
  const dir = sessionsDir([{ bridgeSessionId: 'sess_q', name: 'quiet', nameSource: 'user' }]);
  const mod = await freshModule(dir);
  // no noteAuthHeaders call at all
  await runOneCycle(mod, port, join(dir, 'state.json'));
  assert.equal(puts.length, 0, 'no credential observed => no traffic');

  // A non-OAuth header set must also not arm it.
  mod.noteAuthHeaders('/v1/code/sessions', { authorization: 'Bearer not-an-oauth-token' });
  await runOneCycle(mod, port, join(dir, 'state.json'));
  assert.equal(puts.length, 0, 'a non-sk-ant credential is ignored');
  server.closeAllConnections?.(); server.close();
});

test('401 disarms the borrowed credential instead of retrying with it', async () => {
  let calls = 0;
  const server = fakeUpstream((req, res) => { calls++; res.writeHead(401); res.end('{"error":"invalid"}'); });
  const port = await listen(server);
  const dir = sessionsDir([
    { bridgeSessionId: 'sess_1', name: 'one', nameSource: 'user' },
    { bridgeSessionId: 'sess_2', name: 'two', nameSource: 'user' },
  ]);
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions', AUTH);
  await runOneCycle(mod, port, join(dir, 'state.json'), 25);

  assert.equal(calls, 1, 'stops at the first 401 — does not walk the rest with a dead token');
  server.closeAllConnections?.(); server.close();
});

test('gives up on a session the server keeps rejecting', async () => {
  let calls = 0;
  const server = fakeUpstream((req, res) => { calls++; res.writeHead(404); res.end('{"error":"gone"}'); });
  const port = await listen(server);
  const dir = sessionsDir([{ bridgeSessionId: 'sess_gone', name: 'archived', nameSource: 'user' }]);
  const stateFile = join(dir, 'state.json');
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions', AUTH);

  for (let i = 0; i < 5; i++) await runOneCycle(mod, port, stateFile, 20);
  assert.ok(calls <= 3, `bounded retries, got ${calls}`);
  assert.ok(calls >= 3, `should have tried the full budget, got ${calls}`);
  server.closeAllConnections?.(); server.close();
});

test('a rename after a failure streak gets a fresh attempt', async () => {
  // The failure budget is per-TITLE. Keyed per-session it would mute a session's
  // name forever after one bad stretch, which is the opposite of the point.
  let calls = 0, fail = true;
  const server = fakeUpstream((req, res) => {
    calls++;
    if (fail) { res.writeHead(500); res.end('{}'); } else { res.writeHead(200); res.end('{}'); }
  });
  const port = await listen(server);
  const dir = sessionsDir([{ bridgeSessionId: 'sess_f', name: 'old name', nameSource: 'user' }]);
  const stateFile = join(dir, 'state.json');
  const mod = await freshModule(dir);
  mod.noteAuthHeaders('/v1/code/sessions', AUTH);

  for (let i = 0; i < 4; i++) await runOneCycle(mod, port, stateFile, 20);
  const spent = calls;
  assert.ok(spent <= 3, `budget exhausted, got ${spent}`);

  await runOneCycle(mod, port, stateFile, 20);
  assert.equal(calls, spent, 'stays quiet while the name is unchanged');

  fail = false;
  writeFileSync(join(dir, '1000.json'), JSON.stringify({ bridgeSessionId: 'sess_f', name: 'new name', nameSource: 'user' }));
  await runOneCycle(mod, port, stateFile, 20);
  assert.ok(calls > spent, 'a NEW name is retried despite the earlier streak');
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).sess_f.title, 'new name');
  server.closeAllConnections?.(); server.close();
});
