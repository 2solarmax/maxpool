// A sticky wait can last 15 s or more (2026-11-15). A streaming client must keep getting
// keep-alive bytes the whole time — the stream-forward grace is re-armed around every
// sleep, commits the SSE stream and starts the heartbeat — or the client's own idle
// watchdog would kill the turn the wait was meant to save.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

test('a streaming client gets keep-alive bytes throughout a 15 s sticky wait', { timeout: 60_000 }, async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 15);   // one 15 s wait
    return 'sse';
  });
  const { port, cleanup } = await bootLink(remote, { enabled: false, streamForwardGraceMs: 200, heartbeatMs: 1000 });
  const real = Math.random;
  Math.random = () => 0.5;   // jitter midpoint: exactly min(15 s cap, 15 s × 2^0) = 15 s
  try {
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    const t0 = Date.now();
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'sess-warm' }, body,
    });
    assert.equal(res.status, 200, 'the stream is committed during the wait, not after it');
    const arrivals = [];
    let text = '';
    let retryAt = null;
    for await (const chunk of res.body) {
      const s = Buffer.from(chunk).toString();
      text += s;
      if (retryAt == null && remote.hits.length >= 3) retryAt = Date.now();
      if (retryAt == null) arrivals.push({ at: Date.now(), ping: s.includes('ping') });
    }
    assert.ok(retryAt - t0 >= 14_000, `the wait really lasted ~15 s (${retryAt - t0}ms)`);
    const pings = arrivals.filter(a => a.ping).length;
    assert.ok(pings >= 10, `keep-alive pings during the wait: ${pings}`);
    let last = t0, maxGap = 0;
    for (const a of arrivals) { maxGap = Math.max(maxGap, a.at - last); last = a.at; }
    maxGap = Math.max(maxGap, retryAt - last);
    assert.ok(maxGap < 3000, `the client never sat silent for long (largest gap ${maxGap}ms)`);
    assert.match(text, /message_stop/, 'the real answer followed');
    assert.deepEqual(remote.hits, [warm, warm, warm]);
  } finally { Math.random = real; await cleanup(); }
});
