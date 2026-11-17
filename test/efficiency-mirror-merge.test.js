// Review 2026-11-16, cluster 1: the dashboard was blind to cloud traffic. Bounces, busy
// waits, move causes and client-felt latency exist ONLY in the edge (Mac) pool's events
// on a cloud mirror row; the cloud books a pin refusal before any lease, never learns
// the edge's wait or move cause, and starts its clock after the wait. So for a mirror
// row: cache + served come from the serving pool's export, the edge-only fields from
// this pool's own events — each counted once — and the cloud stops booking pinned
// requests as its own moves.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const lease = (a, requestInfo = {}) => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo }; };

/** A Mac whose only Claude account is a cloud mirror, exporting 30 served at 99% cache. */
function macWithMirror({ exportBlock = true } = {}) {
  const am = new AccountManager([], 0.9);
  am.addAccount({ name: 'cloud-a ☁', type: 'oauth', configSourced: true, runtime: false });
  const row = am.accounts.find(a => a.name === 'cloud-a ☁');
  row.remote = { linkName: 'team', link: { lastOkAt: Date.now() } };
  if (exportBlock) {
    row._remoteLoad = { last15m: { efficiency: {
      provider: 'claude', served: 30, in: 3000, out: 300, cr: 297_000, cc: 0,
      moved: 0, movedByCause: {}, newConversation: 0, bounced: 0, refused: 0, waited: 0, waitMs: 0, waitThenMoved: 0,
    } } };
  }
  return { am, row };
}

/** The Mac's own events on that mirror row: 10 busy bounces, 30 served after an 8 s
 *  wait, one of which still moved (busy) to this row. */
function bookEdgeEvents(am, row) {
  for (let i = 0; i < 10; i++) {
    am.releaseAccount(lease(row), { success: false, bounced: true, status: 503, refusal: 'busy' });
  }
  for (let i = 0; i < 30; i++) {
    am.releaseAccount(lease(row), { success: true, status: 200, usage: { in: 100, out: 10, cr: 9900, cc: 0 },
      busyWaitMs: 8000, e2eFirstByteMs: 9500, moved: i === 0, moveCause: i === 0 ? 'busy' : null });
  }
}

test('overall bounced / waited / moves-by-cause count the edge events on a cloud row', () => {
  const { am, row } = macWithMirror();
  bookEdgeEvents(am, row);
  const c = am.efficiencyOverall('last15m').claude;
  assert.equal(c.bounced, 10, `edge bounces reach the overall figure (got ${c.bounced})`);
  assert.equal(c.waited, 30, `edge waits reach the overall figure (got ${c.waited})`);
  assert.equal(c.waitThenMoved, 1, 'a wait that still moved is counted');
  assert.equal(c.movedByCause.busy, 1, 'the edge move cause survives (not relabelled balance)');
  assert.equal(c.served, 30, 'served comes from the serving pool ONCE — not 30 + 30');
  assert.ok(Math.abs(c.hit - 0.99) < 1e-9, 'cache hit is the serving pool\'s');
});

test('first-byte percentiles include cloud-served turns, edge waits included', () => {
  const { am, row } = macWithMirror();
  bookEdgeEvents(am, row);
  const o = am.efficiencyOverall('last15m');
  assert.equal(o.e2eP95, 9500, `p95 sees the 8 s wait (got ${o.e2eP95})`);
});

test('the TUI Cache line turns red on a cloud-only Mac with a high bounce share', () => {
  const { am, row } = macWithMirror();
  bookEdgeEvents(am, row);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  const line = strip(tui._efficiencyLine(200) || '');
  // RED (⚠) with the account behind it — not just the always-present "busy 0" label.
  assert.match(line, /⚠ cross moves \d+\/100 — most refusals on cloud-a ☁/, `red names cause + account: ${line}`);
  assert.match(line, /bounced 25%/, `the bounce share is shown: ${line}`);
  assert.match(line, /busy-bounce waits 30 \(avg 8\.0s\)/, `the waits are shown: ${line}`);
});

test('an older cloud with no export: the edge events alone feed the overall figures', () => {
  const { am, row } = macWithMirror({ exportBlock: false });
  bookEdgeEvents(am, row);
  const c = am.efficiencyOverall('last15m').claude;
  assert.equal(c.served, 30, 'falls back to the edge served count');
  assert.equal(c.bounced, 10);
  assert.ok(c.hit > 0.98, 'cache share from the link-tapped usage');
});

test('the serving pool does not book a pinned request as its own move or latency sample', () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'b', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
  const [a, b] = am.accounts;
  am.noteConversationServed({ affinityKey: 'k', pinAccount: 'a', startedAt: Date.now() - 1000 }, a);
  const ri = { affinityKey: 'k', pinAccount: 'b', startedAt: Date.now() - 1000 };
  am.noteConversationServed(ri, b);
  am.releaseAccount(lease(b, ri), { success: true, status: 200 });
  const e = am._efficiencySummary(b, 15 * 60e3);
  assert.equal(e.served, 1, 'it still counts as served here');
  assert.equal(e.moved, 0, 'the edge pool owns the move (and its real cause)');
  assert.equal(e.e2eP95, null, 'no latency sample that starts after the edge wait');
});

test('a direct (unpinned) move on the serving pool is still booked', () => {
  const am = new AccountManager([
    { name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 },
    { name: 'b', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 36e5 },
  ], 0.9);
  const [a, b] = am.accounts;
  am.noteConversationServed({ affinityKey: 'k' }, a);
  const ri = { affinityKey: 'k', startedAt: Date.now() - 1000 };
  am.noteConversationServed(ri, b);
  am.releaseAccount(lease(b, ri), { success: true, status: 200 });
  assert.equal(am._efficiencySummary(b, 15 * 60e3).moved, 1);
});
