// Concurrent-refresh torture: two AccountManagers (two workers) built from the
// SAME config force a near-simultaneous token refresh on one account under the
// single-writer baton. Anthropic rotates the single-use refresh token on every
// use; two refreshers → one invalidates the other → invalid_grant → bricked
// account. The lease rule guarantees ONLY the lease holder rotates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A fake upstream token endpoint that enforces single-use refresh tokens, the
// way Anthropic does: presenting a previously-rotated (now-invalid) refresh
// token fails with invalid_grant.
function makeRotatingUpstream() {
  let current = 'r0';
  let rotations = 0;
  const invalidated = new Set();
  const refreshAccessToken = async (refreshToken) => {
    if (refreshToken !== current || invalidated.has(refreshToken)) {
      const err = new Error('Token refresh failed (400 invalid_grant)');
      err.status = 400;
      err.retryable = false;
      throw err;
    }
    invalidated.add(current);
    rotations++;
    current = `r${rotations}`;
    return { accessToken: `at${rotations}`, refreshToken: current, expiresAt: Date.now() + 3600_000 };
  };
  return { refreshAccessToken, rotations: () => rotations, current: () => current };
}

function makeAM(upstream, { lease }) {
  const am = new AccountManager(
    [{ name: 'a1', type: 'oauth', accessToken: 'at0', refreshToken: 'r0', expiresAt: Date.now() - 1000 }],
    0.90, {},
    { refreshAccessToken: upstream.refreshAccessToken },
  );
  am.setWriterLease(lease);
  return am;
}

test('only the lease holder rotates; the non-lease worker refresh is a no-op (no invalid_grant)', async () => {
  const upstream = makeRotatingUpstream();
  const leaseHolder = makeAM(upstream, { lease: true });
  const follower = makeAM(upstream, { lease: false });

  // Force a near-simultaneous refresh on the SAME single-use token from both.
  const [leaseResult, followerResult] = await Promise.all([
    leaseHolder.ensureTokenFresh(0, true),
    follower.ensureTokenFresh(0, true),
  ]);

  // Exactly ONE rotation happened on the upstream.
  assert.equal(upstream.rotations(), 1, 'refresh token must rotate exactly once');

  // The lease holder rotated and is healthy.
  assert.equal(leaseResult, true);
  assert.equal(leaseHolder.accounts[0].credential, 'at1');
  assert.equal(leaseHolder.accounts[0].refreshToken, 'r1');
  assert.equal(leaseHolder.accounts[0].status, 'active');

  // The follower did NOT rotate (no-op) and ended up in NO auth-failed state.
  assert.equal(followerResult, true, 'non-lease refresh is a benign no-op');
  assert.equal(follower.accounts[0].status, 'active', 'follower never hits invalid_grant');
  assert.equal(follower.accounts[0].credential, 'at0', 'follower keeps its existing access token');
});

test('without the single-writer rule, two refreshers brick the account (control)', async () => {
  // Control: BOTH hold the lease (the forbidden symmetric-overlap world). One of
  // them presents the now-invalidated token → invalid_grant → auth-failed.
  const upstream = makeRotatingUpstream();
  const a = makeAM(upstream, { lease: true });
  const b = makeAM(upstream, { lease: true });

  const results = await Promise.all([
    a.ensureTokenFresh(0, true),
    b.ensureTokenFresh(0, true),
  ]);

  // Two rotations attempted; the second presents the rotated/invalidated token.
  const bricked = (a.accounts[0].status === 'error') || (b.accounts[0].status === 'error');
  const oneFailed = results.includes(false);
  assert.ok(bricked && oneFailed, 'symmetric overlap bricks one account — exactly what the lease prevents');
});

test('setWriterLease(false) makes ensureTokenFresh a pure no-op even when expired', async () => {
  const upstream = makeRotatingUpstream();
  const am = makeAM(upstream, { lease: false });
  am.accounts[0].expiresAt = Date.now() - 10_000; // very expired

  const ok = await am.ensureTokenFresh(0);
  assert.equal(ok, true);
  assert.equal(upstream.rotations(), 0, 'no rotation while lease released');
  assert.equal(am.accounts[0].credential, 'at0', 'serves on existing access token');
});
