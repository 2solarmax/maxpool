// "Unavailable" is not "busy": the cloud row is cooled and the turn moves, as before — but
// the refusal is booked as a bounce, never an account failure (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn, mirror } from './link-fixture.js';

test('pinned_account_unavailable cools the cloud row and moves, without a failure streak', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_unavailable', 30);
    return 'sse';
  });
  const { am, port, cleanup } = await bootLink(remote);
  try {
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    const t0 = Date.now();
    assert.equal((await postTurn(port, body)).status, 200);
    assert.ok(Date.now() - t0 < 1000, 'no wait');
    assert.notEqual(remote.hits[2], warm, 'moved off the unavailable row');
    const row = mirror(am, warm);
    assert.ok(row.cooldownUntil > Date.now() + 20_000, 'cooled for its retry-after');
    assert.equal(row.consecutiveFailures, 0);
    assert.equal(row.failedRequests, 0);
    const b = row.loadEvents.filter(e => e.bounced);
    assert.equal(b.length, 1);
    assert.equal(b[0].refusal, 'unavailable');
  } finally { await cleanup(); }
});
