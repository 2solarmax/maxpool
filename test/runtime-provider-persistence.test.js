import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AccountManager } from '../src/account-manager.js';
import { saveState, loadState } from '../src/config.js';

function oauthAM(count = 2) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

// The exact shape prepareRuntimeProviders (server.js) upserts from `cc all` headers.
function addGlm(am, token = 'zai-tok') {
  am.upsertRuntimeAccount({
    name: 'glm-fallback', type: 'provider', provider: 'zai',
    authToken: token, upstream: 'https://api.z.ai/api/anthropic', authHeader: 'authorization',
    profiles: ['all'], priority: 10, modelMap: { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.1', default: 'glm-5.2' },
    stripBetaHeaders: true,
  });
}
function addKimi(am, token = 'kimi-tok') {
  am.upsertRuntimeAccount({
    name: 'kimi-fallback', type: 'provider', provider: 'kimi',
    authToken: token, upstream: 'https://api.kimi.com/coding', authHeader: 'authorization',
    profiles: ['all'], priority: 20, model: 'kimi-k2.7', stripBetaHeaders: true,
  });
}

// ── the reported bug: after a restart, the providers vanish ───────────────────

test('exportRuntimeProviders captures runtime providers, excludes OAuth + non-runtime', () => {
  const am = oauthAM(2);
  addGlm(am);
  addKimi(am);
  const exported = am.exportRuntimeProviders();
  assert.equal(exported.length, 2, 'only the 2 runtime providers');
  const names = exported.map(p => p.name).sort();
  assert.deepEqual(names, ['glm-fallback', 'kimi-fallback']);
  const glm = exported.find(p => p.name === 'glm-fallback');
  assert.equal(glm.provider, 'zai');
  assert.equal(glm.authToken, 'zai-tok', 'token carried so it survives the restart');
  assert.equal(glm.upstream, 'https://api.z.ai/api/anthropic');
  assert.deepEqual(glm.modelMap, { opus: 'glm-5.2', sonnet: 'glm-5.2', haiku: 'glm-5.1', default: 'glm-5.2' });
  assert.equal(glm.priority, 10);
  // No OAuth account leaks into the export.
  assert.ok(!exported.some(p => p.name.startsWith('a')));
});

test('a restart round-trip: providers restored into a fresh AM (they show + route again)', () => {
  const before = oauthAM(2);
  addGlm(before);
  addKimi(before);
  const persisted = JSON.parse(JSON.stringify(before.exportRuntimeProviders())); // through the state file

  // Simulate the restart: a fresh process boots from config (OAuth accounts only).
  const after = oauthAM(2);
  assert.equal(after.accounts.filter(a => a.type === 'provider').length, 0, 'fresh boot has NO providers — the bug');

  after.restoreRuntimeProviders(persisted);
  const providers = after.accounts.filter(a => a.type === 'provider');
  assert.equal(providers.length, 2, 'both providers restored on boot');
  const glm = after.accounts.find(a => a.name === 'glm-fallback');
  assert.equal(glm.type, 'provider');
  assert.equal(glm.provider, 'zai');
  assert.equal(glm.credential, 'zai-tok', 'authToken mapped back to credential (the probe/route token)');
  assert.equal(glm.runtime, true);
  // Restored providers surface in getStatus (→ the TUI renders them).
  const statusNames = after.getStatus().accounts.map(a => a.name);
  assert.ok(statusNames.includes('glm-fallback') && statusNames.includes('kimi-fallback'));
});

test('restoreRuntimeProviders skips malformed / tokenless entries', () => {
  const am = oauthAM(1);
  am.restoreRuntimeProviders([
    { name: 'glm-fallback', provider: 'zai', authToken: 'z', upstream: 'https://api.z.ai/api/anthropic', type: 'provider' },
    { name: 'no-token', provider: 'zai', type: 'provider' },  // no token → skip
    null,                                                      // junk → skip
    { provider: 'zai', authToken: 'x', type: 'provider' },    // no name → skip
  ]);
  const providers = am.accounts.filter(a => a.type === 'provider');
  assert.equal(providers.length, 1);
  assert.equal(providers[0].name, 'glm-fallback');
});

test('a live cc-all header upsert overrides a restored (possibly stale) token', () => {
  const am = oauthAM(1);
  am.restoreRuntimeProviders([{ name: 'glm-fallback', provider: 'zai', authToken: 'STALE', upstream: 'https://api.z.ai/api/anthropic', type: 'provider', profiles: ['all'], priority: 10 }]);
  assert.equal(am.accounts.find(a => a.name === 'glm-fallback').credential, 'STALE');
  // The next cc-all request refreshes the token before it's used to route.
  addGlm(am, 'FRESH');
  assert.equal(am.accounts.find(a => a.name === 'glm-fallback').credential, 'FRESH');
  assert.equal(am.accounts.filter(a => a.name === 'glm-fallback').length, 1, 'upsert, not duplicate');
});

test('exportRuntimeProviders is empty (not null) when there are no providers', () => {
  const am = oauthAM(2);
  assert.deepEqual(am.exportRuntimeProviders(), [], 'empty array so state.runtimeProviders=[] is harmless');
});

// ── full state.json round-trip (the index.js persist/restore wiring) ──────────

test('providers survive a real saveState → loadState → restore cycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-rtp-'));
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'maxpool.json');
  try {
    const before = oauthAM(2);
    addGlm(before, 'zai-persisted');
    addKimi(before, 'kimi-persisted');

    // Mirror index.js persistQuotaState: quota + runtimeProviders in one state write.
    await saveState({ quota: before.exportQuotaState(), runtimeProviders: before.exportRuntimeProviders() });

    // Mirror the boot path: fresh AM + loadState + restore.
    const loaded = await loadState();
    assert.ok(Array.isArray(loaded.runtimeProviders) && loaded.runtimeProviders.length === 2, 'state.json carries the providers');
    const after = oauthAM(2);
    after.restoreQuotaState(loaded.quota);
    after.restoreRuntimeProviders(loaded.runtimeProviders);

    const providers = after.accounts.filter(a => a.type === 'provider');
    assert.equal(providers.length, 2, 'both providers restored from disk');
    assert.equal(after.accounts.find(a => a.name === 'glm-fallback').credential, 'zai-persisted');
    assert.equal(after.accounts.find(a => a.name === 'kimi-fallback').credential, 'kimi-persisted');
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('a pre-fix state.json (no runtimeProviders key) restores cleanly — backward compatible', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'maxpool-rtp-'));
  const prev = process.env.MAXPOOL_CONFIG;
  process.env.MAXPOOL_CONFIG = join(dir, 'maxpool.json');
  try {
    await saveState({ quota: {} }); // old-shape state, no runtimeProviders
    const loaded = await loadState();
    const after = oauthAM(2);
    // index.js guards `if (savedState?.runtimeProviders)` — undefined → skip, no throw.
    if (loaded?.runtimeProviders) after.restoreRuntimeProviders(loaded.runtimeProviders);
    assert.equal(after.accounts.filter(a => a.type === 'provider').length, 0, 'no providers, no crash');
  } finally {
    if (prev === undefined) delete process.env.MAXPOOL_CONFIG;
    else process.env.MAXPOOL_CONFIG = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
