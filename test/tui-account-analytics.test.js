import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip, acctHeader, fitLine } = __tuiTest;

function setup(config = {}) {
  const records = [
    { name: 'claude-fixture', type: 'oauth', accessToken: 'fixture', refreshToken: 'fixture' },
    { name: 'codex-fixture', type: 'oauth', provider: 'codex', accessToken: 'fixture-2', refreshToken: 'fixture-2' },
  ];
  const am = new AccountManager(records, 0.9);
  const windows = Object.fromEntries(['1h', '3h', '24h', '7d', 'all'].map((p, i) => {
    const read = [0, 50, 80, 90, 70][i];
    return [p, { input: 98 - read, cacheRead: read, cacheWrite: 2, output: 10, hit: read / 100, partial: p === '7d' }];
  }));
  const metrics = { since: Date.UTC(2025, 0, 1), asOf: Date.UTC(2025, 0, 2), windows };
  am.accountCacheWindows = account => account.provider === 'codex' ? metrics : null;
  am.providerCacheWindows = () => ({ codex: metrics });
  const tui = new TUI({ accountManager: am, config });
  return tui;
}

const page = (tui, w = 80, h = 24) => tui._renderAnalyticsPage(w, h).map(line => strip(fitLine(line, w)).trimEnd()).join('\n');

test('main cache stays aligned on narrow and wide terminals, including zero and unavailable data', () => {
  const tui = setup();
  for (const width of [40, 80, 100, 160]) {
    const header = strip(acctHeader(width));
    const col = header.indexOf('Cache 3h');
    assert.ok(col >= 0 && col + 8 <= width);
    const rendered = index => strip(tui._renderAcct(index, 5, true, false, true, width));
    assert.equal(rendered(0).slice(col, col + 8).trim(), '—');
    assert.equal(rendered(1).slice(col, col + 8).trim(), '50%');
  }
});

test('Activity analytics shows cache share and token classes for the selected account or provider', () => {
  const tui = setup();
  tui._key('v');
  assert.equal(tui.mode, 'analytics');
  assert.match(page(tui, 40), /codex-fixture +0% +80% +90%\* +70%/i);
  assert.match(page(tui), /claude-fixture +Anthropic +— +— +— +—/);
  tui._key('down');
  tui._key('enter');
  assert.match(page(tui), /24h +18 +80 +2 +10 +110/);
  assert.match(page(tui), /Last report 2025-01-02 00:00 UTC/);
  assert.match(page(tui), /No subscription terms configured/);
  tui._key('esc');
  tui._key('p');
  assert.match(page(tui), /Activity analytics · Providers/);
  assert.match(page(tui), /Codex +0% +80% +90%\* +70%/);
  tui._key('enter');
  assert.match(page(tui, 40), /24h +18 +80 +2 +10 +110/);
  assert.doesNotMatch(page(tui), /Subscription/);
  tui._key('esc');
  tui._key('esc');
  assert.equal(tui.mode, 'normal');
});

test('Capacity opens the same analytics view; private terms stay with their selected account', t => {
  const dir = mkdtempSync(join(tmpdir(), 'maxpool-view-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'terms.json');
  writeFileSync(path, JSON.stringify([{ vendor: 'codex', account: 'codex-fixture', subscriptions: [
    { price: 11, currency: 'EUR', cycle: 'quarterly', next_renew: '2030-02-04' },
    { price: 23, cycle: 'annual' },
  ] }]), { mode: 0o600 });
  const tui = setup({ ui: { subscriptionRegistries: [{ file: path }] } });
  tui._key('y');
  tui._key('v');
  tui._key('enter');
  assert.doesNotMatch(page(tui), /EUR|2030|quarterly/);
  tui._key('esc');
  tui._key('down');
  tui._key('enter');
  assert.match(page(tui), /EUR 11 · quarterly/);
  assert.match(page(tui), /Next renewal +2030-02-04/);
  assert.match(page(tui), /23 · annual/);
  for (let i = 0; i < 30; i++) tui._key('down');
  assert.match(page(tui, 40, 8), /23 · annual/);
  tui._key('esc');
  tui._key('esc');
  assert.equal(tui.mode, 'capacity');
});

test('a served Codex request reaches both dashboard and activity through terminal keys', () => {
  const am = new AccountManager([{ name: 'fixture', type: 'oauth', provider: 'codex', accountUuid: 'id-1' }]);
  am.accrueCapacity(0, { input: 20, cacheRead: 80, output: 9 });
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  let frame;
  tui._writeScreen = (lines, width) => { frame = lines.map(line => strip(fitLine(line, width))).join('\n'); };
  tui.running = true;
  tui.render();
  assert.match(frame, /fixture +80%\*?/);
  assert.match(frame, /Cache 3h/);
  tui._onData('v');
  assert.match(frame, /Activity analytics · Accounts/);
  tui._onData('p');
  assert.match(frame, /Codex +80%\*?/);
  tui._onData('\r');
  assert.match(frame, /24h\*? +20 +80 +0 +9 +109/);
  tui._onData('\x1b');
  tui._onData('\x1b');
  assert.equal(tui.mode, 'normal');
});

test('a cloud holder can show its proven local copy’s terms without matching by name', () => {
  const account = { name: 'local-name', type: 'oauth', accountUuid: 'same-account' };
  const local = new AccountManager([{ ...account, plan: { priceUsd: 17, cadence: 'monthly' } }]);
  const cloud = new AccountManager([{ ...account, name: 'cloud-name' }]);
  local.syncRemoteMirrors({ name: 'team', url: 'http://fixture.invalid', lastOkAt: Date.now(), status: cloud.getStatus() });
  local.accounts[0].poolBenchedBy = 'same-account';
  const tui = new TUI({ accountManager: local, config: {} });
  tui._key('v');
  tui._key('enter');
  assert.match(page(tui), /Local subscription\n +USD 17 · monthly/);
});
