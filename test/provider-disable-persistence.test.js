// A disabled provider must STAY disabled across a reload, and the hide-disabled view
// choice must survive one too.
//
// Driver 2026-09-11, owner-reported: "I have previously disabled Kimi. Why does it get
// re-enabled after the update?" — and "I usually hide disabled accounts, but after the
// update they get unhidden." Both were real. `loadConfigProviders` re-derives enabled
// from the CONFIG entry on every reload (`enabled: entry.enabled !== false`), so a
// runtime-only flag is silently undone by the next auto-update; and hideDisabled was a
// plain field initialised to false with nothing persisting it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const providerEntry = (name, extra = {}) => ({
  name, provider: 'kimi', token: 'tok-' + name, ...extra,
});

test('a config provider marked enabled:false stays disabled through a reload', () => {
  const m = new AccountManager([], 0.9, {});
  m.loadConfigProviders([providerEntry('kimi max@gomokka.com', { enabled: false })]);
  const k = m.accounts.find(a => a.name === 'kimi max@gomokka.com');
  assert.ok(k, 'provider created');
  assert.equal(k.enabled, false, 'disabled on first load');

  // A reload re-runs loadConfigProviders against the same config — this is the exact
  // path an auto-update takes, and the one that resurrected Kimi.
  m.loadConfigProviders([providerEntry('kimi max@gomokka.com', { enabled: false })]);
  assert.equal(m.accounts.find(a => a.name === 'kimi max@gomokka.com').enabled, false,
    'STILL disabled after reload');
});

test('a config entry with NO enabled key defaults to enabled — the bug\'s mechanism', () => {
  // This is why a runtime-only disable did not survive: absent key => enabled.
  // Pinned so the default is a deliberate choice, not an accident.
  const m = new AccountManager([], 0.9, {});
  m.loadConfigProviders([providerEntry('kimi max@gomokka.com')]);
  assert.equal(m.accounts.find(a => a.name === 'kimi max@gomokka.com').enabled, true);
});

test('re-enabling in config re-enables on reload', () => {
  const m = new AccountManager([], 0.9, {});
  m.loadConfigProviders([providerEntry('k', { enabled: false })]);
  assert.equal(m.accounts.find(a => a.name === 'k').enabled, false);
  m.loadConfigProviders([providerEntry('k', { enabled: true })]);
  assert.equal(m.accounts.find(a => a.name === 'k').enabled, true);
});

test('disabling one provider does not disturb its siblings', () => {
  const m = new AccountManager([], 0.9, {});
  m.loadConfigProviders([
    providerEntry('kimi max@gomokka.com', { enabled: false }),
    { name: 'glm a', provider: 'zai', token: 'z1' },
    { name: 'glm b', provider: 'zai', token: 'z2', enabled: true },
  ]);
  const by = Object.fromEntries(m.accounts.map(a => [a.name, a.enabled]));
  assert.equal(by['kimi max@gomokka.com'], false);
  assert.equal(by['glm a'], true);
  assert.equal(by['glm b'], true);
});

// ── the FIX itself: the disable must reach the config entry loadConfigProviders reads ──

import { __tuiTest } from '../src/tui.js';
const { applyProviderEnabledToConfig } = __tuiTest;

test('disabling a CONFIG provider writes enabled:false into config.providers', () => {
  // Without this the flag lives only in runtime state and the next reload re-enables it —
  // the exact Kimi regression. A mutant that drops the write fails here.
  const config = { providers: [{ name: 'kimi max@gomokka.com', provider: 'kimi' }] };
  const r = applyProviderEnabledToConfig(config, 'kimi max@gomokka.com', false);
  assert.equal(r.changed, true);
  assert.equal(config.providers[0].enabled, false);

  // and it round-trips through the reload path that caused the bug
  const m = new AccountManager([], 0.9, {});
  m.loadConfigProviders(config.providers.map(p => ({ ...p, token: 't' })));
  assert.equal(m.accounts.find(a => a.name === 'kimi max@gomokka.com').enabled, false);
});

test('the previous value is returned so a failed save can roll back', () => {
  const config = { providers: [{ name: 'k', enabled: true }] };
  const r = applyProviderEnabledToConfig(config, 'k', false);
  assert.equal(r.previous, true);
  applyProviderEnabledToConfig(config, 'k', r.previous);
  assert.equal(config.providers[0].enabled, true, 'rolled back');
});

test('a header-derived provider (no config entry) reports changed:false', () => {
  // Its runtime-only flag is durable for it; we must not invent a config entry.
  const config = { providers: [{ name: 'other' }] };
  assert.equal(applyProviderEnabledToConfig(config, 'glm-fallback', false).changed, false);
  assert.equal(config.providers.length, 1, 'no entry invented');
});

test('a config with no providers array is handled, not thrown on', () => {
  assert.equal(applyProviderEnabledToConfig({}, 'k', false).changed, false);
  assert.equal(applyProviderEnabledToConfig(null, 'k', false).changed, false);
});
