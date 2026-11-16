// getStatus() feeds /maxpool/status. A BENCHED local duplicate's own quota is stale by
// design (never probed, never refreshed — the cloud pool owns the account), so the
// export must not present those numbers as current. The TUI already overlays the
// cloud's numbers via remoteRowFor; the status export marks the source instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function build() {
  const am = new AccountManager([
    { name: 'healthy', type: 'oauth', accessToken: 'h-token', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'benched', type: 'oauth', accessToken: 'b-token', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  for (const a of am.accounts) a.quota = { unified5h: 0.42, unified7d: 0.77, reset5h: 123, reset7d: 456 };
  am.accounts[1].poolBenchedBy = 'cloud-team-row';
  return am;
}

test('status exports no local quota numbers for a benched row, and names the source', () => {
  const rows = build().getStatus().accounts;
  const b = rows.find(r => r.name === 'benched');
  assert.equal(b.quota, null, 'stale local numbers are not exported as current');
  assert.equal(b.quotaSource, 'cloud-mirror');
});

test('status still exports a healthy row quota unchanged', () => {
  const rows = build().getStatus().accounts;
  const h = rows.find(r => r.name === 'healthy');
  assert.equal(h.quota.unified5h, 0.42);
  assert.equal(h.quota.unified7d, 0.77);
  assert.equal(h.quotaSource, 'local');
});
