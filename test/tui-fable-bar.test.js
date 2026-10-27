import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const DAY = 24 * 60 * 60 * 1000;
const { strip } = __tuiTest;

// Neutral fixtures: two Claude accounts and one z.ai provider.
function pool() {
  return new AccountManager([
    { name: 'home', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'work', type: 'oauth', accessToken: 't2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 },
    { name: 'glm', type: 'provider', provider: 'zai', authToken: 'zt', upstream: 'https://api.z.ai/api/anthropic' },
  ], 0.90);
}

function fable(am, idx, entry) {
  am.applyUsageData(idx, {
    fiveHour: { utilization: 0.30, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.40, resetAt: Date.now() + 3 * DAY },
    scopedWeekly: { fable: { severity: 'normal', isActive: true, resetAt: Date.now() + 3 * DAY, ...entry } },
  });
}

function row(am, idx, bw = 11, showBoth = true, showFable = showBoth) {
  return strip(new TUI({ accountManager: am })._renderAcct(idx, bw, showBoth, showFable));
}

// The cell that follows a label: the bar text between "Fbl " and the next "  Wk".
function fableCell(line) {
  const start = line.indexOf('Fbl ') + 4;
  return line.slice(start, line.indexOf('  Wk', start));
}

// The ask: a third bar, between Ses and Wk, with the Fable weekly used% and reset.

test('an OAuth row shows a Fbl bar between Ses and Wk with the Fable used% and resets-in', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  const line = row(am, 0);
  const ses = line.indexOf('Ses '), fbl = line.indexOf('Fbl '), wk = line.indexOf(' Wk ');
  assert.ok(ses >= 0 && fbl > ses && wk > fbl, `Ses, then Fbl, then Wk: ${JSON.stringify(line)}`);
  assert.match(fableCell(line), /45% 3d/, 'used% and resets-in, like the other two bars');
});

test('an OAuth row with no Fable reading shows an empty dash cell under Fbl', () => {
  const am = pool();
  am.applyUsageData(1, {
    fiveHour: { utilization: 0.10, resetAt: Date.now() + 3600_000 },
    sevenDay: { utilization: 0.20, resetAt: Date.now() + 3 * DAY },
  });
  const line = row(am, 1);
  assert.match(line, /Fbl /);
  assert.equal(fableCell(line).trim(), '—');
});

test('a provider row shows a dash under Fbl and keeps every bar column aligned with the OAuth row', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  am.applyProviderUsage(2, { source: 'zai', ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 } });
  const oauth = row(am, 0), provider = row(am, 2);
  assert.equal(fableCell(provider).trim(), '—', 'a non-Anthropic provider has no Fable data');
  for (const label of ['Ses ', 'Fbl ', ' Wk ']) {
    assert.equal(provider.indexOf(label), oauth.indexOf(label), `${label.trim()} column aligned`);
  }
});

test('an exhausted Fable weekly shows 100% in the bar and still the "Fable maxed" tag', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.9995, severity: 'critical' });
  const line = row(am, 0);
  assert.match(fableCell(line), /100%/);
  assert.match(line, /Fable maxed/, 'the existing tag stays');
});

test('a Fable limit Anthropic reports as inactive shows a dash, like no reading (routing ignores it too)', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.99, isActive: false });
  const line = row(am, 0);
  assert.equal(fableCell(line).trim(), '—');
});

test('a narrow terminal (showBoth=false) shows neither Fbl nor Wk', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  const line = row(am, 0, 11, false);
  assert.match(line, /Ses /);
  assert.doesNotMatch(line, /Fbl|\bWk\b/);
});

test('a mid-width terminal (showBoth, no showFable) shows Ses and Wk but not Fbl', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  const line = row(am, 0, 11, true, false);
  assert.match(line, /Ses /);
  assert.match(line, / Wk /);
  assert.doesNotMatch(line, /Fbl/);
});

// Width tiers: the third bar drops out on a narrow terminal the way the second one does.

test('barLayout: one bar under 70 columns, two from 70, three from 99, three bars capped at 11', () => {
  const { barLayout } = __tuiTest;
  assert.deepEqual(barLayout(69), { showBoth: false, showFable: false, bw: 9 });
  assert.deepEqual(barLayout(70), { showBoth: true, showFable: false, bw: 5 });
  assert.deepEqual(barLayout(80), { showBoth: true, showFable: false, bw: 7 });
  assert.deepEqual(barLayout(86), { showBoth: true, showFable: false, bw: 10 });
  assert.deepEqual(barLayout(98), { showBoth: true, showFable: false, bw: 16 });
  assert.deepEqual(barLayout(99), { showBoth: true, showFable: true, bw: 9 });
  assert.deepEqual(barLayout(104), { showBoth: true, showFable: true, bw: 10 });
  assert.deepEqual(barLayout(105), { showBoth: true, showFable: true, bw: 11 });
  assert.deepEqual(barLayout(120), { showBoth: true, showFable: true, bw: 11 });
  assert.deepEqual(barLayout(140), { showBoth: true, showFable: true, bw: 11 });
});

test('barLayout: a two-bar row fills the terminal exactly at 80 columns and never overflows it', () => {
  const { barLayout } = __tuiTest;
  // 76 = the first width where two 5-wide bars fit; 70..75 is the long-standing
  // two-bar tier, where the second bar is clipped at the right edge as before.
  for (let W = 76; W <= 140; W++) {
    const { showFable, bw } = barLayout(W);
    const rowWidth = 60 + bw + (showFable ? 6 + bw : 0) + 6 + bw;
    assert.ok(rowWidth <= W, `W=${W}: bars end at column ${rowWidth}`);
    // Three bars never take more of the line than two bars could (106 columns), so
    // the tags after the bars keep their room on a wide terminal.
    if (showFable) assert.ok(rowWidth <= 106, `W=${W}: three bars end at column ${rowWidth}`);
  }
  assert.equal(60 + 2 * barLayout(80).bw + 6, 80);
});

// Capture the full-screen paint at a given terminal size, stripped of ANSI.
function frameAt(tui, columns) {
  const saved = { columns: process.stdout.columns, rows: process.stdout.rows, write: process.stdout.write };
  let buf = '';
  process.stdout.columns = columns; process.stdout.rows = 24;
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { Object.assign(process.stdout, saved); }
  return strip(buf).split(/\r?\n/);
}

// The account rows of a full frame (an account with no reading yet renders Tok/Req, not Ses).
function frameRows(am, columns) {
  const tui = new TUI({ accountManager: am, config: { proxy: { port: 3456 } } });
  const lines = frameAt(tui, columns);
  return lines.filter(l => /^ {4}(home|work|glm) /.test(l));
}

test('a full frame at 99 columns shows three bars on every account row, each row fitting the width', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  const rows = frameRows(am, 99);
  assert.equal(rows.length, 3, 'one row per account');
  for (const l of rows) {
    assert.match(l, /(Ses|Tok) .*Fbl .* (Wk|Req) /, 'three bars in order');
    assert.ok(l.length <= 99, `fits 99 columns: ${l.length}`);
  }
  assert.match(rows[0], /Fbl\s+45% 3d/, 'the used% is readable at the first three-bar width');
});

test('a full frame at 80 columns keeps the two-bar layout', () => {
  const am = pool();
  fable(am, 0, { utilization: 0.45 });
  const rows = frameRows(am, 80);
  assert.equal(rows.length, 3);
  for (const l of rows) {
    assert.match(l, /(Ses|Tok) .* (Wk|Req) /);
    assert.doesNotMatch(l, /Fbl/);
  }
});
