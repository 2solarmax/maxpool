import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { sendLoginToPool, chooseLoginTarget, resolveUsablePools, planCliLogin } from '../src/cloud-login.js';

const creds = { accessToken: 'at', refreshToken: 'rt', expiresAt: 123 };
const profile = { accountUuid: 'uuid-1' };

function fake(handler) {
  return new Promise(resolve => {
    const seen = [];
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, key: req.headers['x-api-key'], body: body ? JSON.parse(body) : null });
        handler(req, res);
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, seen, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}
const reply = (code, obj) => (req, res) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

test('sendLoginToPool: added', async () => {
  const f = await fake(reply(200, { ok: true, result: 'added', name: 'x@y.z' }));
  try {
    const r = await sendLoginToPool({ url: f.url, key: 'k1', name: 'x@y.z', profile, creds });
    assert.deepEqual(r, { ok: true, result: 'added', name: 'x@y.z' });
    assert.equal(f.seen[0].url, '/maxpool/accounts');
    assert.equal(f.seen[0].method, 'POST');
    assert.equal(f.seen[0].key, 'k1');
    assert.equal(f.seen[0].body.account.accountUuid, 'uuid-1');
    assert.equal(f.seen[0].body.account.refreshToken, 'rt');
    assert.equal(f.seen[0].body.account.type, 'oauth');
  } finally { f.srv.close(); }
});

test('sendLoginToPool: reauthed', async () => {
  const f = await fake(reply(200, { ok: true, result: 'reauthed', name: 'n' }));
  try {
    const r = await sendLoginToPool({ url: f.url, key: 'k', name: 'n', profile, creds });
    assert.equal(r.ok, true);
    assert.equal(r.result, 'reauthed');
  } finally { f.srv.close(); }
});

test('sendLoginToPool: 401 -> ok:false with HTTP status', async () => {
  const f = await fake(reply(401, { error: 'bad key' }));
  try {
    const r = await sendLoginToPool({ url: f.url, key: 'nope', name: 'n', profile, creds });
    assert.equal(r.ok, false);
    assert.match(r.error, /HTTP 401/);
  } finally { f.srv.close(); }
});

test('sendLoginToPool: unreachable -> ok:false, never throws', async () => {
  const f = await fake(reply(200, {}));
  const url = f.url;
  await new Promise(r => f.srv.close(r));
  const r = await sendLoginToPool({ url, key: 'k', name: 'n', profile, creds });
  assert.equal(r.ok, false);
  assert.match(r.error, /Could not reach/);
});

const pools = [{ name: 'team', url: 'http://x', key: 'k' }];

test('chooseLoginTarget: --local wins even with pools', () => {
  assert.equal(chooseLoginTarget({ pools, flags: { local: true }, isTTY: true }), 'local');
});
test('chooseLoginTarget: --cloud', () => {
  assert.equal(chooseLoginTarget({ pools, flags: { cloud: true }, isTTY: true }), 'cloud');
});
test('chooseLoginTarget: TTY no flag asks, Enter -> cloud, l -> local', () => {
  assert.equal(chooseLoginTarget({ pools, flags: {}, isTTY: true }), 'ask');
  assert.equal(chooseLoginTarget({ pools, flags: {}, isTTY: true, answer: '' }), 'cloud');
  assert.equal(chooseLoginTarget({ pools, flags: {}, isTTY: true, answer: 'T' }), 'cloud');
  assert.equal(chooseLoginTarget({ pools, flags: {}, isTTY: true, answer: ' l ' }), 'local');
});
test('chooseLoginTarget: non-TTY + pool -> cloud', () => {
  assert.equal(chooseLoginTarget({ pools, flags: {}, isTTY: false }), 'cloud');
});
test('chooseLoginTarget: no pools -> local', () => {
  assert.equal(chooseLoginTarget({ pools: [], flags: {}, isTTY: false }), 'local');
  assert.equal(chooseLoginTarget({ pools: [], flags: { cloud: true }, isTTY: true }), 'local');
});

test('resolveUsablePools: literal key, resolved secret, unresolved reported', async () => {
  const out = await resolveUsablePools(
    [{ name: 'a', url: 'u', key: 'lit' }, { name: 'b', url: 'u', keySecret: 'S1' }, { name: 'c', url: 'u', keySecret: 'S2' }, { name: 'd' }],
    async () => ({ S1: 'sec' }));
  assert.deepEqual(out.usable.map(p => [p.name, p.key]), [['a', 'lit'], ['b', 'sec']]);
  assert.deepEqual(out.unresolved, ['c']);
});
test('resolveUsablePools: resolver throws → unresolved + error', async () => {
  const out = await resolveUsablePools([{ name: 'c', url: 'u', keySecret: 'S2' }], async () => { throw new Error('gcloud missing'); });
  assert.deepEqual(out.usable, []);
  assert.deepEqual(out.unresolved, ['c']);
  assert.equal(out.error, 'gcloud missing');
});

const P1 = { name: 'team', url: 'http://x', key: 'k' };
const P2 = { name: 'other', url: 'http://y', key: 'k2' };

test('planCliLogin: LOCAL MATCH + cloud default → local re-auth, never cloud', () => {
  const r = planCliLogin({ usable: [P1], localMatch: { name: 'me@x.com' }, flags: {}, isTTY: false });
  assert.equal(r.action, 'local');
  assert.equal(planCliLogin({ usable: [P1], localMatch: { name: 'me' }, flags: {}, isTTY: true, answer: 'T' }).action, 'local');
});
test('planCliLogin: local match + --cloud → fail (one pool only)', () => {
  const r = planCliLogin({ usable: [P1], localMatch: { name: 'me' }, flags: { cloud: true }, isTTY: true });
  assert.equal(r.action, 'fail');
  assert.match(r.message, /already on this laptop/);
});
test('planCliLogin: no local match + pool + non-TTY → cloud', () => {
  const r = planCliLogin({ usable: [P1], flags: {}, isTTY: false });
  assert.deepEqual([r.action, r.pool.name], ['cloud', 'team']);
});
test('planCliLogin: configured but unresolved, non-TTY → fail, NOT local', () => {
  const r = planCliLogin({ usable: [], unresolved: ['team'], error: 'gcloud missing', flags: {}, isTTY: false });
  assert.equal(r.action, 'fail');
  assert.match(r.message, /Team pool 'team' is configured but its key could not be loaded \(gcloud missing\)/);
});
test('planCliLogin: unresolved + --cloud → same accurate message', () => {
  const r = planCliLogin({ usable: [], unresolved: ['team'], flags: { cloud: true }, isTTY: true });
  assert.equal(r.action, 'fail');
  assert.match(r.message, /configured but its key could not be loaded/);
  assert.doesNotMatch(r.message, /no team pool is configured/);
});
test('planCliLogin: unresolved + TTY → asks; default/N → fail, y → local', () => {
  const base = { usable: [], unresolved: ['team'], flags: {}, isTTY: true };
  assert.equal(planCliLogin(base).action, 'ask-fallback');
  assert.equal(planCliLogin({ ...base, fallbackAnswer: '' }).action, 'fail');
  assert.equal(planCliLogin({ ...base, fallbackAnswer: 'n' }).action, 'fail');
  assert.equal(planCliLogin({ ...base, fallbackAnswer: 'Y' }).action, 'local');
});
test('planCliLogin: unresolved + --local → local; nothing configured → local, --cloud → fail', () => {
  assert.equal(planCliLogin({ usable: [], unresolved: ['team'], flags: { local: true }, isTTY: false }).action, 'local');
  assert.equal(planCliLogin({ usable: [], unresolved: [], flags: {}, isTTY: false }).action, 'local');
  assert.match(planCliLogin({ usable: [], unresolved: [], flags: { cloud: true }, isTTY: true }).message, /no team pool is configured/);
});
test('planCliLogin: two usable pools — non-TTY fails asking --pool; --pool picks', () => {
  const r = planCliLogin({ usable: [P1, P2], flags: {}, isTTY: false });
  assert.equal(r.action, 'fail');
  assert.match(r.message, /--pool <name>/);
  assert.equal(planCliLogin({ usable: [P1, P2], flags: { pool: 'other' }, isTTY: false }).pool.name, 'other');
  assert.equal(planCliLogin({ usable: [P1, P2], flags: { pool: 'nope' }, isTTY: false }).action, 'fail');
});
test('planCliLogin: two usable pools — TTY asks which; default first, number, name', () => {
  const base = { usable: [P1, P2], flags: {}, isTTY: true };
  assert.equal(planCliLogin(base).action, 'ask-pool');
  assert.equal(planCliLogin({ ...base, poolAnswer: '' }).action, 'ask-target');
  assert.equal(planCliLogin({ ...base, poolAnswer: '' }).pool.name, 'team');
  assert.equal(planCliLogin({ ...base, poolAnswer: '2' }).pool.name, 'other');
  assert.equal(planCliLogin({ ...base, poolAnswer: 'other' }).pool.name, 'other');
  assert.equal(planCliLogin({ ...base, poolAnswer: '9' }).action, 'fail');
  assert.equal(planCliLogin({ ...base, poolAnswer: '2', answer: 'l' }).action, 'local');
});
test('planCliLogin: --pool naming an unresolved pool → accurate message', () => {
  const r = planCliLogin({ usable: [P1], unresolved: ['other'], flags: { pool: 'other' }, isTTY: false });
  assert.match(r.message, /'other' is configured but its key could not be loaded/);
});
test('planCliLogin: --cloud + --local → fail', () => {
  assert.equal(planCliLogin({ usable: [P1], flags: { cloud: true, local: true }, isTTY: true }).action, 'fail');
});

test('cloud path with no profile uuid aborts instead of risking a duplicate add', async () => {
  const { srv, seen, url } = await fake((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: 'added' })); });
  try {
    const r = await sendLoginToPool({ url, key: 'k', name: 'x', profile: null, creds: { accessToken: 'a', refreshToken: 'r', expiresAt: 1 } });
    assert.equal(r.ok, false, 'helper refuses a uuid-less profile');
    assert.match(r.error, /account id/i);
    assert.equal(seen.length, 0, 'no request ever reached the team pool');
  } finally { await new Promise(res => srv.close(res)); }
});
