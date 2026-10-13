// The usage-cap INPUT PROMPT (owner 2026-10-13: "I'm not sure how does this work.
// I want to keep the dynamic floor, but I also want to raise the basic cap. …I
// want to be able to do this through terminal UI"). The prompt must say, in plain
// words, what a bare number does (dynamic: hold at NN%, then open up near reset),
// what fNN does, how to remove, and the current setting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI } from '../src/tui.js';

const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 36e5, ...extra });

function tuiWith(acctDefs) {
  const accounts = acctDefs.map(a => a);
  const manager = new AccountManager(accounts, 0.95);
  const config = { accounts: acctDefs.map(a => ({ name: a.name })), providers: [] };
  return new TUI({ accountManager: manager, config, saveConfig: async () => {} });
}

function openCapPrompt(tui, idx) {
  tui.mode = 'select';
  tui.selAction = 'cap';
  tui.selIdx = idx;
  tui._keySelect('enter');
  return tui.inputPrompt;
}

test('C1: the prompt explains the dynamic cap in plain words and names the current setting', () => {
  const tui = tuiWith([oauth('kira', { capUtilization: 0.75, capMode: 'dynamic' })]);
  const p = openCapPrompt(tui, 0);
  assert.ok(p.includes('now 75% dynamic'), `names the current cap+mode (got: ${p})`);
  assert.match(p, /75=use to 75%\+rises near reset/, 'a number = USE up to it, then rises near reset');
  assert.match(p, /f75=hard/, 'names the fixed option');
  assert.match(p, /0=off/, 'says how to remove');
  assert.doesNotMatch(p, /dynamic floor|stays free|refills/, 'no jargon, no inverted or wrong wording');
});

test('C3: prompt + typed value fit an 80-column terminal, and the value is never cut', () => {
  const tui = tuiWith([oauth('kira', { capUtilization: 0.75, capMode: 'dynamic' })]);
  openCapPrompt(tui, 0);
  tui.inputBuf = '85';
  const strip = x => x.replace(/\x1b\[[0-9;]*m/g, '');
  const cols = process.stdout.columns;
  try {
    for (const w of [80, 60, 40]) {
      process.stdout.columns = w;
      const line = strip(tui._renderFooter());
      assert.ok(line.length <= w, `fits ${w} cols (got ${line.length})`);
      assert.ok(line.endsWith('85█'), `the typed value + cursor survive at ${w} cols: ${JSON.stringify(line)}`);
    }
  } finally { process.stdout.columns = cols; }
});

test('C2: typing 75 through the prompt sets kira to 75% dynamic', async () => {
  const tui = tuiWith([oauth('kira', { capUtilization: 0.5, capMode: 'dynamic' })]);
  openCapPrompt(tui, 0);
  tui.inputBuf = '75';
  await new Promise(resolve => {
    const cb = tui.inputCb;
    tui.inputCb = v => { Promise.resolve(cb(v)).then(resolve).catch(resolve); };
    tui._keyInput('enter');
  });
  assert.equal(tui.am.accounts[0].capUtilization, 0.75);
  assert.equal(tui.am.accounts[0].capMode, 'dynamic', 'the rising behaviour is kept');
  assert.equal(tui.config.accounts[0].capUtilization, 0.75);
  assert.equal(tui.config.accounts[0].capMode, 'dynamic');
});
