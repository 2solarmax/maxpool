import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { createProxyServer } from '../src/server.js';
import { bigBody, close, listen } from './link-fixture.js';

test('a linked refusal at six slots books one account denial without starting service or counting a second origin', async () => {
  const am = new AccountManager([{ name: 'one', type: 'oauth', accessToken: 'a', refreshToken: 'r',
    expiresAt: Date.now() + 3600_000, accountUuid: 'fixture-uuid' }]);
  am.accounts[0].inFlight = 6;
  const proxy = createProxyServer(am, { proxy: { clients: [{ name: 'edge', key: 'test-edge' }] }, queue: { enabled: false } });
  const port = await listen(proxy);
  try {
    async function pin(name) {
      const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'test-edge',
          'x-maxpool-pin-account': name, 'x-maxpool-hops': '1' }, body: bigBody(2000, true),
      });
      assert.equal(response.status, 503);
      await response.text();
      return response.headers.get('x-maxpool-pin-refusal');
    }
    assert.equal(await pin('one'), 'busy');
    assert.equal(await pin('unknown-name'), 'unavailable');
    const summary = am.routingService.snapshot();
    assert.equal(summary.peerArrivals, 2);
    assert.equal(summary.requests, 0);
    assert.equal(summary.capacityDenied, 0);
    assert.equal(summary.peakServing, 0);
    assert.equal(summary.accounts.length, 1, 'unknown pin cannot create an account row');
    const [account] = summary.accounts;
    assert.equal(account.name, 'one');
    assert.equal(account.requests, 1);
    assert.equal(account.failed, 1);
    assert.equal(account.capacityDenied, 1);
    assert.equal(account.concurrencyDenied, 1);
    assert.equal(account.serving, 0);
    assert.equal(account.peakServing, 0);
    assert.equal(am.accounts[0].inFlight, 6);
  } finally {
    await close(proxy);
  }
});
