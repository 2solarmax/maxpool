// The TUI efficiency line (2026-11-15): under Routing, only with traffic, red names the
// cause, low volume says so instead of numbers, and it fits the terminal width.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;
const acct = (n, type = 'oauth', extra = {}) => ({ name: n, type, accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, accountUuid: `U-${n}`, ...extra });
const am = (n = 2) => new AccountManager(Array.from({ length: n }, (_, i) => acct(`c${i + 1}`)), 0.9);
const lease = a => { a.inFlight++; return { account: a, weight: 1, startedAt: Date.now() - 100, requestInfo: {} }; };
const served = (m, a, u, extra = {}) => m.releaseAccount(lease(a), { success: true, status: 200, usage: u, ...extra });

function frameAt(tui, columns) {
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows, write: process.stdout.write };
  let buf = '';
  process.stdout.columns = columns; process.stdout.rows = 40;
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { Object.assign(process.stdout, saved); }
  return strip(buf).split(/\r?\n/);
}

test('renders directly under the Routing line, and not at all without traffic', () => {
  const quiet = new TUI({ accountManager: am(), config: { proxy: { port: 3456 } } });
  assert.equal(quiet._efficiencyLine(100), null, 'no traffic, no line');
  const lines = frameAt(quiet, 100);
  assert.ok(!lines.some(l => l.trim().startsWith('Cache')), 'not in the frame');

  const m = am();
  served(m, m.accounts[0], { in: 1000, cr: 90_000, cc: 0, out: 10 });   // 98.9%, still low volume
  for (let i = 0; i < 24; i++) served(m, m.accounts[0], { in: 1000, cr: 90_000, cc: 0, out: 10 });
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const frame = frameAt(tui, 120);
  const routing = frame.findIndex(l => l.trim().startsWith('Routing'));
  const cache = frame.findIndex(l => l.trim().startsWith('Cache'));
  assert.ok(routing >= 0, 'Routing line present');
  assert.ok(cache === routing + 1, `directly under Routing (routing=${routing}, cache=${cache})`);
  assert.match(frame[cache], /Claude 99%/, 'per-provider share');
  assert.match(frame[cache], /miss 25k tok/, 'miss tokens');
  assert.match(frame[cache], /\[15m\]/, 'window');
});

test('a red line names the cause and the account behind it', () => {
  const m = am(2);
  const [a, b] = m.accounts;
  // a: 40% hit with real volume; b: healthy. Forced moves above 2/100 → red.
  for (let i = 0; i < 30; i++) {
    served(m, i % 3 === 0 ? b : a, { in: 6_000, cr: 4_000, cc: 0, out: 10 });
  }
  for (let i = 0; i < 3; i++) served(m, b, { in: 100, cr: 900, cc: 0 }, { moved: true, moveCause: 'busy' });
  const line = strip(new TUI({ accountManager: m, config: { proxy: { port: 3456 } } })._efficiencyLine(160));
  assert.match(line, /⚠/, 'red names a cause');
  assert.ok(/c1/.test(line), `names the account: ${line}`);
});

test('low volume says so instead of numbers, and the line fits 65 columns', () => {
  const m = am();
  served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0, out: 1 });
  const tui = new TUI({ accountManager: m, config: { proxy: { port: 3456 } } });
  const line = strip(tui._efficiencyLine(65));
  assert.match(line, /little traffic/, line);
  for (const W of [65, 100, 112, 140]) {
    assert.ok(strip(tui._efficiencyLine(W)).length <= W, `fits ${W}: ${strip(tui._efficiencyLine(W)).length}`);
  }
  // With real volume the numbers appear and STILL fit 65.
  for (let i = 0; i < 30; i++) served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0 });
  for (let i = 0; i < 4; i++) served(m, m.accounts[0], { in: 100, cr: 9_900, cc: 0 }, { moved: true, moveCause: 'balance' });
  const full = strip(tui._efficiencyLine(65));
  assert.ok(full.length <= 65, `fits 65 with numbers: ${full.length}`);
  assert.match(full, /moves \d+\/100/, full);
});
