import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { getStatePath, loadState, saveState } from '../src/config.js';

function manager(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth', accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

test('exportQuotaState round-trips quota windows but never credentials', () => {
  const am = manager(2);
  const reset = Date.now() + 3 * 24 * 3600_000;
  am.accounts[0].quota.unified7d = 0.42;
  am.accounts[0].quota.unified7dReset = reset;
  am.accounts[0].quota.unified5h = 0.20;

  const state = am.exportQuotaState();
  assert.equal(state.length, 2);
  assert.equal(state[0].quota.unified7d, 0.42);
  assert.equal(state[0].quota.unified7dReset, reset);
  const serialized = JSON.stringify(state);
  assert.equal(serialized.includes('t1'), false);
  assert.equal(serialized.includes('refreshToken'), false);

  const am2 = manager(2);
  am2.restoreQuotaState(state);
  assert.equal(am2.accounts[0].quota.unified7d, 0.42);
  assert.equal(am2.accounts[0].quota.unified7dReset, reset);
  assert.equal(am2.accounts[0].probing, false); // weekly window now known
});

test('restore matches accounts by identity, not position', () => {
  const am = manager(2);
  am.accounts[0].quota.unified7d = 0.10;
  am.accounts[1].quota.unified7d = 0.90;
  const state = am.exportQuotaState();

  // New manager with the accounts in REVERSE order.
  const am2 = new AccountManager([
    { name: 'a2', type: 'oauth', accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 },
    { name: 'a1', type: 'oauth', accessToken: 'x', refreshToken: 'y', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am2.restoreQuotaState(state);
  assert.equal(am2.accounts.find(a => a.name === 'a1').quota.unified7d, 0.10);
  assert.equal(am2.accounts.find(a => a.name === 'a2').quota.unified7d, 0.90);
});

test('a restored but already-expired window is cleared on first use', () => {
  const am = manager(1);
  am.accounts[0].quota.unified7d = 0.50;
  am.accounts[0].quota.unified7dReset = Date.now() - 1000; // already passed
  const state = am.exportQuotaState();

  const am2 = manager(1);
  am2.restoreQuotaState(state);
  am2._weeklyRawState(am2.accounts[0]); // runs _clearExpiredQuotas
  assert.equal(am2.accounts[0].quota.unified7d, null);
  assert.equal(am2.accounts[0].quota.unified7dReset, null);
});

test('a restored utilization with no reset window is dropped (cannot pin unavailable)', () => {
  const am = manager(1);
  // Simulate a saved state where 5h utilization was high but no reset was known.
  am.restoreQuotaState([{ name: 'a1', quota: { unified5h: 0.99, unified5hReset: null } }]);
  assert.equal(am.accounts[0].quota.unified5h, null);
});

test('restoreQuotaState ignores bad payloads', () => {
  const am = manager(1);
  assert.doesNotThrow(() => am.restoreQuotaState(null));
  assert.doesNotThrow(() => am.restoreQuotaState(undefined));
  assert.doesNotThrow(() => am.restoreQuotaState('nope'));
  assert.doesNotThrow(() => am.restoreQuotaState([{ name: 'a1' }])); // no quota field
});

test('getStatePath is a sibling .state.json of the config', () => {
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = '/tmp/x/maxpool.json';
  try {
    assert.equal(getStatePath(), '/tmp/x/maxpool.state.json');
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
  }
});

test('saveState/loadState round-trip; loadState tolerates a missing file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-state-'));
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'maxpool.json');
  try {
    assert.equal(await loadState(), null); // missing -> null, never throws
    await saveState({ quota: [{ name: 'a1', quota: { unified7d: 0.3 } }] });
    const loaded = await loadState();
    assert.equal(loaded.quota[0].quota.unified7d, 0.3);
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
