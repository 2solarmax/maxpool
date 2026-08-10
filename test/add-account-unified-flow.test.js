import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;

// Reported 2026-08-10: the Accounts screen offered only browser login and an
// Anthropic API key — no path to GLM/Kimi at all — and the Providers screen
// rendered its title and nothing else (its lines were pushed AFTER the
// pad-to-full-height loop, so every one fell past the bottom of the screen).

const am = () => new AccountManager([
  { name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
], 0.90);

test('the add-account type picker offers all FOUR account types', () => {
  const types = TUI.ADD_TYPES;
  assert.equal(types.length, 4);
  const ids = types.map(t => t.id);
  assert.deepEqual(ids, ['anthropic-oauth', 'anthropic-key', 'zai', 'kimi'],
    'subscription, Anthropic key, GLM, Kimi — the four the user named');
  // Every type is reachable by a single keypress.
  assert.deepEqual(types.map(t => t.key), ['1', '2', '3', '4']);
});

test('the type picker RENDERS its options (not just a title)', () => {
  const tui = new TUI({ accountManager: am() });
  const buf = [];
  tui._renderAddType(buf);
  const text = strip(buf.join('\n'));
  assert.match(text, /Anthropic subscription/);
  assert.match(text, /Anthropic API key/);
  assert.match(text, /GLM/);
  assert.match(text, /Kimi/);
  // And it explains BOTH credential sources — the thing that was missing.
  assert.match(text, /GCP Secret Manager/, 'must explain the GCP option');
  assert.match(text, /application-default login/, 'must say HOW gcloud auth works');
});

test('the providers screen explains both credential sources when empty', () => {
  const tui = new TUI({ accountManager: am() });
  const buf = [];
  tui._renderProviders(buf, 100);
  const text = strip(buf.join('\n'));
  assert.match(text, /Paste the API key directly/, 'option A: paste');
  assert.match(text, /GCP Secret Manager/, 'option B: GCP');
  assert.match(text, /gcloud auth application-default login/,
    'a non-Max user must be told how maxpool authenticates to GCP');
  assert.ok(buf.length > 5, 'the panel has real content, not just a header');
});

test('pressing `a` on the accounts screen opens the type picker', () => {
  const tui = new TUI({ accountManager: am() });
  tui.mode = 'accounts';
  tui._keyAccounts('a');
  assert.equal(tui.mode, 'addtype', '`a` is the single entry point');
});

test('each number key selects its account type', () => {
  for (const [key, expectMode] of [['3', 'input'], ['4', 'input']]) {
    const tui = new TUI({ accountManager: am() });
    tui.mode = 'addtype';
    tui._keyAddType(key);
    assert.equal(tui.mode, expectMode, `key ${key} advances into the credential step`);
  }
});

test('Esc returns from the type picker to the accounts screen', () => {
  const tui = new TUI({ accountManager: am() });
  tui.mode = 'addtype';
  tui._keyAddType('esc');
  assert.equal(tui.mode, 'accounts');
});

test('a GCP secret NAME is distinguished from a pasted API key', async () => {
  const tui = new TUI({ accountManager: am() });
  // A pasted key comes back unchanged (no GCP round-trip).
  const pasted = await tui._resolveCredential('cfe7f0a84d9b494195f9785760889a7b.CzXESfxJjBx5N0QV');
  assert.equal(pasted, 'cfe7f0a84d9b494195f9785760889a7b.CzXESfxJjBx5N0QV',
    'a real key (dots, mixed case) is used verbatim');
  // A GCP-shaped name that does not exist resolves to null, with an actionable log.
  const missing = await tui._resolveCredential('NONEXISTENT_SECRET_XYZ_12345');
  assert.equal(missing, null, 'an unresolvable GCP name fails cleanly');
});

test('the accounts footer advertises Add account', () => {
  const tui = new TUI({ accountManager: am() });
  tui.mode = 'accounts';
  assert.match(strip(tui._renderFooter()), /a.*Add account/);
});

// ── hide/show disabled accounts (requested 2026-08-10) ───────────────────────

test('h toggles hiding disabled accounts', () => {
  const m = new AccountManager([
    { name: 'live', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
    { name: 'dead', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  m.accounts[1].enabled = false;
  const tui = new TUI({ accountManager: m });
  assert.equal(tui.hideDisabled, false, 'shows everything by default');
  tui._keyNormal('h');
  assert.equal(tui.hideDisabled, true, 'h hides them');
  tui._keyNormal('h');
  assert.equal(tui.hideDisabled, false, 'h shows them again');
});

test('the main footer advertises the hide-disabled key', () => {
  const tui = new TUI({ accountManager: am() });
  tui.mode = 'normal';
  assert.match(strip(tui._renderFooter()), /h.*Hide disabled/);
});
