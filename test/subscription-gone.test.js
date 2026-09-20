// SUBSCRIPTION-GONE LATCH (2026-09-20). "OAuth authentication is currently not
// allowed for this organization" = the subscription is gone server-side (a canceled
// plan lapsing). Before this, maxpool logged the 403 and failed over per-request,
// and the PROBE path logged "Quota probe has failed 700x" while still hammering the
// endpoint every 60s — nothing ever concluded "this account has no subscription".
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

const acct = (name) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 36e5,
});

const ORG_MSG = 'OAuth authentication is currently not allowed for this organization.';

test('probe: 3x org-403 latches subscriptionGone; probing stops; availability drops', () => {
  const am = new AccountManager([acct('x'), acct('ok')], 0.9);
  const a = am.accounts[0];
  for (let i = 0; i < 3; i++) am.recordProbeError(0, ORG_MSG, 403);
  assert.equal(a.subscriptionGone, true, 'latched at 3 strikes');
  assert.equal(am._isAvailable(a), false, 'benched from routing');
  // the OTHER 403 (quota/permission) must NOT latch
  const am2 = new AccountManager([acct('y')], 0.9);
  for (let i = 0; i < 10; i++) am2.recordProbeError(0, 'some other 403', 403);
  assert.equal(am2.accounts[0].subscriptionGone, undefined, 'non-org 403 does not latch');
});

test('prober skips a latched account without touching the network', async () => {
  const am = new AccountManager([acct('x')], 0.9);
  am.accounts[0].subscriptionGone = true;
  let probed = 0;
  const p = new Prober(am, { intervalMs: 0, probeFn: async () => { probed++; return {}; } });
  const r = await p.probeOne(am.accounts[0]);
  assert.equal(r.ok, false);
  assert.equal(probed, 0, 'probeFn never called for a latched account');
});

test('re-auth clears the latch (org accepts OAuth again)', () => {
  const am = new AccountManager([acct('x')], 0.9);
  am.accounts[0].subscriptionGone = true;
  am.updateAccountTokens(0, { accessToken: 'n', refreshToken: 'nr', expiresAt: Date.now() + 36e5 });
  assert.equal(am.accounts[0].subscriptionGone, false, 'cleared on successful re-auth');
});

test('2 strikes do not latch (3-strike rule like the 401 path)', () => {
  const am = new AccountManager([acct('x')], 0.9);
  am.recordProbeError(0, ORG_MSG, 403);
  am.recordProbeError(0, ORG_MSG, 403);
  assert.equal(am.accounts[0].subscriptionGone, undefined, 'needs 3');
});
