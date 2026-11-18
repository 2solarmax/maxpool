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
