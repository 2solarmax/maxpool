import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { Prober } from '../src/prober.js';

function manager(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}
function invalidGrant() { const e = new Error('Token refresh failed (400): invalid_grant'); e.status = 400; e.retryable = false; return e; }

// ── the storm: a dead refresh token must latch and stop being retried ──────────

test('a rejected refresh (invalid_grant) latches refreshDead + does NOT retry the dead token', async () => {
  const am = manager(2);
  const acct = am.accounts[0];
  acct.expiresAt = Date.now() - 1000;           // expired → forces a refresh
  let posts = 0;
  am._refreshAccessToken = async () => { posts++; throw invalidGrant(); };

  const r1 = await am.ensureTokenFresh(0);
  assert.equal(r1, false, 'refresh failed → not fresh');
  assert.equal(acct.status, 'error');
  assert.equal(acct.refreshDead, true, 'latched as auth-dead');
  assert.equal(posts, 1);

  // Every subsequent attempt must short-circuit — no more POSTing the dead token.
  await am.ensureTokenFresh(0);
  await am.ensureTokenFresh(0);
  assert.equal(posts, 1, 'the dead token is never re-POSTed (storm killed)');
});

test('a TRANSIENT refresh failure (network) does NOT latch refreshDead (stays recoverable)', async () => {
  const am = manager(1);
  am.accounts[0].expiresAt = Date.now() - 1000;
  am._refreshAccessToken = async () => { const e = new Error('fetch failed'); e.retryable = true; throw e; };
  await am.ensureTokenFresh(0);
  assert.notEqual(am.accounts[0].refreshDead, true, 'a network blip is not a dead token — must stay retryable');
});

test('the prober SKIPS a refreshDead account (no 60s probe storm)', async () => {
  const am = manager(2);
  am.accounts[0].refreshDead = true;
  am.ensureTokenFresh = async () => true; // stub — not under test here
  const probed = [];
  const prober = new Prober(am, { probeFn: async (cred) => { probed.push(cred); return { sevenDay: { utilization: 0.1, resetAt: Date.now() + 8.64e7 } }; }, timeoutMs: 500 });
  await prober.probeAll();
  assert.ok(!probed.includes(am.accounts[0].credential), 'the dead account is NOT probed');
  assert.ok(probed.includes(am.accounts[1].credential), 'the healthy account IS probed');
});

// ── recovery: re-auth revives a dead-refresh account ───────────────────────────

test('updateAccountTokens (re-auth) clears refreshDead + flips error→active', () => {
  const am = manager(1);
  am.accounts[0].refreshDead = true;
  am.accounts[0].status = 'error';
  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'newRT', expiresAt: Date.now() + 3600_000 });
  assert.equal(am.accounts[0].refreshDead, false);
  assert.equal(am.accounts[0].status, 'active');
  // And ensureTokenFresh works again (fresh token, not expiring → true; not short-circuited).
  am._refreshAccessToken = async () => { throw new Error('should not be called — token is fresh'); };
});

test('after re-auth, ensureTokenFresh no longer short-circuits (refreshDead cleared)', async () => {
  const am = manager(1);
  am.accounts[0].refreshDead = true;
  am.accounts[0].expiresAt = Date.now() - 1000;
  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'newRT', expiresAt: Date.now() - 1000 }); // still expired to force a refresh attempt
  let posts = 0;
  am._refreshAccessToken = async () => { posts++; return { accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }; };
  const r = await am.ensureTokenFresh(0);
  assert.equal(r, true, 'a revived account refreshes normally');
  assert.equal(posts, 1, 'the guard no longer blocks it');
});

// ── display: getStatus exposes refreshDead (drives the TUI "reauth" label) ─────

test('getStatus exposes refreshDead', () => {
  const am = manager(2);
  am.accounts[0].refreshDead = true;
  const s = am.getStatus();
  const a1 = s.accounts.find(a => a.name === 'a1');
  const a2 = s.accounts.find(a => a.name === 'a2');
  assert.equal(a1.refreshDead, true);
  assert.equal(a2.refreshDead, false);
});
