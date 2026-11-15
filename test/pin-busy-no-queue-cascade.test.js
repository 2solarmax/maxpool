// A sticky waiter holds no lease and no queue ticket, so the queue-fairness gate (which
// refuses every local Claude row while anything waits in the queue) never sees it: other
// traffic keeps flowing during the wait (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

test('during a sticky wait the queue stays empty and a local Claude row stays selectable', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 3);   // ≥1.5s wait
    return 'sse';
  });
  const local = { name: 'local', type: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: 'L1' };
  const { am, port, cleanup } = await bootLink(remote, { enabled: true, pollMs: 50, heartbeatMs: 1000 }, { localAccounts: [local] });
  const localRow = am.accounts.find(a => a.name === 'local');
  try {
    const body = bigBody(260_000, true);
    localRow.enabled = false;              // turn 1 lands on a cloud row
    assert.equal((await postTurn(port, body)).status, 200);
    localRow.enabled = true;
    const done = postTurn(port, body);
    while (remote.hits.length < 2) await new Promise(r => setTimeout(r, 5));
    await new Promise(r => setTimeout(r, 300));   // inside the wait
    assert.equal(am.queueState.waiting.length, 0, 'the waiter is not in the queue');
    assert.equal(am._matchesRequest(localRow, 'claude', {}), true, 'the fairness gate lets a local Claude row serve');
    assert.equal((await done).status, 200);
    assert.deepEqual(remote.hits.slice(1), [warm, warm]);
  } finally { await cleanup(); }
});
