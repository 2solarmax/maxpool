// A conversation's last account is recorded at the FIRST REAL BYTE of an answer, never at
// selection (2026-11-15): a hop that is refused or fails can no longer re-point the
// conversation at an account that never served it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

const lastAccount = am => [...am.conversationLastAccount.values()].at(-1);

test('a refused hop leaves the conversation on its account until the next one answers', async () => {
  let warm = null;
  const remote = remotePool((pin) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm) return pinRefusal('pinned_account_unavailable', 30);
    return { delay: 600, sse: true };    // the other account answers slowly
  });
  const { am, port, cleanup } = await bootLink(remote);
  try {
    const body = bigBody(2_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    assert.equal(lastAccount(am), `${warm} ☁`);
    const done = postTurn(port, body);
    while (remote.hits.length < 3) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 200));   // the other account is selected, no byte yet
    assert.equal(lastAccount(am), `${warm} ☁`, 'still the account that served it last');
    assert.equal((await done).status, 200);
    const other = remote.hits[2];
    assert.notEqual(other, warm);
    assert.equal(lastAccount(am), `${other} ☁`, 'moved at the first byte');
  } finally { await cleanup(); }
});

test('a client that leaves after the first byte keeps the conversation on the account that answered', async () => {
  const remote = remotePool(() => 'partial');
  const { am, port, cleanup } = await bootLink(remote);
  try {
    const ctl = new AbortController();
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'sess-c' }, body: bigBody(2_000, true), signal: ctl.signal,
    });
    const reader = r.body.getReader();
    assert.ok((await reader.read()).value?.length > 0, 'a real byte arrived');
    ctl.abort();
    await new Promise(res => setTimeout(res, 100));
    assert.equal(lastAccount(am), `${remote.hits[0]} ☁`);
  } finally { await cleanup(); }
});
