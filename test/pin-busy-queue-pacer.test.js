// All cloud rows busy (2026-11-15): busy is no cooldown any more, so the queue must not
// re-try the link in a sub-second spin. A busy row is no free route for the queue while
// its back-off lasts (hasAvailableRoute), so attempts are paced by the cloud's retry-after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal } from './link-fixture.js';

test('all cloud rows busy: link attempts are paced, the queue does not spin', { timeout: 60_000 }, async (t) => {
  const remote = remotePool(() => pinRefusal('pinned_account_busy', 3));
  const { port, cleanup } = await bootLink(remote, { enabled: true, pollMs: 50, heartbeatMs: 1000, capacityMaxWaitMs: 30_000 });
  const lines = [];
  const orig = console.log;
  console.log = (...a) => { lines.push(a.join(' ')); };
  try {
    const ctl = new AbortController();
    const p = fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 's-q' },
      body: bigBody(2_000, true), signal: ctl.signal,
    }).then(r => r.text()).catch(() => null);
    await new Promise(r => setTimeout(r, 6_000));
    ctl.abort();
    await p;
    await new Promise(r => setTimeout(r, 200));
    console.log = orig;
    const queued = lines.filter(l => l.includes('queueing request')).length;
    t.diagnostic(`link attempts=${remote.hits.length} queue holds=${queued}`);
    assert.ok(remote.hits.length >= 2, `both rows were tried: ${remote.hits.length}`);
    assert.ok(remote.hits.length <= 9, `paced: ${remote.hits.length} link attempts in 6s (≤ 3 per 2s)`);
    assert.ok(queued <= 12, `no queue spin: ${queued} queue holds in 6s`);
  } finally { console.log = orig; await cleanup(); }
});
