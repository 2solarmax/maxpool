// ── D3 (2026-11-18): the cloud's OPEN week is exported and reaches a mirror row ──
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const mirrorAcct = (name, remoteName) => {
  const a = {
    name: `${name} ☁`, type: 'oauth', configSourced: true, runtime: false,
  };
  a.remote = { linkName: 'team', remoteName, url: 'http://127.0.0.1:9', key: 'k', link: {} };
  return a;
};
const W = 7 * 86400_000;

test('D3: a mirror row builds a live tank from the exported open cycle', () => {
  const acct = mirrorAcct('m', 'real');
  const am = new AccountManager([acct], 0.95);
  // addAccount does not carry `remote` — the manager assigns it after (syncRemoteMirrors).
  am.accounts[0].remote = acct.remote;
  const a = am.accounts[0];
  a.remoteOpen = {
    wk: { startedAt: Date.now() - 2 * 86400_000, windowStartedAt: Date.now() - 2 * 86400_000,
          tokensSoFar: 2_100_000_000, peakUtilization: 0.7,
          est: 3_000_000_000,
          samples: [] },
  };
  const t = am.capacityTank(a.index, 'wk');
  assert.ok(t, 'the mirror branch returns a live tank');
  assert.equal(t.source, 'live');
  assert.equal(t.avg, 3_000_000_000);
});

// F2 (red team 2026-11-18): a MIRROR row shows the cloud's live week even when it has history.
test('F2: a mirror with admitted history still shows the exported live week as Current', async () => {
  const acct = { name: 'm ☁', type: 'oauth', configSourced: true, runtime: false };
  const am = new AccountManager([acct], 0.95);
  am.accounts[0].remote = { linkName: 't', remoteName: 'real', url: 'http://127.0.0.1:9', key: 'k', link: {} };
  const a = am.accounts[0];
  a.remoteCycles = { wk: [{
    startedAt: 0, endedAt: 7 * 86400_000, resetAt: 7 * 86400_000, axis: 'all', tokens: 10_000_000,
    complete: true, disabledDuring: false, finalUtilization: 0.5, samples: [],
  }] };
  a.remoteOpen = { wk: { startedAt: Date.now() - 2 * 86400_000, windowStartedAt: Date.now() - 2 * 86400_000,
    tokensSoFar: 21_000_000, peakUtilization: 0.7, est: 30_000_000, samples: [] } };
  const t = am.capacityTank(a.index, 'wk');
  assert.equal(t.source, 'cycles', 'precondition: history exists and is used for the Med columns');
  const { TUI } = await import('../src/tui.js');
  const tui = new TUI({ accountManager: am, config: {} });
  tui.capacityWindow = 'wk';
  const txt = tui._renderCapacityPage(150).join('\n').replace(/\x1b\[[0-9;]*m/g, '');
  const row = txt.split('\n').find(l => /^  m\s/.test(l) || /^  m\?/.test(l));
  assert.ok(row, 'the mirror row renders');
  assert.match(row, /30M\s+20M\s+20M\s+20M\s+1/, `Current = cloud live week (30M), Med columns from history (20M), row: ${row}`);
});
