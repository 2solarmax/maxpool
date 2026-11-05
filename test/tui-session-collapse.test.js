import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const DAY = 24 * 60 * 60 * 1000;
const { strip, barLayout } = __tuiTest;

// Some plans no longer report a 5-hour session window. When no account in the
// pool reports one, the Ses column is dropped and Fbl and Wk take its room.

function pool() {
  return new AccountManager([
    { name: 'home', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'work', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'zt', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
}

function weeklyOnly(am, idx) {
  am.applyUsageData(idx, {
    sevenDay: { utilization: 0.40, resetAt: Date.now() + 3 * DAY },
    scopedWeekly: { fable: { severity: 'normal', isActive: true, utilization: 0.45, resetAt: Date.now() + 3 * DAY } },
  });
}

function withSession(am, idx) {
  am.applyUsageData(idx, {
    fiveHour: { utilization: 0.30, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.40, resetAt: Date.now() + 3 * DAY },
  });
}

function frameRows(am, columns) {
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows, write: process.stdout.write };
  let buf = '';
  process.stdout.columns = columns; process.stdout.rows = 24;
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { Object.assign(process.stdout, saved); }
  return strip(buf).split(/\r?\n/).filter(l => /^ {4}(home|work|glm) /.test(l));
}

test('barLayout without the session column: Wk alone under 90 columns, Fbl and Wk from 90', () => {
  assert.deepEqual(barLayout(69, false), { showSession: false, showBoth: true, showFable: false, bw: 5 });
  assert.deepEqual(barLayout(89, false), { showSession: false, showBoth: true, showFable: false, bw: 20 });
  assert.deepEqual(barLayout(90, false), { showSession: false, showBoth: true, showFable: true, bw: 9 });
  assert.deepEqual(barLayout(112, false), { showSession: false, showBoth: true, showFable: true, bw: 20 });
  assert.deepEqual(barLayout(140, false), { showSession: false, showBoth: true, showFable: true, bw: 20 });
});

test('no account reports a session window: rows show Fbl then Wk and no Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  weeklyOnly(am, 1);
  const rows = frameRows(am, 120);
  assert.equal(rows.length, 3);
  for (const l of rows) {
    assert.doesNotMatch(l, /\bSes\b|\bTok\b/, `no session column: ${l}`);
    assert.match(l, /Fbl .* Wk /, `Fbl then Wk: ${l}`);
    assert.ok(l.length <= 120, `fits 120 columns: ${l.length}`);
  }
  assert.match(rows[0], /Fbl\s+45% 3d/);
});

test('one account still reports a session window: every row keeps the Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  withSession(am, 1);
  const rows = frameRows(am, 120);
  for (const l of rows) assert.match(l, /(Ses|Tok) .*Fbl .* Wk /, `three bars: ${l}`);
});

test('a provider session reading also keeps the Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  weeklyOnly(am, 1);
  am.applyProviderUsage(2, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 } });
  const rows = frameRows(am, 120);
  for (const l of rows) assert.match(l, /Ses .*Fbl .* Wk /, `three bars: ${l}`);
});
