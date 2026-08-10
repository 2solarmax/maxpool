import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';
import { readFileSync } from 'node:fs';

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

test('the add screen explains both credential sources (moved from the old providers panel)', () => {
  // The Providers screen is gone; its GCP explainer was the only place that told a
  // non-owner HOW maxpool reaches Secret Manager. It must survive the merge.
  const tui = new TUI({ accountManager: am() });
  const buf = [];
  tui._renderAddType(buf);
  const text = strip(buf.join('\n'));
  assert.match(text, /Paste it/, 'option A: paste the key');
  assert.match(text, /GCP Secret Manager/, 'option B: GCP');
  assert.match(text, /gcloud secrets create/, 'how to store it');
  assert.match(text, /gcloud auth application-default login/,
    'a non-Max user must be told how maxpool authenticates to GCP');
  assert.match(text, /stops working everywhere/, 'the revocation property');
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

// ── the merge: one screen manages every account type ─────────────────────────

const merged = () => {
  const m = new AccountManager([
    { name: 'cc', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  m.loadConfigProviders([{ name: 'glm cfg', provider: 'zai', token: 'k-cfg' }]);
  // A SESSION row: created from cc-all headers, NOT in config.
  m.upsertRuntimeAccount({
    name: 'glm session', type: 'provider', provider: 'zai', authToken: 'k-sess',
    upstream: 'https://api.z.ai/api/anthropic',
  });
  return m;
};
const cfgFor = _m => ({
  accounts: [{ name: 'cc' }],
  providers: [{ name: 'glm cfg', provider: 'zai', secretName: 'SOME_SECRET' }],
  routing: {},
});

test('MERGE: a CONFIG provider is now deletable and renameable (was stranded)', () => {
  // _configAccountIndex only searched config.accounts, so a config provider reported
  // -1 and was excluded from rename/delete. With the Providers screen deleted that
  // would have stranded it in config forever.
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  const glmCfg = m.accounts.find(a => a.name === 'glm cfg');
  assert.ok(tui._isConfigBacked(glmCfg), 'a config provider IS config-backed');
  assert.deepEqual(tui._configLocation(glmCfg), { array: 'providers', index: 0 });
  const deletable = tui._selectableIndexes('delete').map(i => m.accounts[i].name);
  assert.ok(deletable.includes('glm cfg'), 'config provider is deletable from Accounts');
  const renameable = tui._selectableIndexes('rename').map(i => m.accounts[i].name);
  assert.ok(renameable.includes('glm cfg'), 'and renameable');
});

test('MERGE: a SESSION row is NOT renameable (rename would fork it into a duplicate)', () => {
  // upsertRuntimeAccount matches by NAME. Rename the row and the next cc-all request
  // recreates the original — one key, two accounts, double-counted quota.
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  const sess = m.accounts.find(a => a.name === 'glm session');
  assert.equal(tui._isConfigBacked(sess), false, 'a session row has no config entry');
  const renameable = tui._selectableIndexes('rename').map(i => m.accounts[i].name);
  assert.ok(!renameable.includes('glm session'), 'session rows are not renameable');
  const deletable = tui._selectableIndexes('delete').map(i => m.accounts[i].name);
  assert.ok(!deletable.includes('glm session'), 'nor deletable — it returns next request');
});

test('MERGE: EVERY row can be enabled/disabled — including a session row', () => {
  // Disable IS the durable action on a session row: exportRuntimeProviders persists
  // `enabled`, and the header path never re-enables a benched row.
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  const toggleable = tui._selectableIndexes('toggle').map(i => m.accounts[i].name);
  assert.deepEqual(toggleable.sort(), ['cc', 'glm cfg', 'glm session'].sort(),
    'on/off works on every account type');
});

test('MERGE: the providers screen is gone — one place to manage accounts', () => {
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  assert.equal(typeof tui._keyProviders, 'undefined', 'no providers key handler');
  assert.equal(typeof tui._renderProviders, 'undefined', 'no providers panel');
  assert.equal(typeof tui._startProviderSelection, 'undefined', 'no parallel selection path');
  // And `p` no longer opens anything.
  tui.mode = 'normal';
  tui._keyNormal('p');
  assert.equal(tui.mode, 'normal', 'p is a free key again');
});

test('MERGE: the GLM/Kimi add prompt does not say "undefined"', () => {
  // The name step runs LAST (so it can be derived from the secret), so prev.name was
  // always undefined at the credential step and the prompt read "undefined: ...".
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  tui._providerAddStep('secret', { provider: 'zai' });
  assert.doesNotMatch(tui.inputPrompt, /undefined/, 'no undefined in the prompt');
  assert.match(tui.inputPrompt, /GLM/, 'names the vendor instead');
  tui._providerAddStep('secret', { provider: 'kimi' });
  assert.match(tui.inputPrompt, /Kimi/);
});

test('MERGE: adding a GLM account leaves you on Accounts, not a dead mode', () => {
  // Nine sites set mode='providers'. With the screen deleted, _key() has no case for
  // it and EVERY keystroke would be silently dropped — a lockup with only ctrl-c out.
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  tui.mode = 'addtype';
  tui._keyAddType('3');          // GLM
  tui.inputBuf = '';
  tui._keyInput('enter');        // empty → cancel
  assert.equal(tui.mode, 'accounts', 'cancelling returns to a LIVE screen');
});

test('MERGE: no code path can strand the user on the deleted providers mode', () => {
  // Nine sites used to set mode='providers'. _key() has no case for it now, so ANY
  // survivor is a silent lockup — every keystroke dropped, only ctrl-c out. A
  // per-path behavioural test only covers the one path it walks; this covers all of
  // them at once.
  const src = readFileSync(new URL('../src/tui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /this\.mode = 'providers'/,
    "no site may set mode='providers' — the screen no longer exists");
  // And the dispatcher genuinely has no case for it.
  assert.doesNotMatch(src, /case 'providers':/,
    'the key dispatcher must not reference the deleted mode');
});

test('MERGE: cancelling the ANTHROPIC-key add also lands on a live screen', () => {
  // The provider path is covered above; this is the sibling path, which mutation
  // testing showed was NOT exercised by it.
  const m = merged();
  const tui = new TUI({ accountManager: m, config: cfgFor(m) });
  tui.mode = 'addtype';
  tui._keyAddType('2');            // Anthropic API key
  assert.equal(tui.mode, 'input');
  tui.inputBuf = '';
  tui._keyInput('enter');          // empty → cancel
  assert.equal(tui.mode, 'accounts', 'cancelling returns to a LIVE screen');
});
