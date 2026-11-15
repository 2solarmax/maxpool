// A busy refusal on a conversation's FIRST turn moves at once: nothing is cached on that
// cloud account yet, so waiting would only add latency (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

test('a first-ever turn on a busy cloud account moves to another account immediately', async () => {
  let first = null;
  const remote = remotePool((pin) => {
    if (first == null) { first = pin; return pinRefusal('pinned_account_busy', 2); }
    return 'sse';
  });
  const { port, cleanup } = await boot(remote);
  try {
    const t0 = Date.now();
    const r = await postTurn(port, bigBody(260_000, true));
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(remote.hits.length, 2);
    assert.notEqual(remote.hits[1], remote.hits[0], 'moved to the other cloud account');
    assert.ok(elapsed < 1000, `no wait on a cold conversation (took ${elapsed}ms)`);
  } finally { await cleanup(); }
});

const boot = (remote) => bootLink(remote);
