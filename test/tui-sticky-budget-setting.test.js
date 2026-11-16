// "Wait for busy account" (owner 2026-11-15): how long a warm conversation waits for its
// own busy cloud account before moving. Default 60s, edited live from the routing screen
// (`b`), saved to config, and read per request — the very next request uses the new value.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';
import { remotePool, bootLink, bigBody, pinRefusal, postTurn } from './link-fixture.js';

const { strip } = __tuiTest;
delete process.env.MAXPOOL_STICKY_BUSY_BUDGET_MS;

test('the routing screen shows the setting at its 60s default', () => {
  const am = new AccountManager([], 0.9);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  const detail = tui._renderRoutingDetail().map(strip);
  assert.ok(detail.some(l => l.includes('Wait for busy account  60s')), detail.join('\n'));
});

test('an edit is saved to config and the next request uses it', async () => {
  let warm = null;
  const remote = remotePool((pin, n) => {
    if (warm == null) { warm = pin; return 'sse'; }
    if (pin === warm && n === 2) return pinRefusal('pinned_account_busy', 1);
    return 'sse';
  });
  const { am, port, cleanup } = await bootLink(remote);
  const config = { proxy: { port: 3456 }, scheduler: {} };
  const saved = [];
  const tui = new TUI({ accountManager: am, config, saveConfig: async c => { saved.push(JSON.parse(JSON.stringify(c.scheduler))); } });
  try {
    await tui._cycleStickyBusyBudget();   // 60s → 120s
    await tui._cycleStickyBusyBudget();   // 120s → off
    assert.equal(saved.at(-1).stickyBusyBudgetMs, 0, 'saved to config');
    assert.ok(tui._renderRoutingDetail().map(strip).some(l => l.includes('Wait for busy account  off')));
    assert.equal(new AccountManager([], 0.9, saved.at(-1)).scheduler.stickyBusyBudgetMs, 0, 'a restart reads it back');
    // Live: a warm conversation's busy refusal now moves at once instead of waiting.
    const body = bigBody(260_000, true);
    assert.equal((await postTurn(port, body)).status, 200);
    const t0 = Date.now();
    assert.equal((await postTurn(port, body)).status, 200);
    assert.ok(Date.now() - t0 < 450, `no wait with the setting off (${Date.now() - t0}ms)`);
    assert.notEqual(remote.hits[2], warm, `moved: ${remote.hits.join(', ')}`);
  } finally { await cleanup(); }
});

test('an env override shows as "(env)" and b does not save a setting the server ignores', async () => {
  // Review 2026-11-16, 5c: the screen showed the saved setting while the env value won.
  process.env.MAXPOOL_STICKY_BUSY_BUDGET_MS = '0';
  try {
    const am = new AccountManager([], 0.9);
    const saved = [];
    const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 }, scheduler: {} }, saveConfig: async c => { saved.push(c); } });
    const detail = tui._renderRoutingDetail().map(strip);
    assert.ok(detail.some(l => l.includes('Wait for busy account  off (env)')), `shows the value in force: ${detail.join('\n')}`);
    await tui._cycleStickyBusyBudget();
    assert.equal(saved.length, 0, 'nothing saved while the env pins it');
    assert.equal(am.scheduler.stickyBusyBudgetMs ?? 60_000, 60_000, 'the in-memory setting is untouched');
  } finally { delete process.env.MAXPOOL_STICKY_BUSY_BUDGET_MS; }
});
