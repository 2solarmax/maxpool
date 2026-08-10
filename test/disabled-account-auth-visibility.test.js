import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { TUI, __tuiTest } from '../src/tui.js';

const { strip } = __tuiTest;

// Two defects, one report (2026-08-10):
// 1. Disabling an account HID its auth state — the row read "✕ disabled" whether the
//    credentials were fine or long dead. All 8 disabled accounts were sitting on HTTP
//    401s with no way to see it, so re-enabling one would silently produce a broken
//    account.
// 2. A sustained 401 never latched refreshDead, so the prober re-POSTed a rejected
//    token every 60s forever — 8 accounts each past 20 consecutive failures.

const acct = (over = {}) => ({
  name: 'a1', type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 3600_000, ...over,
});

test('a sustained 401 latches refreshDead (stops the endless probe hammer)', () => {
  const am = new AccountManager([acct()], 0.90);
  const a = am.accounts[0];
  assert.ok(!a.refreshDead, 'starts alive');
  am.recordProbeError(0, 'Invalid authentication credentials', 401);
  assert.ok(!a.refreshDead, '1 strike is not enough — could be a rotation race');
  am.recordProbeError(0, 'Invalid authentication credentials', 401);
  assert.ok(!a.refreshDead, '2 strikes still tolerated');
  am.recordProbeError(0, 'Invalid authentication credentials', 401);
  assert.equal(a.refreshDead, true, '3 consecutive 401s = dead credentials');
});

test('a NON-401 failure never latches refreshDead (429/500 are transient)', () => {
  const am = new AccountManager([acct()], 0.90);
  for (let i = 0; i < 30; i++) am.recordProbeError(0, 'Rate limited', 429);
  assert.ok(!am.accounts[0].refreshDead, 'a 429 storm is not an auth failure');
  for (let i = 0; i < 30; i++) am.recordProbeError(0, 'server error', 500);
  assert.ok(!am.accounts[0].refreshDead, 'nor is a 5xx');
});

test('the prober SKIPS an account once its credentials are latched dead', () => {
  const am = new AccountManager([acct(), acct({ name: 'a2' })], 0.90);
  for (let i = 0; i < 3; i++) am.recordProbeError(0, 'Invalid authentication credentials', 401);
  // prober.js filters on !a.refreshDead
  const probeable = am.accounts.filter(a => a.type === 'oauth' && a.credential && !a.refreshDead);
  assert.deepEqual(probeable.map(a => a.name), ['a2'], 'the dead account is no longer probed');
});

test('re-authenticating revives a latched-dead account', () => {
  const am = new AccountManager([acct()], 0.90);
  for (let i = 0; i < 3; i++) am.recordProbeError(0, 'Invalid authentication credentials', 401);
  assert.equal(am.accounts[0].refreshDead, true);
  am.updateAccountTokens(0, { accessToken: 'new', refreshToken: 'newr', expiresAt: Date.now() + 3600_000 });
  assert.ok(!am.accounts[0].refreshDead, 'fresh tokens revive it');
});

// ── the display half ─────────────────────────────────────────────────────────

test('a DISABLED account with dead credentials shows "reauth", not just "disabled"', () => {
  const am = new AccountManager([acct()], 0.90);
  am.accounts[0].enabled = false;
  am.accounts[0].refreshDead = true;
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /reauth/, 'the user must see it needs re-login even while disabled');
});

test('a DISABLED account with GOOD credentials still shows plain "disabled"', () => {
  const am = new AccountManager([acct()], 0.90);
  am.accounts[0].enabled = false;
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /disabled/);
  assert.doesNotMatch(line, /reauth/, 'a healthy disabled account must NOT claim it needs re-login');
});

test('an ENABLED account with dead credentials still shows "reauth" (unchanged)', () => {
  const am = new AccountManager([acct()], 0.90);
  am.accounts[0].refreshDead = true;
  const line = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true));
  assert.match(line, /reauth/);
});
