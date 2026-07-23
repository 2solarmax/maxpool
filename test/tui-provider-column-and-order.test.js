import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const { providerLabel, acctHeader, strip } = __tuiTest;

// A pool with OAuth accounts INTERLEAVED with providers in the canonical array, to
// prove the DISPLAY order (Claude first, providers last) is decoupled from the array.
function mixedManager() {
  const am = new AccountManager([
    { name: 'oauthA', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
  ], 0.90);
  am.addAccount({ name: 'glm', type: 'provider', provider: 'zai', apiKey: 'zk' });        // idx 1
  am.addAccount({ name: 'oauthB', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 }); // idx 2
  am.addAccount({ name: 'kimi', type: 'provider', provider: 'kimi', apiKey: 'kk' });       // idx 3
  return am;
}

// ── W2: Claude/OAuth accounts render BEFORE providers ────────────────────────────

test('W2 _displayOrder lists non-provider accounts first, providers last, stable within each group', () => {
  const am = mixedManager();
  const tui = new TUI({ accountManager: am });
  // canonical array: [oauthA, glm, oauthB, kimi] → display: [oauthA, oauthB, glm, kimi]
  assert.deepEqual(tui._displayOrder(), [0, 2, 1, 3]);
});

test('W2 the canonical am.accounts order is NOT mutated (routing/index actions unaffected)', () => {
  const am = mixedManager();
  const tui = new TUI({ accountManager: am });
  tui._displayOrder();
  assert.deepEqual(am.accounts.map(a => a.name), ['oauthA', 'glm', 'oauthB', 'kimi'],
    'display order is a view; the underlying array stays in its canonical (index-stable) order');
});

test('W2 _selectableIndexes is in DISPLAY order with the selectability filter intact', () => {
  const am = mixedManager();
  const tui = new TUI({ accountManager: am });
  // 'prefer' excludes providers → only the two OAuth accounts, in display order.
  assert.deepEqual(tui._selectableIndexes('prefer'), [0, 2],
    'prefer nav visits OAuth accounts in display order and never a provider');
});

// ── W3: the "Provider" column shows the real vendor ──────────────────────────────

test('W3 providerLabel maps account.provider to the real vendor name', () => {
  assert.equal(providerLabel({ provider: 'anthropic', type: 'oauth' }), 'Anthropic');
  assert.equal(providerLabel({ provider: 'anthropic', type: 'apikey' }), 'Anthropic');
  assert.equal(providerLabel({ provider: 'zai', type: 'provider' }), 'z.ai');
  assert.equal(providerLabel({ provider: 'kimi', type: 'provider' }), 'Moonshot');
});

test('W3 providerLabel: oauth/apikey with no explicit provider is still Anthropic', () => {
  assert.equal(providerLabel({ type: 'oauth' }), 'Anthropic');
  assert.equal(providerLabel({ type: 'apikey' }), 'Anthropic');
});

test('W3 providerLabel: future providers render via a graceful Titlecase default', () => {
  assert.equal(providerLabel({ provider: 'grok', type: 'provider' }), 'Grok');
  assert.equal(providerLabel({ provider: 'codex', type: 'provider' }), 'Codex');
  // a config provider with no explicit vendor resolves to 'provider' → 'Provider', never a raw leak
  assert.equal(providerLabel({ provider: 'provider', type: 'provider' }), 'Provider');
});

test('W3 providerLabel truncates to the column width so a long name can never misalign the row', () => {
  const label = providerLabel({ provider: 'somereallylongvendorname', type: 'provider' });
  assert.ok(label.length <= 9, `label must fit PROVIDER_W (got "${label}", ${label.length})`);
});

test('W3 the column header names "Provider", not "Type"', () => {
  const hdr = strip(acctHeader(100));
  assert.ok(hdr.includes('Provider'), 'header labels the column "Provider"');
  assert.ok(!/\bType\b/.test(hdr), 'the confusing "Type" label is gone');
});

test('W3 a provider row renders its real vendor (z.ai / Moonshot), an OAuth row renders Anthropic', () => {
  const am = mixedManager();
  const tui = new TUI({ accountManager: am });
  assert.ok(strip(tui._renderAcct(0, 11, true)).includes('Anthropic'), 'oauth row shows Anthropic');
  assert.ok(strip(tui._renderAcct(1, 11, true)).includes('z.ai'), 'glm row shows z.ai');
  assert.ok(strip(tui._renderAcct(3, 11, true)).includes('Moonshot'), 'kimi row shows Moonshot');
});
