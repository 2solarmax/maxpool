// A non-streaming turn may wait for its busy account only when the client said how long it
// will wait (a real deadline) and enough of it is left to still move afterwards. With no
// deadline header — or a count_tokens call — it moves at once (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

function warmThenBusy() {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'ok'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 1);
    return 'ok';
  });
  return { remote, warm: () => warm };
}

test('non-streaming with a 90s deadline waits once, then is served by the same account', async () => {
  const { remote, warm } = warmThenBusy();
  const { port, cleanup } = await bootLink(remote);
  try {
    const body = bigBody(260_000, false);
    const headers = { 'x-stainless-timeout': '90' };
    assert.equal((await postTurn(port, body, { headers })).status, 200);
    const r = await postTurn(port, body, { headers });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    assert.deepEqual(remote.hits, [warm(), warm(), warm()], remote.hits.join(', '));
  } finally { await cleanup(); }
});

test('non-streaming with no deadline header moves at once', async () => {
  const { remote, warm } = warmThenBusy();
  const { port, cleanup } = await bootLink(remote);
  try {
    const body = bigBody(260_000, false);
    assert.equal((await postTurn(port, body)).status, 200);
    const t0 = Date.now();
    assert.equal((await postTurn(port, body)).status, 200);
    assert.ok(Date.now() - t0 < 500, 'no wait');
    assert.equal(remote.hits[1], warm());
    assert.notEqual(remote.hits[2], warm(), `moved: ${remote.hits.join(', ')}`);
  } finally { await cleanup(); }
});

test('count_tokens never waits', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 2);
    return 'ok';
  });
  const { port, cleanup } = await bootLink(remote);
  try {
    assert.equal((await postTurn(port, bigBody(260_000, true))).status, 200);
    const t0 = Date.now();
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'sess-warm', 'x-stainless-timeout': '90' },
      body: bigBody(260_000, false),
    });
    await r.text();
    assert.equal(r.status, 200);
    assert.ok(Date.now() - t0 < 900, `no wait (${Date.now() - t0}ms)`);
    assert.equal(remote.hits[1], warm, `count_tokens went to the warm account first: ${remote.hits.join(', ')}`);
    assert.notEqual(remote.hits[2], warm, `then moved: ${remote.hits.join(', ')}`);
  } finally { await cleanup(); }
});
