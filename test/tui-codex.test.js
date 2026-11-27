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
  const col = strip(acctHeader(160)).indexOf('ARst');
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
  assert.equal(row().slice(col, col + 1), '3');
  assert.match(row(), /Codex\s+active.*Wk\s+45%/);
  const screenRow = strip(fitLine(tui._renderAcct(1, bw, showBoth, showFable, showSession, 80), 80));
  assert.equal(screenRow.length, 80);
  assert.match(screenRow, /Wk45%$/);
  account.quota.codexResetCredits.checkedAt -= 60 * 60 * 1000;
  assert.equal(row().slice(col, col + 2), '3?');
  account.quota.codexResetCredits.applicable = null;
  assert.equal(row().slice(col, col + 1), '3');
  account.quota.codexResetCredits.available = null;
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
  assert.match(tui._renderCodexResets(10).map(strip).join('\n'), /3 banked resets/);
  assert.ok(strip(tui._renderFooter()).length <= 80);
  // Automatic resets are on unless the owner turned them off.
  assert.match(strip(tui._renderFooter()), /Auto: on/);

  assert.doesNotMatch(tui._renderCodexResets(10).map(strip).join(' '), /Expired reset|Spent reset/);
  account.codexResetCredits.applicable = 0;
  assert.match(strip(tui._renderFooter()), /Redeem/);
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
  assert.equal(account.autoRedeemReset, false, 'turning it off is saved as an explicit off');
  assert.deepEqual(calls.at(-1), ['auto', account.name, false]);
  assert.match(strip(tui._renderFooter()), /Auto: off/);
  tui._key('a');
  tui._key('y');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(account.autoRedeemReset, true);
  assert.deepEqual(calls.at(-1), ['auto', account.name, true]);
  assert.match(strip(tui._renderFooter()), /Auto: on/);
  await tui._showCodexResets(codex('Separate account', { quota: {} }));
  assert.match(strip(tui._renderFooter()), /Auto: on/);
  await tui._showCodexResets(codex('Opted out', { quota: {}, autoRedeemReset: false }));
  assert.match(strip(tui._renderFooter()), /Auto: off/);
  tui._key('esc');
  assert.equal(tui.mode, 'accounts');
});

test('Cache and Moves keep separate Codex health and include its hold reasons', () => {
  const tui = makeTui();
  tui.am.addAccount({ name: 'GLM', type: 'provider', provider: 'zai', apiKey: 'fixture' });
  const [anthropic, openai, glm] = tui.am.accounts;
  for (const [account, hit] of [[anthropic, 90], [openai, 80], [glm, 95]]) {
    for (let i = 0; i < 25; i++) {
      const moved = account === openai && i < 2;
      account.inFlight++;
      tui.am.releaseAccount({ account, weight: 1, startedAt: Date.now() - 100, requestInfo: {} }, {
        success: true, status: 200, usage: { in: (100 - hit) * 100, cr: hit * 100, cc: 0 },
        ...moved && { moved: true, movedSame: true, moveCause: 'busy', movedWhy: 'released:hold-ceiling(inflight=6/6)' },
      });
    }
  }
  const cache = strip(tui._cacheLine(80));
  assert.match(cache, /\[15m\/24h\].*Claude 90%\/90% · GLM 95%\/95% · Codex 80%\/80%/);
  assert.doesNotMatch(cache, /miss|cost|same/);
  const detail = tui._renderRoutingDetail(80).map(strip).find(line => line.includes('Cache misses'));
  assert.match(detail, /Codex 50k tok/);
  assert.match(strip(tui._movesLine(80)), /cross 0\/100 · same 2 \(hold-ceiling 2\) · busy 2/);
  assert.equal(tui.am.efficiency24h().codex.served, 25);
  assert.equal(tui.am.efficiency24h().glm.served, 25);
});

test('Codex routing toggle persists the live config before applying it', async () => {
  const saved = [];
  const config = { proxy: { port: 3456 }, scheduler: { providers: { zai: { claudeFallback: 'always' } } } };
  const tui = makeTui({
    config,
    async saveConfig() { saved.push(config.scheduler.providers.codex.sessionRouting); },
  });
  assert.equal(tui.am._sessionRoutingFor('codex'), 'cross-provider');
  await tui._toggleChatGPTSessionRouting();
  assert.deepEqual(saved, ['same-provider']);
  assert.equal(tui.am._sessionRoutingFor('codex'), 'same-provider');
  assert.equal(config.scheduler.providers.zai.claudeFallback, 'always');
  tui.saveConfig = async () => { throw new Error('disk unavailable'); };
  await assert.rejects(tui._toggleChatGPTSessionRouting(), /disk unavailable/);
  assert.equal(config.scheduler.providers.codex.sessionRouting, 'same-provider');
  assert.equal(tui.am._sessionRoutingFor('codex'), 'same-provider');
});
