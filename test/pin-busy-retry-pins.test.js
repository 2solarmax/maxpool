// The retry after a sticky wait is a HARD one-shot pin to the waiting account: a busier
// account than its idle sibling must still get it (a score bonus would lose). The pin
// lasts one acquire — a real failure on that account afterwards moves freely (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn, mirror } from './link-fixture.js';

test('after the wait the retry acquires the same account even with an idle sibling; a later fault moves freely', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 1);
    if (pin === warm && n === 3) return 'reset';    // the pinned retry then hits a real link fault
    return 'sse';
  });
  const { am, port, cleanup } = await bootLink(remote);
  // Balance mode: the pick is scored (sticky mode's session binding would hide the rule).
  am.setProviderRoutingMode('balance');
  try {
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    const row = mirror(am, warm);
    const done = postTurn(port, body);
    // Once the refusal landed, load the warm row far past its sibling: scoring alone
    // would now send the retry elsewhere.
    while (remote.hits.length < 2) await new Promise(r => setTimeout(r, 5));
    row._remoteOtherWeight = 5000; row._remoteOtherLoad = 5000;
    const r = await done;
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const other = remote.hits.find(h => h !== warm);
    assert.deepEqual(remote.hits, [warm, warm, warm, other], `pinned retry, then a free move after the fault: ${remote.hits.join(', ')}`);
  } finally { await cleanup(); }
});
