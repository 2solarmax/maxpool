// A busy GLM/Kimi cloud row never gets the sticky wait: z.ai's cache is not per key, so
// staying buys nothing — the turn moves at once (2026-11-15), to another GLM row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

const GLM_ROWS = [
  { name: 'glm a', type: 'provider', provider: 'zai', enabled: true, status: 'active', quota: {} },
  { name: 'glm b', type: 'provider', provider: 'zai', enabled: true, status: 'active', quota: {} },
];

test('a busy provider cloud row moves at once even when the conversation is warm there', async () => {
  // Since 2026-11-17 every z.ai row is warm for a z.ai conversation (family affinity), so
  // turn 2 may start on either row: refuse its FIRST attempt, wherever it lands.
  let calls = 0;
  let firstOfTurn2 = null;
  const remote = remotePool((pin) => {
    calls++;
    if (calls === 2) { firstOfTurn2 = pin; return pinRefusal('pinned_account_busy', 2); }
    return 'sse';
  }, { accounts: GLM_ROWS });
  const { am, port, cleanup } = await bootLink(remote);
  am.setProviderRoutingMode('balance');   // a Claude-model turn may run on GLM rows
  try {
    const body = bigBody(260_000, true);
    const opts = { headers: { 'x-maxpool-profile': 'all' } };
    assert.equal((await postTurn(port, body, opts)).status, 200);
    const t0 = Date.now();
    const r = await postTurn(port, body, opts);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 200);
    assert.equal(remote.hits.length, 3);
    assert.equal(remote.hits[1], firstOfTurn2, 'turn 2 was refused busy on its first row');
    assert.notEqual(remote.hits[2], firstOfTurn2, 'then moved to the other GLM row instead of waiting');
    assert.match(String(remote.hits[2]), /^glm /, 'and stayed in the GLM family');
    assert.ok(elapsed < 1000, `no wait on a provider row (took ${elapsed}ms)`);
  } finally { await cleanup(); }
});
