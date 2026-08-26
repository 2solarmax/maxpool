// USAGE CAP (owner-directed 2026-08-26): "for max@gomokka.com I want it capped at 50%
// of both the session and weekly limit so it's never exhausted — I use it personally."
//
// The guarantee is a HARD bench at the availability gate. These pin the three
// red-team blockers, each of which made the feature silently wrong:
//   1. the weekly cap must bench AHEAD of the upstreamAllows carve-out (else inert on
//      exactly the target account, which upstream reports 'allowed' at 100%);
//   2. the retry oracle must read the SAME per-account threshold as the bench (else a
//      capped last route reports no retry time and a live session is error-fasted);
//   3. an invalid cap must fail CLOSED to "no cap" loudly, never as NaN (which makes
//      every >= comparison false — an uncapped account that looks capped).

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: Date.now() + 36e5, ...extra,
});

function am(accounts, sched = {}) {
  return new AccountManager(accounts, 0.90, sched);
}

// ── the cap is off by default ────────────────────────────────────────────────

test('C1: DEFAULT is uncapped — no behavior change for any existing account', () => {
  const m = am([oauth('plain')]);
  assert.equal(m.accounts[0].capUtilization, null);
  m.accounts[0].quota.unified5h = 0.8;
  m.accounts[0].quota.unified7d = 0.8;
  assert.equal(m._isSessionQuotaUnavailable(m.accounts[0]), false, '80% is fine when uncapped');
  assert.equal(m._weeklyRawState(m.accounts[0]), 'soft', 'normal tier ladder still applies');
});

// ── session axis ─────────────────────────────────────────────────────────────

test('C2: a 50%-capped account is benched at 50% of the SESSION window', () => {
  const m = am([oauth('capped', { capUtilization: 0.5 })]);
  const a = m.accounts[0];
  a.quota.unified5h = 0.49;
  assert.equal(m._isSessionQuotaUnavailable(a), false, 'below the cap: available');
  a.quota.unified5h = 0.50;
  assert.equal(m._isSessionQuotaUnavailable(a), true, 'at the cap: benched');
  assert.equal(m._isAvailable(a), false, 'and the availability gate agrees');
});

test('C3: the cap never RAISES a threshold — a cap above switchThreshold is inert', () => {
  const m = am([oauth('loose', { capUtilization: 0.95 })]);
  const a = m.accounts[0];
  a.quota.unified5h = 0.91;   // past the global 0.90, below the 0.95 cap
  assert.equal(m._isSessionQuotaUnavailable(a), true,
    'the global switchThreshold still benches — min(), never max()');
});

test('C4: provider (z.ai/Kimi) session windows honour the cap too', () => {
  const m = am([{ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'], capUtilization: 0.5 }]);
  const a = m.accounts[0];
  a.quota.providerSes = 0.49;
  assert.equal(m._isSessionQuotaUnavailable(a), false);
  a.quota.providerSes = 0.51;
  assert.equal(m._isSessionQuotaUnavailable(a), true);
});

// ── weekly axis: red-team blocker 1 ──────────────────────────────────────────

test('C5: BLOCKER 1 — the weekly cap benches even while upstream still says "allowed"', () => {
  // The measured shape: max@gomokka.com reported unified7d=1.00 with
  // unifiedStatus='allowed_warning' and served 200s. The upstreamAllows override
  // exists for that. A CAPPED account is below its real limit by definition, so
  // upstream says 'allowed' right through the cap — if the cap sat behind that
  // override it would never fire on the exact account it was built for.
  const m = am([oauth('capped', { capUtilization: 0.5 })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.60;
  a.quota.unifiedStatus = 'allowed';           // upstream is happy
  assert.equal(m._weeklyRawState(a), 'capped', 'the cap outranks the allowed verdict');
  assert.equal(m._isAvailable(a, { allowWeeklyReserve: true, allowWeeklyCritical: true }), false,
    'and it benches even with both weekly escapes requested');
});

test('C6: below the weekly cap the normal tier ladder is untouched', () => {
  const m = am([oauth('capped', { capUtilization: 0.5 })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.30;
  assert.equal(m._weeklyRawState(a), 'normal');
  assert.equal(m._isAvailable(a), true, 'fully usable below the reservation');
});

test('C7: an UNCAPPED account keeps the upstreamAllows behaviour exactly', () => {
  const m = am([oauth('plain')]);
  const a = m.accounts[0];
  a.quota.unified7d = 1.0;
  a.quota.unifiedStatus = 'allowed_warning';
  assert.equal(m._weeklyRawState(a), 'critical',
    'still NOT exhausted — the override is intact for uncapped accounts');
});

// ── retry oracle: red-team blocker 2 ─────────────────────────────────────────

test('C8: BLOCKER 2 — a capped-benched LAST ROUTE reports a finite retry, never Infinity', () => {
  // Single-account fleet, capped at 50%, session at 51%: the bench says "no", so the
  // oracle must say "wait until the 5h reset". If it reads the GLOBAL threshold it
  // sees 0.51 < 0.90, reports nothing, nextRetryForRequest collapses to Infinity and
  // server.js error-fasts a live session that should simply have waited.
  const reset = Date.now() + 90 * 60_000;
  const m = am([oauth('only', { capUtilization: 0.5 })]);
  const a = m.accounts[0];
  a.quota.unified5h = 0.51;
  a.quota.unified5hReset = reset;

  const retry = m.nextRetryForRequest({ profile: 'claude' });
  assert.ok(retry, 'the oracle returns a hold, not nothing');
  assert.ok(Number.isFinite(retry.retryAfterMs), `finite hold required, got ${retry.retryAfterMs}`);
  assert.ok(retry.retryAfterMs > 0 && retry.retryAfterMs <= 90 * 60_000 + 1000,
    'and it is the real 5h-window reset, not a guess');
});

test('C9: the weekly-capped last route also holds on the weekly reset', () => {
  const reset = Date.now() + 3 * 86400_000;
  const m = am([oauth('only', { capUtilization: 0.5 })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.55;
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  const retry = m.nextRetryForRequest({ profile: 'claude' });
  assert.ok(retry && Number.isFinite(retry.retryAfterMs), 'finite hold');
});

// ── sanitization: red-team blocker 3 ─────────────────────────────────────────

test('C10: BLOCKER 3 — an invalid cap becomes null (uncapped), never NaN', () => {
  // NaN would make every `util >= cap` false: the account reads capped in config and
  // behaves uncapped in routing — the silent fail-open this pins.
  for (const bad of ['abc', -1, 0, 1, 1.5, 50, {}, [], true]) {
    const m = am([oauth('x', { capUtilization: bad })]);
    assert.equal(m.accounts[0].capUtilization, null, `${JSON.stringify(bad)} → null`);
    m.accounts[0].quota.unified5h = 0.6;
    assert.equal(m._isSessionQuotaUnavailable(m.accounts[0]), false,
      `${JSON.stringify(bad)} must behave as UNCAPPED, not as a broken comparison`);
  }
});

test('C11: valid fractional caps are kept exactly', () => {
  for (const good of [0.5, 0.25, 0.99, 0.01]) {
    const m = am([oauth('x', { capUtilization: good })]);
    assert.equal(m.accounts[0].capUtilization, good);
  }
});

// ── persistence seams ────────────────────────────────────────────────────────

test('C12: a `cc all` header re-upsert never clears a user-set cap', () => {
  // Same guard as `enabled`: the header path omits the field, so a re-sent token
  // must not silently un-reserve an account.
  const m = am([]);
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'], runtime: true });
  const idx = m.accounts.findIndex(a => a.name === 'glm');
  m.accounts[idx].capUtilization = 0.5;                 // user sets it in the TUI
  m.upsertRuntimeAccount({ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z2', upstream: 'https://z', profiles: ['all'] });
  assert.equal(m.accounts[idx].capUtilization, 0.5, 'survived the header re-send');
  assert.equal(m.accounts[idx].credential, 'z2', 'while the credential DID refresh');
});

test('C13: runtime providers export their cap so it survives a restart', () => {
  const m = am([]);
  m.addAccount({ name: 'glm', type: 'provider', provider: 'zai', authToken: 'z', upstream: 'https://z', profiles: ['all'], runtime: true });
  m.accounts[0].capUtilization = 0.5;
  const [row] = m.exportRuntimeProviders();
  assert.equal(row.capUtilization, 0.5);
  // and the restore path (boot: upsert with an explicit value, no pre-existing row)
  // applies it — this is exactly what index.js does with the persisted providers.
  const m2 = am([]);
  m2.upsertRuntimeAccount(row);
  assert.equal(m2.accounts[0].capUtilization, 0.5, 'restored');
});

test('C14: the cap is visible on the status endpoint (monitorable)', () => {
  const m = am([oauth('capped', { capUtilization: 0.5 }), oauth('plain')]);
  const st = m.getStatus();
  assert.equal(st.accounts.find(a => a.name === 'capped').capUtilization, 0.5);
  assert.equal(st.accounts.find(a => a.name === 'plain').capUtilization, null);
});

// ── the fleet still works around a capped account ────────────────────────────

test('C15: a capped-benched account is skipped, siblings still serve', () => {
  const m = am([
    oauth('capped', { capUtilization: 0.5 }),
    oauth('sibling'),
  ], { routingMode: 'balance' });
  m.accounts[0].quota.unified5h = 0.6;    // over its cap
  m.accounts[1].quota.unified5h = 0.1;
  const picked = m.getActiveAccount({ profile: 'claude' });
  assert.ok(picked, 'the fleet still routes');
  assert.equal(picked.name, 'sibling', 'never the capped one');
});

test('C16: the reservation holds even when the capped account is the CHEAPEST route', () => {
  // The guarantee must be a bench, not a score preference: a wide-open capped account
  // that is by far the best-scoring option must still be refused above its cap.
  const m = am([
    oauth('capped', { capUtilization: 0.5 }),
    oauth('busy'),
  ], { routingMode: 'balance' });
  m.accounts[0].quota.unified5h = 0.55;      // over cap, but otherwise pristine
  m.accounts[1].quota.unified5h = 0.85;      // nearly full, heavily loaded
  m.accounts[1].activeWeight = 20;
  const picked = m.getActiveAccount({ profile: 'claude' });
  assert.equal(picked?.name, 'busy', 'the loaded account wins over the reserved one');
});
