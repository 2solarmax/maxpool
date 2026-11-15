// The sticky wait is bounded (2026-11-15). Waits GROW so the 6-attempt cap (each attempt
// re-uploads the body) can still cover the owner's budget — 60 s by default — and the
// total never goes past it. Once the budget is spent the turn moves, and the account it
// gave up on stays out while it is still busy, even after a queue resume (whose fresh
// exclusion set would otherwise re-pick it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn, mirror } from './link-fixture.js';
import { __serverTest } from '../src/server.js';

const { nextStickyBusyWaitMs } = __serverTest;

/** The waits the server takes before it moves, attempt by attempt (as forwardRequest asks). */
function waitsBeforeMove(budgetMs, retryAfterMs = 2000) {
  const waits = [];
  let spent = 0;
  for (let n = 0; n < 20; n++) {
    const w = nextStickyBusyWaitMs(n, retryAfterMs, spent, budgetMs);
    if (w <= 0) break;
    waits.push(w); spent += w;
  }
  return { waits, spent };
}

test('at the cloud\'s 2 s retry-after the waits reach the budget, never past it, in ≤ 6 attempts', () => {
  const real = Math.random;
  Math.random = () => 0.5;             // the jitter midpoint (× 1.0)
  try {
    const at60 = waitsBeforeMove(60_000);
    assert.ok(at60.spent >= 50_000 && at60.spent <= 60_000, `60 s setting: ${at60.waits.join('+')} = ${at60.spent}`);
    assert.deepEqual(at60.waits, [2000, 4000, 8000, 15_000, 15_000, 16_000], 'grows ×2 to 15 s, the last takes the rest');
    const at15 = waitsBeforeMove(15_000);
    assert.ok(at15.spent <= 15_000, `15 s setting: ${at15.spent}`);
    assert.deepEqual(at15.waits, [2000, 4000, 8000, 1000]);
    assert.equal(waitsBeforeMove(0).spent, 0, "'off' never waits");
    const at120 = waitsBeforeMove(120_000);
    assert.equal(at120.spent, 120_000, `120 s setting: ${at120.waits.join('+')}`);
    assert.equal(at120.waits.length, 6, '120 s still stops at 6 attempts');
    assert.equal(waitsBeforeMove(3_600_000).waits.length, 6, 'a huge budget still stops at 6 attempts');
  } finally { Math.random = real; }
  // Full jitter never pushes the total past the setting.
  for (const r of [0, 0.999]) {
    Math.random = () => r;
    try { assert.ok(waitsBeforeMove(60_000).spent <= 60_000, `rand ${r}`); } finally { Math.random = real; }
  }
});

test('a spent budget moves the turn; a queue resume never re-picks the busy account', async () => {
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
  am.scheduler.stickyBusyBudgetMs = 4000;   // 1.5 s + 2.5 s (clipped) at the low jitter → 3rd refusal moves
  const real = Math.random;
  Math.random = () => 0;
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
  } finally { Math.random = real; await cleanup(); }
});
