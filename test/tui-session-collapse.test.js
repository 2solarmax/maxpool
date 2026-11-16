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

test('barLayout without the session column: Wk alone under 103 columns, Fbl and Wk from 103', () => {
  assert.deepEqual(barLayout(69, false), { showSession: false, showBoth: true, showFable: false, bw: 5 });
  assert.deepEqual(barLayout(95, false), { showSession: false, showBoth: true, showFable: false, bw: 16 });
  assert.deepEqual(barLayout(102, false), { showSession: false, showBoth: true, showFable: false, bw: 20 });
  assert.deepEqual(barLayout(103, false), { showSession: false, showBoth: true, showFable: true, bw: 9 });
  assert.deepEqual(barLayout(125, false), { showSession: false, showBoth: true, showFable: true, bw: 20 });
  assert.deepEqual(barLayout(140, false), { showSession: false, showBoth: true, showFable: true, bw: 20 });
});

// A GLM row has no Fable limit, so it carries no Fbl label (blank space keeps the
// columns); every other row leads with Fbl. Wk sits in the same column on every row.
const isProvider = l => /^ {4}glm /.test(l);
function assertBars(rows, claudeRe, providerRe, what) {
  const wkCol = rows.find(l => !isProvider(l)).indexOf(' Wk ');
  for (const l of rows) {
    if (isProvider(l)) {
      assert.doesNotMatch(l, /Fbl|Fable/, `no Fable label on a GLM row: ${l}`);
      assert.match(l, providerRe, `${what}: ${l}`);
    } else {
      assert.match(l, claudeRe, `${what}: ${l}`);
    }
    assert.equal(l.indexOf(' Wk '), wkCol, `Wk column aligned: ${l}`);
  }
}

// Peer review (contribution session, 2026-11-16): the provider blank must ride the SAME
// showFable switch the OAuth rows use. A pool where NO account has a Fable reading keeps
// the Fbl column dashed on OAuth rows (width-based layout), and the GLM blank must match
// it exactly — otherwise GLM Ses/Wk drift out of the OAuth columns.
test('a pool with no Fable readings anywhere: the GLM blank keeps Wk in the OAuth rows column', () => {
  const am = pool();                       // no applyUsageData with scopedWeekly on any row
  withSession(am, 0);
  const rows = frameRows(am, 118);
  assert.equal(rows.length, 3);
  const oauth = rows.find(l => /^ {4}home /.test(l));
  const glm = rows.find(l => /^ {4}glm /.test(l));
  assert.match(oauth, /Fbl /, 'OAuth rows keep the dashed Fbl column');
  assert.doesNotMatch(glm, /Fbl|Fable/, 'GLM row still shows no Fable label');
  assert.equal(glm.indexOf(' Wk '), oauth.indexOf(' Wk '), 'Wk column aligned');
  for (const l of rows) assert.ok(l.length <= 118, `fits 118 columns: ${l.length}`);
});

test('no account reports a session window: rows show Fbl then Wk and no Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  weeklyOnly(am, 1);
  const rows = frameRows(am, 120);
  assert.equal(rows.length, 3);
  for (const l of rows) {
    assert.doesNotMatch(l, /\bSes\b|\bTok\b/, `no session column: ${l}`);
    assert.ok(l.length <= 120, `fits 120 columns: ${l.length}`);
  }
  assertBars(rows, /Fbl .* Wk /, / Wk /, 'Fbl then Wk');
  assert.match(rows[0], /Fbl\s+45% 3d/);
});

test('one account still reports a session window: every row keeps the Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  withSession(am, 1);
  const rows = frameRows(am, 120);
  assertBars(rows, /Fbl .*(Ses|Tok) .* Wk /, /(Ses|Tok) .* Wk /, 'three bars');
});

test('a provider session reading also keeps the Ses column', () => {
  const am = pool();
  weeklyOnly(am, 0);
  weeklyOnly(am, 1);
  am.applyProviderUsage(2, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 } });
  const rows = frameRows(am, 120);
  assertBars(rows, /Fbl .*Ses .* Wk /, /Ses .* Wk /, 'three bars');
});

test('a session window that expires on an idle pool keeps the Ses column (no width jump)', () => {
  const am = pool();
  withSession(am, 0);
  weeklyOnly(am, 1);
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  const render = () => {
    const saved = { columns: process.stdout.columns, rows: process.stdout.rows, write: process.stdout.write };
    let buf = '';
    process.stdout.columns = 120; process.stdout.rows = 24;
    process.stdout.write = s => { buf += s; return true; };
    try { tui._render(); } finally { Object.assign(process.stdout, saved); }
    return strip(buf).split(/\r?\n/).filter(l => /^ {4}(home|work|glm) /.test(l));
  };
  const before = render();
  assert.match(before[0], /Fbl .*Ses .* Wk /);
  am.accounts[0].quota.unified5h = null;          // the 5h window expired, nothing served since
  am.accounts[0].quota.unified5hReset = null;
  const after = render();
  for (const l of after) assert.match(l, /(Ses|Tok) /, `Ses column stays: ${l}`);
  assert.equal(after[1].indexOf(' Wk '), before[1].indexOf(' Wk '), 'bars keep their width');
});
