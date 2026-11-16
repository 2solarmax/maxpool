// The refusal CAUSE is machine-readable (2026-11-15). A pool refusing a pinned request
// names why (busy / unavailable / throttled) plus its depth; the linked pool acts on it.
// Additive: an older pool sends no headers and the 503 body type still classifies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer, __serverTest } from '../src/server.js';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn, mirror, listen, close } from './link-fixture.js';

const { readPinRefusal } = __serverTest;
const SSE = 'event: message_stop\ndata: {"type":"message_stop"}\n\n';

async function pinnedTo(setup) {
  const upstream = http.createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); });
  const upPort = await listen(upstream);
  const am = new AccountManager([{ name: 'c1', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'C1' }], 0.9);
  setup(am);
  const proxy = createProxyServer(am, { proxy: { clients: [{ name: 'max', key: 'mp-max' }] }, upstream: `http://127.0.0.1:${upPort}`, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'mp-max', 'x-maxpool-pin-account': 'c1' }, body: bigBody(2_000, true),
    });
    return { status: r.status, headers: r.headers, body: await r.json() };
  } finally { await close(proxy); await close(upstream); }
}

test('a pool refusing a pinned request names the cause and its depth in headers', async () => {
  const busy = await pinnedTo(am => { am.accounts[0].inFlight = 6; });
  assert.equal(busy.status, 503);
  assert.equal(busy.body.error.type, 'pinned_account_busy', 'body unchanged');
  assert.equal(busy.headers.get('x-maxpool-pin-refusal'), 'busy');
  assert.equal(busy.headers.get('x-maxpool-pin-inflight'), '6');
  assert.equal(busy.headers.get('x-maxpool-pin-limit'), '6');
  const throttled = await pinnedTo(am => { am.markUpstreamThrottled(30); });
  assert.equal(throttled.status, 503);
  assert.equal(throttled.body.error.type, 'pinned_account_unavailable');
  assert.equal(throttled.headers.get('x-maxpool-pin-refusal'), 'throttled');
});

test('throttled cools every cloud row of that link at once and moves to a local route in one hop', async () => {
  const remote = remotePool(() => pinRefusal('pinned_account_unavailable', 20, { 'x-maxpool-pin-refusal': 'throttled' }));
  const local = { name: 'local', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'L1' };
  const upstreamHandler = (req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(SSE); }); };
  const { am, port, cleanup } = await bootLink(remote, { enabled: false }, { localAccounts: [local], upstreamHandler });
  const localRow = am.accounts.find(a => a.name === 'local');
  try {
    localRow.activeWeight = 500;   // the cloud rows are the natural pick
    const r = await postTurn(port, bigBody(2_000, true));
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.equal(remote.hits.length, 1, `one refusal, then off the link: ${remote.hits.join(', ')}`);
    for (const name of ['reports@gomokka.com', 'personal']) {
      assert.ok(mirror(am, name).cooldownUntil > Date.now() + 10_000, `${name} cooled`);
      assert.equal(mirror(am, name).consecutiveFailures, 0, `${name}: no failure streak`);
    }
    const hit = mirror(am, remote.hits[0]);
    assert.equal(hit.loadEvents.filter(e => e.bounced && e.refusal === 'throttled').length, 1, 'booked as a bounce');
    assert.equal(localRow.completedRequests, 1, 'served locally');
  } finally { await cleanup(); }
});

test('an older pool (no headers): the body type still classifies; header-less short retry-after is busy', async () => {
  const resp = (status, body, headers = {}) => new globalThis.Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
  assert.equal((await readPinRefusal(resp(503, { type: 'error', error: { type: 'pinned_account_busy' } }))).cause, 'busy');
  assert.equal((await readPinRefusal(resp(503, { type: 'error', error: { type: 'pinned_account_unavailable' } }, { 'retry-after': '2' }))).cause, 'unavailable');
  assert.equal((await readPinRefusal(resp(429, '{}', { 'retry-after': '5' }))).cause, 'busy');
  assert.equal((await readPinRefusal(resp(429, '{}', { 'retry-after': '30' }))).cause, 'unavailable');
  assert.equal((await readPinRefusal(resp(503, 'not json'))).cause, 'unavailable', 'unknown is never guessed busy');
  const withHdr = await readPinRefusal(resp(503, { error: { type: 'pinned_account_busy' } }, { 'x-maxpool-pin-refusal': 'throttled', 'x-maxpool-pin-inflight': '5', 'x-maxpool-pin-limit': '6' }));
  assert.deepEqual([withHdr.cause, withHdr.inflight, withHdr.limit], ['throttled', 5, 6], 'the header wins over the body');
});
