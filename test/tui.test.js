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
  assert.match(footer, /m Routing/);
  assert.match(footer, /s Sync/);
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
  assert.match(tui.confirmDetail, /drain active work/i);
  assert.equal(stopped, false);
  assert.equal(restarted, false);

  tui._keyConfirm('y');
  assert.equal(stopped, true);
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

test('unsupported runtime providers are excluded from account action selection', () => {
  const accounts = [
    { name: 'runtime-provider', type: 'provider', runtime: true, enabled: true },
    { name: 'claude', type: 'oauth', enabled: true },
  ];
  const tui = new TUI({
    accountManager: accountManager(accounts),
    config: { accounts: [{ name: 'claude', type: 'oauth' }] },
  });

  assert.deepEqual(tui._selectableIndexes('prefer'), [1]);
  assert.deepEqual(tui._selectableIndexes('delete'), [1]);
  assert.deepEqual(tui._selectableIndexes('toggle'), [1]);
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
