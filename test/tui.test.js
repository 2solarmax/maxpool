import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';

test('quota bar label includes usage and reset countdown when it fits', () => {
  const reset = Date.now() + 2 * 60 * 60 * 1000;
  const text = __tuiTest.strip(__tuiTest.bar(0.54, 20, reset));

  assert.match(text, /54%/);
  assert.match(text, /2h/);
});

test('quota label falls back to reset when usage plus reset is too wide', () => {
  const reset = Date.now() + 3 * 24 * 60 * 60 * 1000;

  assert.match(__tuiTest.quotaLabel(0.94, reset, 5), /^3d/);
});

test('normal footer exposes native restart action', () => {
  const tui = new TUI({ accountManager: { accounts: [] } });

  assert.match(__tuiTest.strip(tui._renderFooter()), /xrestart/);
});

test('restart key stops TUI and invokes restart callback', () => {
  let stopped = false;
  let restarted = false;
  const tui = new TUI({
    accountManager: { accounts: [] },
    onRestart: () => { restarted = true; },
  });
  tui.stop = () => { stopped = true; };

  tui._keyNormal('x');

  assert.equal(stopped, true);
  assert.equal(restarted, true);
});
