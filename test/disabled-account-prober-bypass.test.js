import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

// The guard in ensureTokenFresh was INERT: prober.js called it with force=true on a
// 401, and `force` deliberately overrides the guard. Worse, the guard GUARANTEED the
// bypass — blocking the proactive refresh means the token always expires, which always
// 401s, moving the rotation from the controlled pre-expiry path into the error path.
//
// Measured by the red team on the real Prober + real AccountManager:
//   without the guard: 1 probe call, 1 rotation
//   with the guard:    2 probe calls, 1 rotation   ← same spend, one wasted round-trip
//
// These tests drive the REAL pair, never a stubbed ensureTokenFresh — the existing
// suite stubs that method out, which is why 634 tests could not see this.

function harness({ enabled }) {
  const am = new AccountManager([{
    name: 'a1', type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
    expiresAt: Date.now() - 1000,          // expired → a refresh would fire
  }], 0.90);
  am.setWriterLease(true);
  am.accounts[0].enabled = enabled;

  const rotations = [];
  am._refreshAccessToken = async () => {
    rotations.push('ROTATED');
    return { accessToken: 'new', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 };
  };

  const probeCalls = [];
  const probeFn = async () => {
    probeCalls.push(1);
    return { status: 401 };               // upstream rejects the (expired) token
  };

  const prober = new Prober(am, { intervalMs: 0, probeFn, providerProbeFn: async () => null, log: () => {} });
  return { am, prober, rotations, probeCalls };
}

test('a DISABLED account spends NO refresh token through the prober 401 path', async () => {
  const { am, prober, rotations, probeCalls } = harness({ enabled: false });
  await prober.probeOne(am.accounts[0]);
  assert.deepEqual(rotations, [], 'the single-use token must not be rotated');
  assert.equal(probeCalls.length, 1, 'and no wasted second probe — we accept the 401');
  assert.equal(am.accounts[0].refreshToken, 'refresh', 'token untouched');
});

test('an ENABLED account still force-refreshes on a 401 (the fix stays scoped)', async () => {
  const { am, prober, rotations, probeCalls } = harness({ enabled: true });
  await prober.probeOne(am.accounts[0]);
  // Two rotations is CORRECT here: the proactive pre-probe refresh (token is expired)
  // plus the forced one after the stubbed 401. The point is that a live account is
  // never barred from either — contrast the disabled case above, which does neither.
  assert.equal(rotations.length, 2, 'a live account refreshes proactively AND recovers from a 401');
  assert.equal(probeCalls.length, 2, 'probe → 401 → forced refresh → re-probe');
});

test('a disabled account with a VALID token is probed without any rotation', async () => {
  const am = new AccountManager([{
    name: 'a1', type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
    expiresAt: Date.now() + 3600_000,
  }], 0.90);
  am.setWriterLease(true);
  am.accounts[0].enabled = false;
  const rotations = [];
  am._refreshAccessToken = async () => { rotations.push(1); return {}; };
  let probes = 0;
  const prober = new Prober(am, {
    intervalMs: 0, probeFn: async () => { probes++; return { fiveHour: { utilization: 0.1 } }; },
    providerProbeFn: async () => null, log: () => {},
  });
  await prober.probeOne(am.accounts[0]);
  // Reading a disabled account's quota is INTENTIONAL (prober.js) — only writing is barred.
  assert.equal(probes, 1, 'a disabled account is still READ');
  assert.deepEqual(rotations, [], 'and never rotated');
});
