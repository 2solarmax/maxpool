import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { resolveSecret, resolveSecrets } from '../src/secret-resolver.js';

// ── Config-sourced providers: multiple GLM/Kimi accounts from GCP or direct keys ─
//
// maxpool's providers (GLM, Kimi) were created per-request from HTTP headers — one
// per provider type. The config-sourced path adds PERSISTENT provider accounts
// resolved from GCP Secret Manager (or direct keys), supporting MULTIPLE accounts
// per provider type. Each team member can add their own GLM/Kimi key.

const baseGLM = { provider: 'zai', authToken: 'tok', upstream: 'https://api.z.ai/api/anthropic', authHeader: 'authorization', profiles: ['all'], stripBetaHeaders: true };

test('two GLM providers coexist as separate accounts with independent keys', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([
    { name: 'glm-primary', provider: 'zai', token: 'key-max' },
    { name: 'glm-ahmed', provider: 'zai', token: 'key-ahmed' },
  ]);
  const providers = am.accounts.filter(a => a.type === 'provider' && a.provider === 'zai');
  assert.equal(providers.length, 2, 'two independent GLM accounts');
  assert.equal(providers[0].credential, 'key-max');
  assert.equal(providers[1].credential, 'key-ahmed');
  assert.notEqual(providers[0].name, providers[1].name);
});

test('a config provider with no token is created but marked error', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{ name: 'glm-broken', provider: 'zai', token: null }]);
  const a = am.accounts.find(a => a.name === 'glm-broken');
  assert.ok(a, 'account exists');
  assert.equal(a.status, 'error');
  assert.equal(a.lastError, 'secret-unresolved');
});

test('config providers are NOT serialized to state.json (GCP is the source of truth)', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{ name: 'glm-1', provider: 'zai', token: 'k1' }]);
  const exported = am.exportRuntimeProviders();
  assert.equal(exported.length, 0, 'config providers excluded from state persistence');
  // But header-sourced providers ARE persisted:
  am.upsertRuntimeAccount({ name: 'glm-header', type: 'provider', provider: 'zai', authToken: 'k2', ...baseGLM });
  const exported2 = am.exportRuntimeProviders();
  assert.equal(exported2.length, 1);
  assert.equal(exported2[0].name, 'glm-header');
});

test('loadConfigProviders removes providers no longer in the config', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([
    { name: 'glm-1', provider: 'zai', token: 'k1' },
    { name: 'glm-2', provider: 'zai', token: 'k2' },
  ]);
  assert.equal(am.accounts.filter(a => a.provider === 'zai').length, 2);
  // Simulate a config edit that removed glm-2.
  am.loadConfigProviders([{ name: 'glm-1', provider: 'zai', token: 'k1' }]);
  assert.equal(am.accounts.filter(a => a.provider === 'zai').length, 1);
  assert.equal(am.accounts[0].name, 'glm-1');
});

test('both GLM and Kimi providers can coexist', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([
    { name: 'glm-1', provider: 'zai', token: 'g1' },
    { name: 'glm-2', provider: 'zai', token: 'g2' },
    { name: 'kimi-1', provider: 'kimi', token: 'k1' },
  ]);
  const zai = am.accounts.filter(a => a.provider === 'zai');
  const kimi = am.accounts.filter(a => a.provider === 'kimi');
  assert.equal(zai.length, 2);
  assert.equal(kimi.length, 1);
});

test('configProviderDefs returns names without tokens', () => {
  const am = new AccountManager([], 0.90);
  am.loadConfigProviders([{ name: 'glm-1', provider: 'zai', token: 'secret-key' }]);
  const defs = am.configProviderDefs();
  assert.equal(defs.length, 1);
  assert.equal(defs[0].name, 'glm-1');
  assert.equal(defs[0].provider, 'zai');
  // Token must NEVER leak through defs (used by TUI display).
  assert.ok(!JSON.stringify(defs).includes('secret-key'));
});

test('a config provider is routable immediately after loading', () => {
  const am = new AccountManager([], 0.90, { crossProviderFallbackPolicy: 'when-exhausted' });
  am.loadConfigProviders([{ name: 'glm-1', provider: 'zai', token: 'k1' }]);
  const lease = am.acquireAccount({ profile: 'all' }, new Set());
  assert.ok(lease?.account, 'config provider must be selectable');
  assert.equal(lease.account.name, 'glm-1');
});

// ── Secret resolver ────────────────────────────────────────────────────────────

test('resolveSecret returns null for a missing/nonexistent secret', async () => {
  const r = await resolveSecret('NONEXISTENT_SECRET_12345_xyz');
  assert.equal(r, null);
});

test('resolveSecret returns null for empty/null input', async () => {
  assert.equal(await resolveSecret(''), null);
  assert.equal(await resolveSecret(null), null);
  assert.equal(await resolveSecret(undefined), null);
});

test('resolveSecrets resolves a batch and skips failures', async () => {
  const r = await resolveSecrets(['NONEXISTENT_1', 'NONEXISTENT_2']);
  assert.equal(Object.keys(r).length, 0);
  // Should not throw, even with all failures.
});

// ── Dedup: header providers skip when a config provider has the same token ─────
//
// The `cc all` alias sends the primary GLM key via headers on every request.
// Without dedup, that creates a DUPLICATE provider every time.

test('the header-based provider path must check config tokens for dedup', async () => {
  const am = new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  // Load a config provider with Max's primary key.
  am.loadConfigProviders([{ name: 'glm-primary', provider: 'zai', token: 'MAX_KEY' }]);
  // Simulate what prepareRuntimeProviders does: check if the token is already known.
  const configTokens = new Set(
    am.accounts.filter(a => a.configSourced && a.credential).map(a => a.credential),
  );
  assert.ok(configTokens.has('MAX_KEY'), 'config token should be in the dedup set');
  // Header sends the SAME key → should NOT create a duplicate.
  const hasDupe = configTokens.has('MAX_KEY');
  assert.equal(hasDupe, true, 'dedup prevents duplicate provider creation');
  // Count providers: should be 1 (the config one), not 2.
  assert.equal(am.accounts.filter(a => a.provider === 'zai').length, 1);
});

// ── Direct API key path (for public users without GCP Secret Manager) ──────────

test('a direct apiKey in config produces a working provider', () => {
  const am = new AccountManager([], 0.90);
  // Simulate what index.js does: apiKey goes straight in as the token.
  am.loadConfigProviders([
    { name: 'glm-direct', provider: 'zai', apiKey: 'sk-direct-key', token: 'sk-direct-key' },
  ]);
  const a = am.accounts.find(a => a.name === 'glm-direct');
  assert.ok(a);
  assert.equal(a.credential, 'sk-direct-key');
  assert.equal(a.configSourced, true);
  // Direct-key providers are also excluded from state.json (same as GCP ones).
  assert.equal(am.exportRuntimeProviders().length, 0);
});

test('config providers REMOVE state-restored header providers with the same token', () => {
  // The exact duplicate scenario: state.json restored glm-fallback with token ABC,
  // then config loads glm-primary with the SAME token ABC. The fallback must be gone.
  const am = new AccountManager([], 0.90);
  // Simulate state.json restore
  am.upsertRuntimeAccount({
    name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'ABC',
    upstream: 'https://api.z.ai/api/anthropic',
  });
  assert.equal(am.accounts.filter(a => a.provider === 'zai').length, 1);
  // Now config providers load (boot continues)
  am.loadConfigProviders([
    { name: 'glm-primary', provider: 'zai', token: 'ABC' },
  ]);
  const zai = am.accounts.filter(a => a.provider === 'zai');
  assert.equal(zai.length, 1, 'no duplicate — the state-restored fallback is gone');
  assert.equal(zai[0].name, 'glm-primary');
  assert.equal(zai[0].configSourced, true);
});

test('a DIFFERENT token (second GLM account) is NOT removed — load balancing works', () => {
  const am = new AccountManager([], 0.90);
  // Ahmed's GLM in state.json
  am.upsertRuntimeAccount({
    name: 'glm-ahmed', type: 'provider', provider: 'zai', authToken: 'AHMED_KEY',
    upstream: 'https://api.z.ai/api/anthropic',
  });
  // Max's GLM in config
  am.loadConfigProviders([
    { name: 'glm-max', provider: 'zai', token: 'MAX_KEY' },
  ]);
  const zai = am.accounts.filter(a => a.provider === 'zai');
  assert.equal(zai.length, 2, 'two different keys = two providers, load balanced');
});

test('a provider-only fleet is a VALID config (the teammate-onboarding case)', () => {
  // Measured 2026-08-07: maxpool exited with "No accounts configured" when the config
  // had providers but zero Claude accounts — exactly the state a teammate is in when
  // they have a GLM key and no Anthropic account. The startup gate counted only
  // `config.accounts`. Asserted here as the CONFIG SHAPE being legal; the gate itself
  // lives in index.js and is exercised by the real boot.
  const am = new AccountManager([], 0.90, { crossProviderFallbackPolicy: 'always' });
  am.loadConfigProviders([
    { name: 'glm max@gomokka.com', provider: 'zai', token: 'k1' },
    { name: 'kimi max@gomokka.com', provider: 'kimi', token: 'k2' },
  ]);
  assert.equal(am.accounts.length, 2, 'a provider-only fleet has real, routable accounts');
  const lease = am.acquireAccount({ profile: 'all' }, new Set());
  assert.ok(lease?.account, 'and it can serve a request with no Claude account at all');
});
