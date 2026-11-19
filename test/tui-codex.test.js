import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { acctHeader, barLayout, codexLoginArgs, fitLine, strip } = __tuiTest;
const codex = (name, extra = {}) => ({
  name, type: 'oauth', provider: 'codex', accessToken: 'fixture', ...extra,
});
const claude = { name: 'Claude', type: 'oauth', accessToken: 'fixture' };

function makeTui(options = {}) {
  const accountManager = new AccountManager([claude, codex('OpenAI laptop')], 0.9);
  const tui = new TUI({
    accountManager, config: { proxy: { port: 3456 } }, ...options,
  });
  tui.forceRender = () => {};
  return tui;
}

test('reconnect takes the selected Codex account and retains its original placement', async () => {
  const tui = makeTui();
  const local = tui.am.accounts[1];
  const cloud = codex('OpenAI laptop @cloud', {
    remote: { linkName: 'team', remoteName: local.name },
  });
  tui.am.accounts.push(cloud);
  const selected = [];
  tui._doChatGPTLogin = account => selected.push(account);
  tui.mode = 'accounts';

  tui._key('c');
  assert.equal(tui.selIdx, 1, 'Claude is excluded from the Codex picker');
  tui._key('down');
  tui._key('enter');
  assert.equal(tui.mode, 'confirm');
  tui._key('y');
  assert.deepEqual(selected, [cloud]);
  assert.equal(tui.mode, 'accounts');
  assert.deepEqual(codexLoginArgs('cli', cloud.remote.remoteName, cloud),
    ['cli', 'login', '--codex', '--name', local.name, '--cloud', '--pool', 'team']);
  assert.deepEqual(codexLoginArgs('cli', local.name, local),
    ['cli', 'login', '--codex', '--name', local.name, '--local']);
  assert.deepEqual(codexLoginArgs('cli', '', undefined), ['cli', 'login', '--codex']);
});

test('Codex account rows show native quota and distinguish unknown and banked resets', () => {
  const tui = makeTui();
  const account = tui.am.accounts[1];
  const { bw, showBoth, showFable, showSession } = barLayout(80, true);
  const col = strip(acctHeader(80)).indexOf('ARst');
  const wideRow = strip(tui._renderAcct(1, 9, true, true, true, 160));
  assert.doesNotMatch(wideRow, /Fbl|Fable/i);
  assert.match(wideRow, /Wk/);
  const row = () => strip(tui._renderAcct(1, bw, showBoth, showFable, showSession));
  assert.equal(row().slice(col, col + 1), '-');
  assert.doesNotMatch(row(), /Tok |Req /, 'native subscriptions do not show API-key quota labels');

  // Anthropic throttling cannot pause the independent Codex provider.
  tui.am._isUpstreamThrottleBlocking = () => true;
  account.quota.unified7d = 0.45;
  account.quota.codexResetCredits = { available: 3, applicable: 0, checkedAt: Date.now() };
  assert.equal(row().slice(col, col + 1), '0');
  assert.match(row(), /Codex\s+active.*Wk\s+45%/);
  const screenRow = strip(fitLine(tui._renderAcct(1, bw, showBoth, showFable, showSession, 80), 80));
  assert.equal(screenRow.length, 80);
  assert.match(screenRow, /Wk45%$/);
  account.quota.codexResetCredits.checkedAt -= 60 * 60 * 1000;
  assert.equal(row().slice(col, col + 2), '0?');
  account.quota.codexResetCredits.applicable = null;
  assert.equal(row().slice(col, col + 1), '-');
});

test('free reset inventory requires confirmation and refreshes after manual redemption', async () => {
  const calls = [];
  const tui = makeTui({
    config: { proxy: { port: 3456 }, codexAutoRedeemResets: true },
    async codexResetDetails(name) {
      calls.push(['read', name]);
      return { credits: [
        { id: 'spent', title: 'Spent reset', status: 'redeemed' },
        { id: 'expired', title: 'Expired reset', status: 'available', expiresAt: Date.now() - 1000 },
        { id: 'available', title: 'One free reset', status: 'available', expiresAt: Date.now() + 60_000 },
      ] };
    },
    async redeemCodexReset(name, id) {
      calls.push(['redeem', name, id]);
      return { redeemed: true };
    },
    async onSetCodexAutoRedeem(name, enabled) { calls.push(['auto', name, enabled]); },
  });
  const account = tui.am.accounts[1];
  account.codexResetCredits = { available: 3, applicable: 1 };
  await tui._showCodexResets(account);
  assert.match(tui._renderCodexResets(10).map(strip).join('\n'), /3 banked · 1 redeemable now/);
  assert.ok(strip(tui._renderFooter()).length <= 80);
  assert.match(strip(tui._renderFooter()), /Auto: off/);

  assert.doesNotMatch(tui._renderCodexResets(10).map(strip).join(' '), /Expired reset|Spent reset/);
  account.codexResetCredits.applicable = 0;
  assert.doesNotMatch(strip(tui._renderFooter()), /Redeem/);
  tui._key('enter');
  assert.equal(tui.mode, 'codexResets');
  account.codexResetCredits.applicable = 1;
  tui._key('enter');
  assert.equal(tui.mode, 'confirm');
  tui._key('n');
  assert.equal(tui.mode, 'codexResets');
  assert.deepEqual(calls, [['read', account.name]]);
  tui._key('enter');
  tui._key('y');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [
    ['read', account.name], ['redeem', account.name, 'available'], ['read', account.name],
  ]);
  assert.match(tui.codexResets.notice, /redeemed/);

  tui._key('a');
  assert.equal(tui.mode, 'confirm');
  tui._key('y');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(account.autoRedeemReset, true);
  assert.deepEqual(calls.at(-1), ['auto', account.name, true]);
  assert.match(strip(tui._renderFooter()), /Auto: on/);
  await tui._showCodexResets(codex('Separate account', { quota: {} }));
  assert.match(strip(tui._renderFooter()), /Auto: off/);
  tui._key('esc');
  assert.equal(tui.mode, 'accounts');
});

test('capacity headline reports Codex separately and includes its traffic in shared counts', () => {
  const tui = makeTui();
  const empty = { served: 0, bounced: 0, hit: null, lowVolume: true, movedByCause: {} };
  tui.am.efficiencyOverall = () => ({
    claude: empty,
    glm: empty,
    codex: { served: 5, bounced: 0, hit: 0.8, missTokens: 4_000, lowVolume: false,
      movedSame: 2, movedByCause: { busy: 2 } },
  });
  const cacheLine = strip(tui._efficiencyLine(130));
  assert.match(cacheLine, /Codex 80%.*Codex miss 4k tok.*same 2.*busy 2/);
  assert.doesNotMatch(cacheLine, /GLM|Claude/);
  assert.ok(strip(tui._efficiencyLine(80)).length <= 80);
});

test('Codex routing toggle persists the live config before applying it', async () => {
  const saved = [];
  const config = { proxy: { port: 3456 }, scheduler: { providers: { zai: { claudeFallback: 'always' } } } };
  const tui = makeTui({
    config,
    async saveConfig() { saved.push(config.scheduler.providers.codex.sessionRouting); },
  });
  assert.equal(tui.am._sessionRoutingFor('codex'), 'same-provider');
  await tui._toggleChatGPTSessionRouting();
  assert.deepEqual(saved, ['cross-provider']);
  assert.equal(tui.am._sessionRoutingFor('codex'), 'cross-provider');
  assert.equal(config.scheduler.providers.zai.claudeFallback, 'always');
  tui.saveConfig = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(tui._toggleChatGPTSessionRouting(), /disk unavailable/);
  assert.equal(config.scheduler.providers.codex.sessionRouting, 'cross-provider');
  assert.equal(tui.am._sessionRoutingFor('codex'), 'cross-provider');
});
