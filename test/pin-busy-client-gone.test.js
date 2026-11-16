// A client that leaves DURING a sticky wait ends it at once: nothing is re-sent and the
// wait does not sit out its timer behind a dead socket (2026-11-15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

test('the client leaving mid-wait ends the wait at once and sends nothing more', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 3);   // a 1.5-4.5s wait
    return 'sse';
  });
  const { am, port, cleanup } = await bootLink(remote);
  const lines = [];
  const orig = console.log;
  try {
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    console.log = (...a) => { lines.push({ at: Date.now(), text: a.join(' ') }); };
    const ctl = new AbortController();
    const p = postTurn(port, body, { signal: ctl.signal }).catch(() => null);
    while (remote.hits.length < 2) await new Promise(r => setTimeout(r, 10));
    await new Promise(r => setTimeout(r, 150));   // inside the wait (≥1.5s)
    const abortedAt = Date.now();
    ctl.abort();
    await p;
    await new Promise(r => setTimeout(r, 4600));   // past any wait
    console.log = orig;
    const gone = lines.find(l => l.text.includes('client left during the wait'));
    assert.ok(gone, `the wait ended on the client leaving:\n${lines.map(l => l.text).join('\n')}`);
    assert.ok(gone.at - abortedAt < 500, `ended at once, not after the wait (${gone.at - abortedAt}ms)`);
    assert.equal(remote.hits.length, 2, `exactly one request reached the cloud for turn 2: ${remote.hits.join(', ')}`);
    // Review 2026-11-16, 5a: a cancel is not a pool error. Turn 1 (200) is the only
    // client outcome; the abandoned wait must not be booked as a 503 pool error.
    const co = am.clientOutcomeSummary(15 * 60_000);
    assert.equal(co.poolErrors, 0, `the client's cancel is not a pool error: ${JSON.stringify(co)}`);
    assert.equal(co.total, 1, `only the served turn is an outcome: ${JSON.stringify(co)}`);
  } finally { console.log = orig; await cleanup(); }
});
