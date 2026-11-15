// Sticky wait on a busy cloud row (2026-11-15). A warm conversation whose cloud
// account answers "busy" (pinned_account_busy, retry-after 1) used to be cooled and
// moved to another account — re-writing its whole multi-hundred-KB prompt cache.
// Busy is seconds, not an account fault: the turn now waits briefly and retries the
// SAME account, and the refusal is booked as a bounce, never a failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody } from './link-fixture.js';

const BUSY = { status: 503, headers: { 'retry-after': '1' }, body: { type: 'error', error: { type: 'pinned_account_busy', message: 'busy' } } };

async function post(port, body) {
  const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'tc-test', 'x-maxpool-session': 'sess-warm' }, body,
  });
  return { status: r.status, text: await r.text() };
}

test('a warm conversation waits out a busy refusal on its cloud account instead of moving', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }      // turn 1: served, conversation is now warm here
    if (pin === warm && n === 2) return BUSY;              // turn 2: its account is briefly busy
    return 'sse';
  });
  const { am, port, cleanup } = await bootLink(remote);
  try {
    const body = bigBody(260_000, true);
    const r1 = await post(port, body);
    assert.equal(r1.status, 200);
    const r2 = await post(port, body);
    assert.equal(r2.status, 200, r2.text.slice(0, 200));
    assert.deepEqual(remote.hits, [warm, warm, warm], `turn 2 retried the same cloud account: ${remote.hits.join(', ')}`);
    const row = am.accounts.find(a => a.name === `${warm} ☁`);
    assert.ok(!(row.cooldownUntil > Date.now()), 'busy is not a cooldown');
    assert.equal(row.consecutiveFailures, 0, 'no failure streak');
    assert.equal(row.failedRequests, 0, 'no failed request');
    assert.equal(row.lastError, null, 'no error text');
    const bounced = (row.loadEvents || []).filter(e => e.bounced);
    assert.equal(bounced.length, 1, 'the refusal is one bounced load event');
    assert.equal(am._loadSummary(row, 15 * 60_000).failed, 0, 'not in the failed count');
  } finally { await cleanup(); }
});
