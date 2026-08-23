import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '/Users/maxkrasnykh/maxpool/src/account-manager.js';

test('status exposes the EXECUTING version separately from the disk read', () => {
  // `version.current` is a package.json disk read: after a self-install it names the
  // newest INSTALLED build, not the running one. Measured 2026-08-23 — the endpoint
  // reported 1.8.7 for a process executing 1.8.6, and a post-deploy check believed it.
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  am.versionInfo = { current: '1.8.7', latest: '1.8.7', hasUpdate: false };
  am.runningVersion = '1.8.6';
  const s = am.getStatus();
  assert.equal(s.version.current, '1.8.7', 'the disk read is still reported');
  assert.equal(s.runningVersion, '1.8.6', 'and the executing version is distinguishable');
});

test('runningVersion is null rather than a guess before it is known', () => {
  const am = new AccountManager([{ name: 'a', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5 }], 0.9);
  assert.equal(am.getStatus().runningVersion, null);
});
