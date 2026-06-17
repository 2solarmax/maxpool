import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

function manager(count = 3) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`,
      type: 'oauth',
      accessToken: `t${i + 1}`,
      refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

test('adaptive scheduler distributes concurrent leases across healthy accounts', () => {
  const am = manager(3);
  const leases = [];

  for (let i = 0; i < 15; i++) {
    leases.push(am.acquireAccount({ weight: 1 }));
  }

  assert.deepEqual(
    am.accounts.map(a => a.inFlight),
    [5, 5, 5],
  );

  for (const lease of leases) am.releaseAccount(lease, { success: true });
  assert.deepEqual(am.accounts.map(a => a.inFlight), [0, 0, 0]);
});

test('scheduler skips throttled accounts and resumes them after retry window', () => {
  const am = manager(2);
  am.markRateLimited(0, 60);

  const lease = am.acquireAccount({ weight: 1 });
  assert.equal(lease.account.name, 'a2');
  am.releaseAccount(lease, { success: true });

  am.accounts[0].rateLimitedUntil = Date.now() - 1;
  const laterLeases = Array.from({ length: 8 }, () => am.acquireAccount({ weight: 1 }));
  assert.ok(laterLeases.some(l => l.account.name === 'a1'));
});
