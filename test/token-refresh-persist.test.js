import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { tokenFingerprint } from '../src/oauth.js';

function manager(count = 1) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() - 1000, // expired → forces a refresh
    })),
    0.90,
  );
}
function invalidGrant() { const e = new Error('Token refresh failed (400): invalid_grant'); e.status = 400; e.retryable = false; return e; }

// Capture console.log/error emitted during fn() (the persistent event-log mirror
// of these is what the monitoring relies on).
async function captureConsole(fn) {
  const lines = [];
  const origLog = console.log, origErr = console.error;
  console.log = (...a) => lines.push(a.join(' '));
  console.error = (...a) => lines.push(a.join(' '));
  try { await fn(); } finally { console.log = origLog; console.error = origErr; }
  return lines.join('\n');
}

// ── the fingerprint helper: safe, stable, non-reversible ──────────────────────

test('tokenFingerprint: 8-char hex, deterministic, never the token itself, "none" for falsy', () => {
  const fp = tokenFingerprint('some-refresh-token-value');
  assert.match(fp, /^[0-9a-f]{8}$/, '8 hex chars');
  assert.equal(fp, tokenFingerprint('some-refresh-token-value'), 'deterministic');
  assert.notEqual(fp, tokenFingerprint('a-different-token'), 'distinguishes tokens');
  assert.doesNotMatch('some-refresh-token-value', new RegExp(fp), 'the fp is not a substring of the token (irreversible-ish)');
  assert.equal(tokenFingerprint(''), 'none');
  assert.equal(tokenFingerprint(null), 'none');
  assert.equal(tokenFingerprint(undefined), 'none');
});

// ── persist-before-serve: the rotated token is DURABLE before ensureTokenFresh returns ──

test('ensureTokenFresh AWAITS the persist — the callback has fully completed before it resolves', async () => {
  const am = manager(1);
  am._refreshAccessToken = async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });

  let persisted = false;
  // A persist that only sets its flag on a LATER microtask/tick. Fire-and-forget
  // (the old bug) would let ensureTokenFresh resolve with persisted still false.
  am.onTokenRefresh(async () => {
    await new Promise(r => setImmediate(r));
    persisted = true;
  });

  const ok = await am.ensureTokenFresh(0);
  assert.equal(ok, true, 'refresh succeeded');
  assert.equal(persisted, true, 'the persist completed BEFORE ensureTokenFresh resolved (persist-before-serve)');
});

// ── M1: a persist that throws must NEVER brick an account whose refresh SUCCEEDED ──

test('M1: a THROWING persist callback does not latch refreshDead / does not fail the refresh', async () => {
  const am = manager(1);
  am._refreshAccessToken = async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });
  am.onTokenRefresh(() => { throw new Error('persist boom (synchronous prologue)'); });

  const ok = await am.ensureTokenFresh(0);
  assert.equal(ok, true, 'the refresh SUCCEEDED — a persist throw must not re-classify it as failure');
  assert.notEqual(am.accounts[0].refreshDead, true, 'a working account is NOT bricked by a persist error');
  assert.equal(am.accounts[0].status, 'active');
  assert.equal(am.accounts[0].credential, 'a2', 'the fresh token is still serving this session');
});

test('M1: an async-REJECTING persist callback is equally harmless', async () => {
  const am = manager(1);
  am._refreshAccessToken = async () => ({ accessToken: 'a2', refreshToken: 'r2', expiresAt: Date.now() + 3600_000 });
  am.onTokenRefresh(async () => { throw new Error('persist boom (async)'); });

  const ok = await am.ensureTokenFresh(0);
  assert.equal(ok, true);
  assert.notEqual(am.accounts[0].refreshDead, true);
});

// ── monitoring: the audit-trail lines that make a recurrence diagnosable ──────

test('a successful rotation logs a fingerprint trail (rotated <from> → <to>)', async () => {
  const am = manager(1);
  const oldFp = tokenFingerprint('r1');
  const newFp = tokenFingerprint('r2-fresh');
  am._refreshAccessToken = async () => ({ accessToken: 'a2', refreshToken: 'r2-fresh', expiresAt: Date.now() + 3600_000 });
  am.onTokenRefresh(async () => {});

  const out = await captureConsole(() => am.ensureTokenFresh(0));
  assert.match(out, new RegExp(`rotated ${oldFp} . ${newFp}`), 'names both the from- and to-fingerprints');
});

test('a rejected refresh (invalid_grant) logs the REJECTED-fingerprint diagnostic', async () => {
  const am = manager(1);
  const sentFp = tokenFingerprint('r1'); // the token it POSTed (== _refreshedFrom)
  am._refreshAccessToken = async () => { throw invalidGrant(); };

  const out = await captureConsole(() => am.ensureTokenFresh(0));
  assert.match(out, /REJECTED/);
  assert.match(out, new RegExp(`fp=${sentFp}`), 'names the exact rejected token so a lost-rotation is distinguishable from a revocation');
  assert.equal(am.accounts[0].refreshDead, true, 'still latches dead (storm control unchanged)');
});

test('a Claude refresh persists if the same grant learns its user or organization while awaiting the token response', async () => {
  for (const accountUuid of [null, 'claude-user']) {
    let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const am = new AccountManager([{ name: 'legacy', type: 'oauth', accountUuid,
      accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }], 0.9, {}, { refreshAccessToken: () => pending });
    const account = am.accounts[0];
    let persisted;
    am.onTokenRefresh((_index, tokens) => { persisted = tokens; });
    const refreshing = am.ensureTokenFresh(0);
    account.accountUuid = 'claude-user';
    account.organizationUuid = 'learned-org';
    const current = { accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 };
    finish(current);
    assert.equal(await refreshing, true);
    assert.deepEqual(persisted, current);
    assert.equal(account.refreshToken, 'new-refresh');
    assert.equal(account.organizationUuid, 'learned-org');
  }
});

test('a refresh cannot follow a Claude row reassigned to a different known organization', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const am = new AccountManager([{ name: 'claude', type: 'oauth', accountUuid: 'user', organizationUuid: 'original-org',
    accessToken: 'old-access', refreshToken: 'old-refresh', expiresAt: 1 }], 0.9, {}, { refreshAccessToken: () => pending });
  let persisted = 0;
  am.onTokenRefresh(() => { persisted++; });
  const refreshing = am.ensureTokenFresh(0);
  am.accounts[0].organizationUuid = 'different-org';
  finish({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600000 });
  assert.equal(await refreshing, false);
  assert.equal(persisted, 0);
});
