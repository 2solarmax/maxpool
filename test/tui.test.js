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

function accountManager(accounts = []) {
  return {
    accounts,
    currentIndex: 0,
    routingMode: 'automatic',
    preferredAccountName: null,
    setRoutingMode(mode, name = null) {
      this.routingMode = mode === 'preferred' ? 'preferred' : 'automatic';
      this.preferredAccountName = mode === 'preferred' ? name : null;
    },
    setAccountEnabled(index, enabled) {
      this.accounts[index].enabled = enabled;
    },
    removeAccount(index) {
      this.accounts.splice(index, 1);
      return true;
    },
  };
}

test('normal footer uses mnemonic top-level actions', () => {
  const tui = new TUI({ accountManager: accountManager() });

  const footer = __tuiTest.strip(tui._renderFooter());
  assert.match(footer, /a Accounts/);
  // On/off consolidated into [a] Accounts — no longer a top-level footer action.
  assert.doesNotMatch(footer, /On\/off/);
  assert.match(footer, /m Routing/);
  // `s Sync` removed 2026-08-10: syncAccountsFromDisk already runs every 15s and logs
  // what it picked up, so a manual key for it was a button for something automatic.
  assert.doesNotMatch(footer, /s Sync/);
  // `p Providers` removed in the same change — providers are accounts, managed under [a].
  assert.doesNotMatch(footer, /p Providers/);
  assert.match(footer, /h Hide disabled/);
  assert.match(footer, /r Restart/);
  assert.match(footer, /q Stop/);
  assert.doesNotMatch(footer, /switch/i);
});

test('restart requires confirmation and explains drain behavior', () => {
  let stopped = false;
  let restarted = false;
  const tui = new TUI({
    accountManager: accountManager(),
    onRestart: () => { restarted = true; },
  });
  tui.stop = () => { stopped = true; };

  tui._keyNormal('r');
  assert.equal(tui.mode, 'confirm');
  // The detail is now DERIVED from what is actually in flight (2026-08-10): with an
  // idle pool the restart really is instant, and saying "drain active work" there was
  // the copy that made the user expect a wait and read the instant restart as "nothing
  // happened". The in-flight wording is covered in restart-ux-and-adoption.test.js.
  assert.match(tui.confirmDetail, /restarts immediately/i);
  assert.match(tui.confirmDetail, /reconnect/i);
  assert.equal(stopped, false);
  assert.equal(restarted, false);

  tui._keyConfirm('y');
  // The keypress must NOT stop the TUI itself — the reload path owns the stop (cold:
  // restartWorkerNow, seamless: releaseBatonAndDrain). If it stopped here and the
  // reload rolled back, the TUI would be stranded in plain-log mode. Only onRestart fires.
  assert.equal(stopped, false, 'r must not stop the TUI directly (reload path owns it, so a rollback keeps the TUI)');
  assert.equal(restarted, true);
});

test('confirmation can cancel a state-changing action', () => {
  let synced = false;
  const tui = new TUI({
    accountManager: accountManager(),
    syncAccounts: async () => { synced = true; return 0; },
  });

  tui._keyNormal('s');
  tui._keyConfirm('n');

  assert.equal(tui.mode, 'normal');
  assert.equal(synced, false);
});

test('routing menu persists preferred account with automatic failover wording', async () => {
  const accounts = [
    { name: 'personal', type: 'oauth', status: 'active', enabled: true },
    { name: 'work', type: 'oauth', status: 'active', enabled: true },
  ];
  const am = accountManager(accounts);
  const config = { accounts: accounts.map(account => ({ ...account })) };
  let saved = false;
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => { saved = true; },
  });

  tui._keyNormal('m');
  tui._keyRouting('p');
  tui.selIdx = 1;
  tui._keySelect('enter');
  assert.match(tui.confirmDetail, /fail over and return automatically/i);
  tui._keyConfirm('y');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(am.routingMode, 'preferred');
  assert.equal(am.preferredAccountName, 'work');
  assert.deepEqual(config.routing, { mode: 'preferred', preferredAccount: 'work' });
  assert.equal(saved, true);
});

test('delete refuses an account with active requests', async () => {
  const accounts = [{ name: 'personal', type: 'oauth', status: 'active', enabled: true, inFlight: 1 }];
  const am = accountManager(accounts);
  const config = { accounts: [{ name: 'personal', type: 'oauth' }] };
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => {},
  });

  await tui._doDelete(0);

  assert.equal(am.accounts.length, 1);
  assert.equal(config.accounts.length, 1);
  assert.match(tui.log[0].msg, /Cannot delete/);
});

test('account disable is confirmed and persisted without deleting credentials', async () => {
  const accounts = [{ name: 'personal', type: 'oauth', status: 'active', enabled: true, inFlight: 0 }];
  const am = accountManager(accounts);
  const config = {
    accounts: [{ name: 'personal', type: 'oauth', accessToken: 'secret' }],
    routing: { mode: 'automatic', preferredAccount: null },
  };
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => {},
  });

  tui._keyNormal('a');
  tui._keyAccounts('t');
  tui._keySelect('enter');
  assert.match(tui.confirmDetail, /Stop assigning new requests/i);
  tui._keyConfirm('y');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(am.accounts[0].enabled, false);
  assert.equal(config.accounts[0].enabled, false);
  assert.equal(config.accounts[0].accessToken, 'secret');
});

test('enable/disable is consolidated under [a] Accounts (top-level "t" is inert)', async () => {
  const accounts = [{ name: 'personal', type: 'oauth', status: 'active', enabled: true, inFlight: 0 }];
  const am = accountManager(accounts);
  const config = {
    accounts: [{ name: 'personal', type: 'oauth', accessToken: 'secret' }],
    routing: { mode: 'automatic', preferredAccount: null },
  };
  const tui = new TUI({ accountManager: am, config, saveConfig: async () => {} });

  // Top-level "t" no longer toggles — enable/disable was consolidated into the
  // Accounts submenu (and dropped from the normal footer, so no dead key is advertised).
  tui._keyNormal('t');
  assert.equal(tui.mode, 'normal', 'top-level "t" is inert after consolidation');

  // The toggle still works end-to-end via [a] Accounts → [t].
  tui._keyNormal('a');
  assert.equal(tui.mode, 'accounts', '"a" opens Accounts');
  tui._keyAccounts('t');
  assert.equal(tui.mode, 'select', 'Accounts "t" opens the account picker');
  assert.equal(tui.selAction, 'toggle');

  tui._keySelect('enter');
  assert.match(tui.confirmDetail, /Stop assigning new requests/i);
  tui._keyConfirm('y');
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(am.accounts[0].enabled, false);
  assert.equal(config.accounts[0].enabled, false);
});

test('API key input is masked', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.mode = 'input';
  tui.inputPrompt = 'Anthropic API key';
  tui.inputBuf = 'secret';
  tui.inputSensitive = true;

  const footer = __tuiTest.strip(tui._renderFooter());
  assert.doesNotMatch(footer, /secret/);
});

test('pasted API key is accepted as a multi-character input chunk', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.mode = 'input';
  tui.inputSensitive = true;
  tui.inputBuf = '';
  tui.render = () => {};

  tui._onData('sk-ant-pasted-key');

  assert.equal(tui.inputBuf, 'sk-ant-pasted-key');
});

test('paste with a trailing newline appends the clean key and submits', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.render = () => {};
  let submitted = null;
  tui.mode = 'input';
  tui.inputBuf = '';
  tui.inputCb = v => { submitted = v; };

  tui._onData('sk-ant-pasted-key\n');

  assert.equal(submitted, 'sk-ant-pasted-key');
  assert.equal(tui.mode, 'normal');
  assert.equal(tui.inputBuf, '');
});

test('paste wrapped in bracketed-paste markers with CRLF is accepted and submitted', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.render = () => {};
  let submitted = null;
  tui.mode = 'input';
  tui.inputBuf = '';
  tui.inputCb = v => { submitted = v; };

  tui._onData('\x1b[200~sk-ant-bracketed\x1b[201~\r\n');

  assert.equal(submitted, 'sk-ant-bracketed');
  assert.equal(tui.mode, 'normal');
});

test('paste with an embedded control char keeps the printable characters', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.render = () => {};
  tui.mode = 'input';
  tui.inputBuf = '';

  tui._onData('sk-ant\tkey'); // embedded tab, no newline -> not submitted

  assert.equal(tui.inputBuf, 'sk-antkey');
  assert.equal(tui.mode, 'input');
});

test('bracketed-paste marker split across two chunks is not corrupted', () => {
  const tui = new TUI({ accountManager: accountManager(), config: { accounts: [] } });
  tui.render = () => {};
  let submitted = null;
  tui.mode = 'input';
  tui.inputBuf = '';
  tui.inputCb = v => { submitted = v; };

  tui._onData('\x1b[20');               // partial start marker
  tui._onData('0~sk-ant-split\x1b[201~\n'); // rest + end marker + newline

  assert.equal(submitted, 'sk-ant-split');
  assert.equal(tui.mode, 'normal');
});

test('failed API key persistence does not leave a routable phantom account', async () => {
  const am = accountManager();
  am.addAccount = account => am.accounts.push(account);
  const config = { accounts: [] };
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => { throw new Error('disk full'); },
  });

  await assert.rejects(() => tui._doAddKey('secret'), /disk full/);

  assert.equal(config.accounts.length, 0);
  assert.equal(am.accounts.length, 0);
});

test('runtime providers are excluded from prefer/delete, but INCLUDED for enable/disable (W-D)', () => {
  const accounts = [
    { name: 'runtime-provider', type: 'provider', runtime: true, enabled: true },
    { name: 'claude', type: 'oauth', enabled: true },
  ];
  const tui = new TUI({
    accountManager: accountManager(accounts),
    config: { accounts: [{ name: 'claude', type: 'oauth' }] },
  });

  // prefer + delete stay config-account-only (provider at idx 0 excluded).
  assert.deepEqual(tui._selectableIndexes('prefer'), [1]);
  assert.deepEqual(tui._selectableIndexes('delete'), [1]);
  // toggle now includes the runtime provider so GLM/Kimi can be enabled/disabled
  // (display order lists the non-provider account first).
  assert.deepEqual(tui._selectableIndexes('toggle'), [1, 0]);
});

test('delete removes account from routing before awaiting persistence', async () => {
  let finishSave;
  const saveStarted = new Promise(resolve => { finishSave = resolve; });
  let releaseSave;
  const saveBlocked = new Promise(resolve => { releaseSave = resolve; });
  const accounts = [{ name: 'personal', type: 'oauth', enabled: true, inFlight: 0 }];
  const am = accountManager(accounts);
  const config = { accounts: [{ name: 'personal', type: 'oauth' }] };
  const tui = new TUI({
    accountManager: am,
    config,
    saveConfig: async () => {
      finishSave();
      await saveBlocked;
    },
  });

  const deleting = tui._doDelete(0);
  await saveStarted;
  assert.equal(am.accounts[0].enabled, false);

  releaseSave();
  await deleting;
  assert.equal(am.accounts.length, 0);
});

test('TUI start returns false instead of throwing when raw mode fails', () => {
  const originalSetRawMode = process.stdin.setRawMode;
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stdin.setRawMode = () => {
    const err = new Error('setRawMode EIO');
    err.code = 'EIO';
    throw err;
  };
  process.stderr.write = chunk => {
    stderr += String(chunk);
    return true;
  };

  try {
    const tui = new TUI({ accountManager: accountManager() });

    assert.equal(tui.start(), false);
    assert.equal(tui.running, false);
    assert.match(stderr, /TUI unavailable \(EIO\)/);
  } finally {
    process.stdin.setRawMode = originalSetRawMode;
    process.stderr.write = originalWrite;
  }
});

// ── #5 TUI clarity: throttled countdown + clearer "Now" load label ──

test('countdown shows seconds under a minute, coarser above, empty once elapsed', () => {
  assert.equal(__tuiTest.countdown(Date.now() + 41_000), '41s');
  assert.match(__tuiTest.countdown(Date.now() + 5 * 60_000), /^5m$/);
  assert.equal(__tuiTest.countdown(Date.now() - 1000), '');
  assert.equal(__tuiTest.countdown(null), '');
  // Accepts an ISO string (the shape getStatus exposes rateLimitedUntil in).
  assert.equal(__tuiTest.countdown(new Date(Date.now() + 30_000).toISOString()), '30s');
});

// ACTIVITY cell (2026-08-27, owner feedback): an idle account renders NOTHING —
// "Now 0  15m 0r  1h 0r" on every resting row was a column of noise. A working
// account renders "▶N · req/h · avg", failures appended.
test('activity cell reads "▶N · R/h · avg" for a working account', () => {
  const text = __tuiTest.strip(__tuiTest.loadText({
    current: { inFlight: 2, activeWeight: 26 },
    last15m: { requests: 41, avgMs: 8500 },
    last1h: { requests: 53 },
  }));
  assert.match(text, /▶2 · 53\/h · 8.5s/);
  assert.doesNotMatch(text, /Now /);   // the noisy vocabulary is gone
  assert.doesNotMatch(text, /15m /);
});

test('activity cell renders empty on a fully idle account — no zero-noise', () => {
  const text = __tuiTest.strip(__tuiTest.loadText({
    current: { inFlight: 0, activeWeight: 0 },
    last15m: {}, last1h: {},
  }));
  assert.equal(text, '');
});

test('activity cell keeps no-inflight but recent-hour work, and failures', () => {
  const idleNow = __tuiTest.strip(__tuiTest.loadText({
    current: {}, last15m: { requests: 5, avgMs: 4000 }, last1h: { requests: 17 },
  }));
  assert.match(idleNow, /17\/h · 4.0s/);
  assert.doesNotMatch(idleNow, /▶/);
  const failing = __tuiTest.strip(__tuiTest.loadText({
    current: {}, last15m: { requests: 9, failed: 2 }, last1h: { requests: 30 },
  }));
  assert.match(failing, /2f/);
});

test('countdown stays single-unit <=3 chars even for multi-hour throttles (no column overflow)', () => {
  // A 429 retry-after can be hours (clampRetryAfterSeconds allows up to 24h); the
  // status countdown must NOT become "2h30m" and shift the quota bars.
  for (const ms of [90 * 60_000, 150 * 60_000, 23 * 3_600_000, 30 * 3_600_000]) {
    const cd = __tuiTest.countdown(Date.now() + ms);
    assert.ok(cd.length <= 3, `"${cd}" must be <=3 chars to fit "throttled ${cd}" in the column`);
    assert.match(cd, /^\d+[smhd]$/);
  }
});
