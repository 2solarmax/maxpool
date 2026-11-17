// TUI routing clarity (Max, 2026-10-13): 16 requests sat parked for 35 minutes while
// the account table said "active" next to accounts that could not take a request
// (held at their usage cap, or their 5h window full). And the routing menu's keys did
// not say what they control or how to undo them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TUI, __tuiTest } from '../src/tui.js';
import { AccountManager } from '../src/account-manager.js';

const { strip } = __tuiTest;

function captureRender(tui) {
  const orig = process.stdout.write;
  let buf = '';
  process.stdout.write = s => { buf += s; return true; };
  try { tui._render(); } finally { process.stdout.write = orig; }
  return strip(buf);
}
function rowFor(text, name) {
  // The account ROW (has a Ses/Wk/Tok column), never a log line that names it.
  return text.split('\n').find(l => l.includes(name) && /\b(Ses|Wk|Tok)\b/.test(l)) || '';
}
const oauth = (name, extra = {}) => ({ name, type: 'oauth', accessToken: 't', refreshToken: 'r', expiresAt: Date.now() + 3600_000, ...extra });
const provider = (name, extra = {}) => ({ name, type: 'provider', provider: 'zai', authToken: 'k', upstream: 'http://x', profiles: ['all'], ...extra });
const tuiFor = (am, config = {}) => new TUI({ accountManager: am, config: { proxy: { port: 3456 }, ...config }, saveConfig: async () => {} });

test('an account held at its usage cap reads "capped" in the Status column, not "active"', () => {
  const am = new AccountManager([oauth('held-acct', { capUtilization: 0.5, capMode: 'fixed' }), oauth('free-acct')], 0.90);
  const now = Date.now();
  am.accounts[0].quota = { ...am.accounts[0].quota, unified5h: 0.05, unified7d: 0.52, unified5hReset: now + 3600_000, unified7dReset: now + 3 * 86400_000 };
  am.accounts[1].quota = { ...am.accounts[1].quota, unified5h: 0.05, unified7d: 0.10, unified5hReset: now + 3600_000, unified7dReset: now + 3 * 86400_000 };
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router refuses this account');
  const text = captureRender(tuiFor(am));
  assert.match(rowFor(text, 'held-acct'), /\bcapped\b/, `a capped account must not read "active": ${rowFor(text, 'held-acct')}`);
  assert.doesNotMatch(rowFor(text, 'held-acct'), /\bactive\b/);
  assert.match(rowFor(text, 'free-acct'), /\bactive\b/, 'a usable account still reads active');
});

test('a provider whose 5h window is full reads "5h full" in the Status column, not "active"', () => {
  const am = new AccountManager([provider('glm full'), provider('glm ok')], 0.95);
  am.accounts[0].quota = { ...am.accounts[0].quota, providerSes: 1, providerSesReset: Date.now() + 2 * 3600_000, providerWk: 0.5 };
  am.accounts[1].quota = { ...am.accounts[1].quota, providerSes: 0.10, providerWk: 0.5 };
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router refuses this account');
  const text = captureRender(tuiFor(am));
  assert.match(rowFor(text, 'glm full'), /5h full/, `a session-full account must say so: ${rowFor(text, 'glm full')}`);
  assert.doesNotMatch(rowFor(text, 'glm full'), /\bactive\b/);
  assert.match(rowFor(text, 'glm ok'), /\bactive\b/);
});

test('routing menu: the peak cap key names what it limits (GLM, peak hours) and where account caps live', () => {
  const am = new AccountManager([oauth('a1'), provider('glm one')], 0.90, {
    providers: { zai: { peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }], peakTimezone: 'UTC', peakCap: 0.5 } },
  });
  const tui = tuiFor(am);
  tui.mode = 'routing';
  const text = captureRender(tui);
  assert.match(text, /GLM peak cap/, 'the c key must say it is the GLM peak-hours cap');
  assert.match(text, /GLM accounts only, in GLM peak hours\. Not Claude\./, 'and say it does not limit Claude accounts');
  assert.match(text, /Usage cap for ONE account: Esc then a → u/, 'the screen must point to where per-account usage caps are set');
});

test('routing menu: an active manual preference shows the account and how to turn it off', () => {
  const am = new AccountManager([oauth('a1'), oauth('a2')], 0.90);
  am.setRoutingMode('preferred', 'a2');
  const tui = tuiFor(am, { routing: { mode: 'preferred', preferredAccount: 'a2' } });
  tui.mode = 'routing';
  const text = captureRender(tui);
  assert.match(text, /Pinned to a2/, 'the pinned account must be named on the routing screen');
  assert.match(text, /a Unpin/, 'the way back to automatic must be shown next to it');
});

test('routing menu: with no preference set, p explains what it does', () => {
  const am = new AccountManager([oauth('a1'), oauth('a2')], 0.90);
  const tui = tuiFor(am);
  tui.mode = 'routing';
  const text = captureRender(tui);
  assert.match(text, /p Pin one Claude account/, 'p must say what it does');
});

test('routing detail fits an 80-column terminal (a truncated explanation explains nothing)', () => {
  const am = new AccountManager([oauth('max@gomokka.com', { capUtilization: 0.5 }), oauth('kira', { capUtilization: 0.5 }), provider('glm one')], 0.90, {
    providers: { zai: { peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }], peakTimezone: 'UTC', peakCap: 0.5 } },
  });
  am.setRoutingMode('preferred', 'max@gomokka.com');
  const tui = tuiFor(am);
  for (const line of tui._renderRoutingDetail()) {
    assert.ok(strip(line).length <= 80, `line is ${strip(line).length} cols: ${strip(line)}`);
  }
  assert.match(tui._renderRoutingDetail().map(strip).join('\n'), /Caps set: max@gomokka\.com 50%, kira 50%/, 'lists the accounts that carry a cap');
});

test('a 5h window whose reset has PASSED is not "5h full" — the account is free again', () => {
  const am = new AccountManager([oauth('just-reset')], 0.95);
  // In-place mutate: assigning a fresh quota object re-runs the manager's own
  // expiry clear (which nulls the window); in-place is the state a render can
  // actually see when a window expires between upstream fetches.
  Object.assign(am.accounts[0].quota, { unified5h: 0.97, unified5hReset: Date.now() - 60_000, unified7d: 0.10, unified7dReset: Date.now() + 3 * 86400_000 });
  // Row renderer directly: a full _render() runs the manager's expiry clear first,
  // which would hide whether the row itself respects the reset time.
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /\bactive\b/, `an expired window must not bench the account: ${row}`);
});

test('a GLM account past its 5h reset stamp is still refused (its reading is only cleared by the next usage check) — must not read "active"', () => {
  const am = new AccountManager([provider('glm stale')], 0.95);
  Object.assign(am.accounts[0].quota, { providerSes: 1, providerSesReset: Date.now() - 60_000, providerWk: 0.3 });
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router still refuses it');
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /5h full/, `row: ${row}`);
  assert.doesNotMatch(row, /\bactive\b/);
});

test('a GLM account whose 5h reading is over its WEEKLY cap reads "capped" (the router judges GLM against the weekly cap)', () => {
  const now = Date.now();
  const am = new AccountManager([provider('glm dyn', { capUtilization: 0.5, capMode: 'dynamic' })], 0.95);
  Object.assign(am.accounts[0].quota, { providerSes: 0.7, providerSesReset: now + 10 * 60e3, providerWk: 0.1, providerWkReset: now + 6.5 * 86400e3 });
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router refuses it');
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /\bcapped\b/, `row: ${row}`);
});

test('routing screen on a 24-row terminal: the controls line is never pushed off', () => {
  const accts = [...Array(8)].map((_, i) => oauth('acct' + i, i < 2 ? { capUtilization: 0.5 } : {})).concat([provider('glm one')]);
  const am = new AccountManager(accts, 0.95, {
    providers: { zai: { peakWindows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMin: 0, endMin: 1440 }], peakTimezone: 'UTC', peakCap: 0.5 } },
  });
  am.setRoutingMode('preferred', 'acct0');
  const tui = tuiFor(am);
  tui.mode = 'routing';
  for (let i = 0; i < 3; i++) tui.active.set('r' + i, { started: Date.now(), t: '12:00', method: 'POST', path: '/v1/messages', account: 'acct1' });
  const rows = process.stdout.rows, cols = process.stdout.columns;
  process.stdout.rows = 24; process.stdout.columns = 100;
  let lines;
  try { lines = captureRender(tui).split(/\r?\n/); } finally { process.stdout.rows = rows; process.stdout.columns = cols; }
  assert.equal(lines.length, 24);
  assert.match(lines[23], /^ f Routing:/, `last row must be the controls line: ${lines[23]}`);
  assert.ok(lines.some(l => /Pinned to acct0/.test(l)), 'the pin line is on screen');
});

test('pressing a with nothing pinned does not offer to "unpin"', () => {
  const am = new AccountManager([oauth('a1'), oauth('a2')], 0.90);
  const tui = tuiFor(am);
  tui.mode = 'routing';
  tui._keyRouting('a');
  assert.notEqual(tui.mode, 'confirm', 'no confirm dialog when there is nothing to unpin');
  am.setRoutingMode('preferred', 'a2');
  tui._keyRouting('a');
  assert.equal(tui.mode, 'confirm', 'with a pin, a asks to unpin');
});

// WEEKLY WINDOW FULL (Max, 2026-11-18): four GLM rows read "active" next to "Wk 100%"
// with resets 22h-2d away. The router skips a weekly-full account (_weeklyRawState
// 'exhausted'), so the Status column must say "exhausted" — the SAME word an
// Anthropic account uses for this state (owner 2026-11-18: one state, one word).
const wkFull = (extra = {}) => ({ providerSes: 0, providerWk: 1, providerWkReset: Date.now() + 22 * 3600_000, ...extra });

test('a GLM account whose WEEKLY window is full reads "exhausted", not "active"', () => {
  const am = new AccountManager([provider('glm wkfull'), provider('glm fine')], 0.95);
  Object.assign(am.accounts[0].quota, wkFull());
  Object.assign(am.accounts[1].quota, { providerSes: 0.1, providerWk: 0.5, providerWkReset: Date.now() + 3 * 86400_000 });
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router refuses this account');
  assert.equal(am._isAvailable(am.accounts[1]), true, 'precondition: the router uses the other one');
  const text = captureRender(tuiFor(am));
  assert.match(rowFor(text, 'glm wkfull'), /exhausted/, `row: ${rowFor(text, 'glm wkfull')}`);
  assert.doesNotMatch(rowFor(text, 'glm wkfull'), /\bactive\b/);
  assert.match(rowFor(text, 'glm fine'), /\bactive\b/);
});

test('a CLOUD GLM row (the reported case) whose weekly window is full reads "exhausted"', () => {
  const am = new AccountManager([provider('glm cloudfull', { remoteUuid: 'U1', remote: { linkName: 'team', remoteName: 'glm cloudfull', url: 'http://127.0.0.1:9', key: 'k', link: { lastOkAt: Date.now() } } })], 0.95);
  Object.assign(am.accounts[0].quota, wkFull());
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /exhausted/, `row: ${row}`);
  assert.doesNotMatch(row, /\bactive\b/);
});

test('a GLM weekly reading past its reset stamp still reads "exhausted" while the router still refuses it', () => {
  const am = new AccountManager([provider('glm stalewk')], 0.95);
  Object.assign(am.accounts[0].quota, wkFull({ providerWkReset: Date.now() - 60_000 }));
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: GLM readings are only cleared by the next usage check');
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /exhausted/, `row: ${row}`);
});

test('a Claude account at 100% weekly that Anthropic still ALLOWS stays "active" (the router keeps it as a last resort)', () => {
  const am = new AccountManager([oauth('claude allowed')], 0.95);
  Object.assign(am.accounts[0].quota, { unified5h: 0.1, unified5hReset: Date.now() + 3600_000, unified7d: 1, unified7dReset: Date.now() + 86400_000, unifiedStatus: 'allowed_warning' });
  assert.equal(am._weeklyRawState(am.accounts[0]), 'critical', 'precondition: last-resort tier, not removed from routing');
  assert.equal(am._isAvailable(am.accounts[0], { allowWeeklyCritical: true }), true, 'precondition: the router can still serve it');
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /\bactive\b/, `row: ${row}`);
  assert.doesNotMatch(row, /exhausted/);
});

test('a Claude account at 100% weekly with no "allowed" verdict reads "exhausted"', () => {
  const am = new AccountManager([oauth('claude wkfull')], 0.95);
  Object.assign(am.accounts[0].quota, { unified5h: 0.1, unified5hReset: Date.now() + 3600_000, unified7d: 1, unified7dReset: Date.now() + 86400_000 });
  assert.equal(am._isAvailable(am.accounts[0]), false, 'precondition: the router refuses it');
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /exhausted/, `row: ${row}`);
});

test('a Claude weekly window whose reset has PASSED is free again', () => {
  const am = new AccountManager([oauth('claude wkreset')], 0.95);
  Object.assign(am.accounts[0].quota, { unified5h: 0.1, unified5hReset: Date.now() + 3600_000, unified7d: 1, unified7dReset: Date.now() - 60_000 });
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /\bactive\b/, `row: ${row}`);
});

test('a GLM account with BOTH windows full names the longer wait: "exhausted"', () => {
  const am = new AccountManager([provider('glm bothfull')], 0.95);
  Object.assign(am.accounts[0].quota, wkFull({ providerSes: 1, providerSesReset: Date.now() + 2 * 3600_000 }));
  const row = strip(tuiFor(am)._renderAcct(0, 11, true));
  assert.match(row, /exhausted/, `row: ${row}`);
});

test('terminology: the SAME status word "exhausted" serves both Anthropic and GLM weekly-full rows', () => {
  const am = new AccountManager([oauth('cla wk', { }), provider('glm wk2')], 0.95);
  const now = Date.now();
  Object.assign(am.accounts[0].quota, { unified5h: 0.1, unified5hReset: now + 3600_000, unified7d: 1, unified7dReset: now + 86400_000 });
  Object.assign(am.accounts[1].quota, { providerSes: 0, providerWk: 1, providerWkReset: now + 22 * 3600_000 });
  const r1 = strip(tuiFor(am)._renderAcct(0, 11, true));
  const r2 = strip(tuiFor(am)._renderAcct(1, 11, true));
  assert.match(r1, /exhausted/); assert.match(r2, /exhausted/);
  assert.doesNotMatch(r1 + r2, /wk full/i);
});
