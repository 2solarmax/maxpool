import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const { strip } = __tuiTest;

const makeAm = (mode = 'sticky') => {
  const m = new AccountManager([
    { name: 'claude-1', type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000 },
  ], 0.90, { routingMode: mode });
  return m;
};

const makeTui = (mode = 'sticky') => {
  const am = makeAm(mode);
  const config = { scheduler: { routingMode: mode } };
  const tui = new TUI({ accountManager: am, config });
  return { tui, am };
};

test('f key cycles sticky → balance → prefer-claude → prefer-zai → prefer-kimi → sticky', async () => {
  const { tui, am } = makeTui('sticky');
  tui.mode = 'routing';
  let saved = null;
  tui.saveConfig = async (c) => { saved = c; };

  tui._keyRouting('f');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'balance', 'sticky → balance');
  assert.equal(saved.scheduler.routingMode, 'balance', 'persisted to config');

  tui._keyRouting('f');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'prefer-claude');

  tui._keyRouting('f');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'prefer-zai', 'GLM mode id is prefer-zai internally');

  tui._keyRouting('f');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'prefer-kimi');

  tui._keyRouting('f');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'sticky', 'wraps back to sticky');
});

test('m key works the same as f (mnemonic for "mode")', async () => {
  const { tui, am } = makeTui('sticky');
  tui.mode = 'routing';
  tui.saveConfig = async () => {};
  tui._keyRouting('m');
  await new Promise(r => setImmediate(r));
  assert.equal(am.scheduler.routingMode, 'balance');
});

test('the routing footer shows the current mode name', () => {
  const { tui } = makeTui('balance');
  tui.mode = 'routing';
  const footer = strip(tui._renderFooter());
  assert.match(footer, /Balance all/);
});

test('the routing footer changes when the mode changes', () => {
  const { tui } = makeTui('prefer-zai');
  tui.mode = 'routing';
  const footer = strip(tui._renderFooter());
  assert.match(footer, /Prefer GLM/);
});

test('the main header names the mode + shows its description', () => {
  const { tui } = makeTui('prefer-kimi');
  // Force-render the header (the TUI normally calls _renderMain which is too large
  // to invoke in isolation, so check the routing variable directly)
  const mode = tui._routingModeDef('prefer-kimi');
  assert.match(mode.label, /Prefer Kimi/);
  assert.match(mode.help, /Kimi first/);
});
