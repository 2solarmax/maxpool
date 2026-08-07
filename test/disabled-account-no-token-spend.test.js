import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

// A DISABLED account must never spend its single-use refresh token.
//
// Anthropic's refresh tokens are single-use: each rotation invalidates the previous
// one. A rotation that races a restart loses the new token and the account dies with
// invalid_grant — permanently, until browser re-auth. Reported 2026-08-07: maxpool
// was refreshing tokens for accounts the user had explicitly disabled, and several
// died with `invalid_grant` ("Refresh token not found or invalid").
//
// The prober still READS a disabled account's quota by design (you disable an
// exhausted account and still want to watch it recover — prober.js:73). Reading is
// safe; rotating is the write that bricks it.

const oauthAcct = (over = {}) => ({
  name: 'a1', type: 'oauth', accessToken: 'access', refreshToken: 'refresh',
  expiresAt: Date.now() - 1000,   // already expired → refresh would fire
  ...over,
});

function managerWithSpy(acctOver = {}) {
  const am = new AccountManager([oauthAcct(acctOver)], 0.90);
  am.setWriterLease(true);        // rotation requires the lease
  const calls = [];
  am._refreshAccessToken = async (tok) => {
    calls.push(tok);
    return { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 };
  };
  return { am, calls };
}

test('a DISABLED account does not spend its refresh token', async () => {
  const { am, calls } = managerWithSpy();
  am.accounts[0].enabled = false;
  const ok = await am.ensureTokenFresh(0);
  assert.equal(calls.length, 0, 'no rotation for a disabled account');
  assert.equal(ok, true, 'it still reports usable — the prober reads with the existing token');
  assert.equal(am.accounts[0].refreshToken, 'refresh', 'the single-use token is untouched');
});

test('an ENABLED account with an expired token DOES refresh (the fix is scoped)', async () => {
  const { am, calls } = managerWithSpy();
  assert.equal(am.accounts[0].enabled, true);
  await am.ensureTokenFresh(0);
  assert.equal(calls.length, 1, 'a live account still rotates normally');
  assert.equal(am.accounts[0].refreshToken, 'new-refresh');
});

test('force=true still refreshes a disabled account (explicit re-auth path)', async () => {
  const { am, calls } = managerWithSpy();
  am.accounts[0].enabled = false;
  await am.ensureTokenFresh(0, true);
  assert.equal(calls.length, 1, 'an explicit forced refresh is still allowed');
});

test('a disabled account with a still-VALID token is a no-op either way', async () => {
  const { am, calls } = managerWithSpy({ expiresAt: Date.now() + 3600_000 });
  am.accounts[0].enabled = false;
  await am.ensureTokenFresh(0);
  assert.equal(calls.length, 0);
});

test('the refreshDead guard still fires first (no rotation on a dead token)', async () => {
  const { am, calls } = managerWithSpy();
  am.accounts[0].refreshDead = true;
  const ok = await am.ensureTokenFresh(0);
  assert.equal(calls.length, 0);
  assert.equal(ok, false, 'a dead token reports UNusable, unlike merely-disabled');
});

test('the writer-lease guard still fires (a lease-less worker never rotates)', async () => {
  const { am, calls } = managerWithSpy();
  am.setWriterLease(false);
  await am.ensureTokenFresh(0);
  assert.equal(calls.length, 0);
});

// ── config providers honor an explicit `enabled: false` ───────────────────────

test('a config provider marked enabled:false loads benched', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([
    { name: 'glm max@gomokka.com', provider: 'zai', token: 'k1' },
    { name: 'glm privacy@gomokka.com', provider: 'zai', token: 'k2', enabled: false },
  ]);
  const live = am.accounts.find(a => a.name === 'glm max@gomokka.com');
  const benched = am.accounts.find(a => a.name === 'glm privacy@gomokka.com');
  assert.equal(live.enabled, true);
  assert.equal(benched.enabled, false, 'stays benched across restarts');
});

test('a benched config provider is never selected for routing', () => {
  const am = new AccountManager([], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
  am.loadConfigProviders([
    { name: 'glm max@gomokka.com', provider: 'zai', token: 'k1' },
    { name: 'glm privacy@gomokka.com', provider: 'zai', token: 'k2', enabled: false },
  ]);
  for (let i = 0; i < 12; i++) {
    const lease = am.acquireAccount({ profile: 'all' }, new Set());
    assert.equal(lease?.account?.name, 'glm max@gomokka.com', 'the benched account never draws traffic');
    am.releaseAccount(lease, { status: 200 });
  }
});

// ── config providers carry a model map (the z.ai 400 fix) ────────────────────

test('a zai config provider gets a model map — z.ai 400s without one', () => {
  // Measured 2026-08-07: config providers sent no model and z.ai replied
  // `[1210][Invalid API parameter]` on every request, while the header-based
  // provider (which carries x-maxpool-zai-*-model) worked fine.
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{ name: 'glm max@gomokka.com', provider: 'zai', token: 'k1' }]);
  const a = am.accounts[0];
  assert.ok(a.modelMap, 'a zai provider MUST carry a model map');
  assert.equal(a.modelMap.opus, 'glm-5.2');
  assert.equal(a.modelMap.sonnet, 'glm-5.2');
  assert.equal(a.modelMap.haiku, 'glm-5.1');
});

test('a kimi config provider gets a model', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{ name: 'kimi max@gomokka.com', provider: 'kimi', token: 'k1' }]);
  assert.equal(am.accounts[0].model, 'kimi-k3');
});

test('an explicit modelMap in config overrides the default', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{
    name: 'glm-custom', provider: 'zai', token: 'k1',
    modelMap: { opus: 'glm-9', sonnet: 'glm-9', haiku: 'glm-8', default: 'glm-9' },
  }]);
  assert.equal(am.accounts[0].modelMap.opus, 'glm-9');
});
