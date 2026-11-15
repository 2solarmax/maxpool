// The sticky wait is bounded: past the attempt cap the turn moves, and the account it
// gave up on stays out while it is still busy — even after a queue resume, whose fresh
// exclusion set would otherwise re-pick it (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MAXPOOL_STICKY_BUSY_MAX_ATTEMPTS = '2';   // 2 waits → the 3rd refusal moves
const { remotePool, bootLink, bigBody, pinRefusal, postTurn, mirror } = await import('./link-fixture.js');

test('3 consecutive busy refusals move the turn; a queue resume never re-picks the busy account', async () => {
  let warm = null, other = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm) return pinRefusal('pinned_account_busy', 3);   // busy for good (3s back-off)
    other = pin;
    return n === 1 ? pinRefusal('pinned_account_busy', 1) : 'sse';   // the sibling is busy once
  });
  const { am, port, cleanup } = await bootLink(remote, { enabled: true, pollMs: 50, heartbeatMs: 1000 });
  // Balance mode: the pick is scored (sticky mode's session binding would hide the rule).
  am.setProviderRoutingMode('balance');
  try {
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    const r = await postTurn(port, body);
    assert.equal(r.status, 200, r.text.slice(0, 200));
    const turn2 = remote.hits.slice(1);
    assert.deepEqual(turn2.slice(0, 3), [warm, warm, warm], `three refusals on the warm account: ${turn2.join(', ')}`);
    assert.deepEqual(turn2.slice(3), [other, other], `then the sibling (busy once, served after the queue resume) — never the busy account again: ${turn2.join(', ')}`);
    const served = (mirror(am, other).loadEvents || []).filter(e => e.success);
    assert.equal(served.at(-1).moveCause, 'busy', 'the move is booked as a busy move');
    assert.equal(served.at(-1).moved, true);
  } finally { await cleanup(); }
});
