// DYNAMIC USAGE CAP (owner-directed 2026-09-24): "I want to have a dynamic cap that
// always preserves some meaningful room for usage of those accounts outside of MaxPool,
// but if the weekly or session limit is nearing expiration, I think the cap can go higher."
//
// The fixed cap benches an account at a CONSTANT share of both windows, so whatever is
// reserved and unused dies at the window reset. Measured at design time: `kira` sat at
// weekly utilization 0.50 against a 0.50 cap with 55.7h left on the window — half a
// subscription about to expire unused.
//
// The dynamic cap keeps the floor early in the window and ramps the effective cap toward
// `switchThreshold` as the reset approaches. It is bounded ABOVE by switchThreshold, never
// 1.0, because "always preserves some meaningful room" means a fully-ramped dynamic account
// behaves exactly like an UNCAPPED one and never more aggressively.
//
// These tests are written to fail against the pre-change HEAD (no _effectiveCap helper).

import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';

const HOUR = 3600_000;
const FIVE_H = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;
const T0 = 1_800_000_000_000; // fixed clock; every test passes `now` explicitly

const oauth = (name, extra = {}) => ({
  name, type: 'oauth', accessToken: 't', refreshToken: 'r',
  expiresAt: T0 + 36e5, ...extra,
});
const provider = (name, extra = {}) => ({
  name, type: 'provider', provider: 'zai', authToken: 'z',
  upstream: 'https://z', profiles: ['all'], ...extra,
});

function am(accounts, sched = {}) {
  return new AccountManager(accounts, 0.90, sched);
}

/** Put a window at a given "remaining time to reset" against the fixed test clock. */
function setWindow(account, kind, { util, remainingMs }) {
  const q = account.quota;
  const reset = remainingMs == null ? null : T0 + remainingMs;
  if (account.type === 'provider') {
    if (kind === 'ses') { q.providerSes = util; q.providerSesReset = reset; }
    else { q.providerWk = util; q.providerWkReset = reset; }
  } else {
    if (kind === 'ses') { q.unified5h = util; q.unified5hReset = reset; }
    else { q.unified7d = util; q.unified7dReset = reset; }
  }
}

// ── T1: early in the window, dynamic == the old fixed cap ────────────────────

test('T1: dynamic floor behaves exactly like the old fixed cap before the ramp starts', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  // rampStart default 0.5 → the whole first half of each window sits at the floor.
  setWindow(a, 'wk', { util: 0.5, remainingMs: WEEK });          // 0% elapsed
  setWindow(a, 'ses', { util: 0.5, remainingMs: FIVE_H });
  assert.equal(m._effectiveCap(a, 'wk', T0), 0.5, 'weekly at window start == floor');
  assert.equal(m._effectiveCap(a, 'ses', T0), 0.5, 'session at window start == floor');
  // exactly AT rampStart is still the floor
  setWindow(a, 'wk', { util: 0.5, remainingMs: WEEK / 2 });
  assert.equal(m._effectiveCap(a, 'wk', T0), 0.5, 'at rampStart == floor');
});

// ── T2: the cap rises as the window nears expiry ─────────────────────────────

test('T2: effective cap rises monotonically with elapsed time and reaches switchThreshold at expiry', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  const caps = [];
  // `remaining: 0` is EXCLUDED deliberately: a stamp at/behind `now` means the window
  // has rolled and the position is unknown, which fails closed to the floor (T6) — it
  // is not the ramp's limit. Approach expiry with a small positive remainder instead.
  for (const remaining of [WEEK, WEEK * 0.75, WEEK * 0.5, WEEK * 0.25, WEEK * 0.1, 60_000]) {
    setWindow(a, 'wk', { util: 0.5, remainingMs: remaining });
    caps.push(m._effectiveCap(a, 'wk', T0));
  }
  for (let i = 1; i < caps.length; i++) {
    assert.ok(caps[i] >= caps[i - 1], `cap must not fall as time passes (${caps})`);
  }
  assert.equal(caps[0], 0.5, 'starts at the floor');
  assert.ok(caps[caps.length - 1] > 0.89 && caps[caps.length - 1] <= 0.9,
    `reaches switchThreshold at expiry, got ${caps[caps.length - 1]}`);
  // The owner's worked case: kira's weekly, 55.7h left of a 7d window, floor 0.5.
  setWindow(a, 'wk', { util: 0.5, remainingMs: 55.7 * HOUR });
  const kira = m._effectiveCap(a, 'wk', T0);
  assert.ok(kira > 0.5 && kira < 0.9,
    `the stranding case must have lifted off the floor but not to the ceiling, got ${kira}`);
});

// ── T3: the bounding invariant, as a property ────────────────────────────────

test('T3: effective cap is ALWAYS within [floor, switchThreshold] — never below, never above', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  for (let i = 0; i < 400; i++) {
    const floor = 0.01 + Math.random() * 0.98;          // any legal cap
    const remaining = Math.random() * WEEK * 1.5;        // incl. beyond a full window
    a.capUtilization = floor;
    setWindow(a, 'wk', { util: 0.5, remainingMs: remaining });
    const eff = m._effectiveCap(a, 'wk', T0);
    assert.ok(Number.isFinite(eff), `must be finite (floor=${floor}, rem=${remaining})`);
    assert.ok(eff >= floor - 1e-12, `never below the floor: ${eff} < ${floor}`);
    assert.ok(eff <= Math.max(floor, m.switchThreshold) + 1e-12,
      `never above the ceiling: ${eff} > ${Math.max(floor, m.switchThreshold)}`);
  }
});

test('T3b: a floor at or above switchThreshold is returned unchanged (no downward move)', () => {
  const m = am([oauth('high', { capUtilization: 0.95, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  for (const remaining of [WEEK, WEEK / 4, 0]) {
    setWindow(a, 'wk', { util: 0.5, remainingMs: remaining });
    assert.equal(m._effectiveCap(a, 'wk', T0), 0.95,
      'a floor above the ceiling must never be pulled DOWN to it');
  }
});

// ── T4 / T6: fail-closed on unusable reset stamps ────────────────────────────

test('T4: an unknown reset stamp falls back to the floor (fail-closed), every account type', () => {
  const m = am([
    oauth('o', { capUtilization: 0.5, capMode: 'dynamic' }),
    provider('p', { capUtilization: 0.5, capMode: 'dynamic' }),
  ]);
  for (const a of m.accounts) {
    for (const kind of ['ses', 'wk']) {
      setWindow(a, kind, { util: 0.5, remainingMs: null });   // utilization known, reset not
      assert.equal(m._effectiveCap(a, kind, T0), 0.5,
        `${a.name}/${kind}: no reset stamp must mean the floor, never an opened-up cap`);
    }
  }
});

test('T6: a reset stamp in the PAST fails CLOSED to the floor — the window rolled, our position is unknown', () => {
  // A past stamp does NOT mean "fully elapsed, spend the reserve". It means the window
  // already rolled and the utilization we still hold belongs to the window that CLOSED.
  // Ramping on that is a fail-OPEN on stale data — and provider stamps are never cleared
  // by _clearExpiredQuotas, so a probe outage would hold it open indefinitely.
  for (const acct of [oauth('stale', { capUtilization: 0.5, capMode: 'dynamic' }),
                      provider('pstale', { capUtilization: 0.5, capMode: 'dynamic' })]) {
    const m = am([acct]);
    const a = m.accounts[0];
    setWindow(a, 'wk', { util: 0.55, remainingMs: -3 * 24 * HOUR });
    const eff = m._effectiveCap(a, 'wk', T0);
    assert.ok(Number.isFinite(eff), 'must not be NaN');
    assert.equal(eff, 0.5, `${a.name}: a rolled-but-unrefreshed window must hold the floor, got ${eff}`);
    assert.equal(m._weeklyRawState(a, T0), 'capped',
      `${a.name}: 0.55 over a 0.5 floor is benched — exactly as the fixed cap would be`);
  }
});

// ── T5: fixed mode is untouched ──────────────────────────────────────────────

test('T5: capMode fixed is byte-for-byte the old behaviour at every elapsed ratio', () => {
  const m = am([oauth('fix', { capUtilization: 0.5, capMode: 'fixed' })]);
  const a = m.accounts[0];
  for (const remaining of [WEEK, WEEK / 2, HOUR, 0, null]) {
    setWindow(a, 'wk', { util: 0.5, remainingMs: remaining });
    assert.equal(m._effectiveCap(a, 'wk', T0), 0.5, `fixed cap must never move (rem=${remaining})`);
  }
});

test('T5b: an account with no cap stays uncapped in every mode', () => {
  const m = am([oauth('plain'), oauth('plainDyn', { capMode: 'dynamic' })]);
  for (const a of m.accounts) {
    setWindow(a, 'wk', { util: 0.99, remainingMs: HOUR });
    assert.equal(m._effectiveCap(a, 'wk', T0), null, `${a.name}: no cap means no cap`);
    assert.equal(m._capped(a, 0.99, 'wk', T0), false, `${a.name}: must not bench`);
  }
});

// ── the bench actually uses the ramp ─────────────────────────────────────────

test('T2b: the BENCH follows the ramp — an account benched early is routable near expiry', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  // Utilization 0.60, weekly. Early in the window that is over the 0.5 floor → capped.
  setWindow(a, 'wk', { util: 0.60, remainingMs: WEEK });
  assert.equal(m._weeklyRawState(a, T0), 'capped', 'over the floor early in the window = capped');
  // Same utilization with the window nearly over → the ramp has lifted the cap past it.
  setWindow(a, 'wk', { util: 0.60, remainingMs: 0.02 * WEEK });
  assert.notEqual(m._weeklyRawState(a, T0), 'capped',
    'near expiry the reserved-but-unused capacity must become spendable');
});

test('T2c: the SESSION bench follows the ramp on the 5h window', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  setWindow(a, 'ses', { util: 0.60, remainingMs: FIVE_H });
  assert.equal(m._isSessionQuotaUnavailable(a, T0), true, 'benched early in the 5h window');
  setWindow(a, 'ses', { util: 0.60, remainingMs: 0.02 * FIVE_H });
  assert.equal(m._isSessionQuotaUnavailable(a, T0), false, 'routable as the 5h window closes');
});

// ── T9: the cap keeps its position ahead of the upstreamAllows carve-out ─────

test('T9: the dynamic cap still outranks the upstreamAllows carve-out', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  a.quota.unifiedStatus = 'allowed_warning';  // upstream says "go ahead" at high utilization
  setWindow(a, 'wk', { util: 0.7, remainingMs: WEEK });
  assert.equal(m._weeklyRawState(a, T0), 'capped',
    'the owner reservation outranks the vendor verdict, exactly as the fixed cap does');
});

// ── T7 / T8: the retry oracle cannot desync from the bench ───────────────────

test('T7: a dynamically-capped benched account reports a FINITE retry at the window reset', () => {
  // The dynamic twin of usage-cap.test.js C8. Single-account fleet so the oracle has no
  // other route to offer: utilization must sit above the EFFECTIVE cap at this instant,
  // and the hold must be the real window reset rather than an Infinity error-fast.
  const reset = Date.now() + 3 * 24 * HOUR;          // 3d left of the 7d window
  const m = am([oauth('only', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.85;                          // above the ramped cap (~0.75 here)
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  assert.equal(m._weeklyRawState(a), 'capped', 'precondition: the dynamic cap benches it');

  const retry = m.nextRetryForRequest({ profile: 'claude' });
  assert.ok(retry, 'the oracle returns a hold, not nothing');
  assert.ok(Number.isFinite(retry.retryAfterMs), `finite hold required, got ${retry.retryAfterMs}`);
  assert.ok(retry.retryAfterMs > 0 && retry.retryAfterMs <= 3 * 24 * HOUR + 1000,
    'and it is the real weekly reset, not a guess');
});

test('T8: bench and oracle read the SAME threshold at the same instant', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  setWindow(a, 'ses', { util: 0.55, remainingMs: 0.3 * FIVE_H });
  const bench = m._sessionBenchThreshold(a, T0);
  const eff = m._effectiveCap(a, 'ses', T0);
  assert.equal(bench, Math.min(eff, m.switchThreshold),
    'the session bench must be the effective cap (capped by switchThreshold), not a constant');
});

test('T8b: a later clock never makes a dynamically-capped account LESS available', () => {
  const m = am([oauth('dyn', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  setWindow(a, 'wk', { util: 0.7, remainingMs: WEEK });
  let prev = -Infinity;
  for (const dt of [0, HOUR, 12 * HOUR, 3 * 24 * HOUR, 6 * 24 * HOUR]) {
    const eff = m._effectiveCap(a, 'wk', T0 + dt);
    assert.ok(eff >= prev, 'the effective cap must be non-decreasing in time');
    prev = eff;
  }
});

// ── T10: migration ───────────────────────────────────────────────────────────

test('T10: a config fixed cap with no explicit mode migrates to dynamic-floor', () => {
  const m = am([oauth('legacy', { capUtilization: 0.5 })]);   // no capMode — the pre-change shape
  const a = m.accounts[0];
  assert.equal(a.capUtilization, 0.5, 'the floor keeps the old value');
  assert.equal(a.capMode, 'dynamic', 'and the mode becomes dynamic — the new default');
  setWindow(a, 'wk', { util: 0.5, remainingMs: 0.05 * WEEK });
  assert.ok(m._effectiveCap(a, 'wk', T0) > 0.5, 'so it actually ramps');
});

test('T10b: an explicit fixed mode opts OUT of the migration', () => {
  const m = am([oauth('pinned', { capUtilization: 0.5, capMode: 'fixed' })]);
  assert.equal(m.accounts[0].capMode, 'fixed');
});

test('T10c: an invalid cap still sanitizes to no-cap, whatever the mode says', () => {
  for (const bad of ['abc', NaN, -1, 0, 1, 50]) {
    const m = am([oauth('x', { capUtilization: bad, capMode: 'dynamic' })]);
    assert.equal(m.accounts[0].capUtilization, null, `${JSON.stringify(bad)} must fail closed to no cap`);
    assert.equal(m._effectiveCap(m.accounts[0], 'wk', T0), null);
  }
});

// ── the "more available, never less" invariant against the OLD behaviour ─────

test('T3c: for every window state, dynamic is at least as available as the fixed cap it replaces', () => {
  const fixed = am([oauth('f', { capUtilization: 0.5, capMode: 'fixed' })]);
  const dyn = am([oauth('d', { capUtilization: 0.5, capMode: 'dynamic' })]);
  for (let i = 0; i < 200; i++) {
    const remaining = Math.random() * WEEK;
    const util = Math.random();
    setWindow(fixed.accounts[0], 'wk', { util, remainingMs: remaining });
    setWindow(dyn.accounts[0], 'wk', { util, remainingMs: remaining });
    const fCapped = fixed._capped(fixed.accounts[0], util, 'wk', T0);
    const dCapped = dyn._capped(dyn.accounts[0], util, 'wk', T0);
    assert.ok(!(dCapped && !fCapped),
      `dynamic benched where fixed did not (util=${util}, remaining=${remaining}h) — ` +
      'this change may only ever make an account MORE available');
  }
});

// ── T12: the `c` key sets mode + floor, and rolls back on a write failure ────

import { TUI } from '../src/tui.js';

function tuiWith(accountsCfg, { failWrite = false } = {}) {
  const manager = am(accountsCfg);
  const config = { accounts: accountsCfg.map(a => ({ ...a })), providers: [] };
  const saved = [];
  const tui = new TUI({
    accountManager: manager,
    config,
    saveConfig: async c => {
      if (failWrite) throw new Error('disk full');
      saved.push(JSON.parse(JSON.stringify(c)));
    },
  });
  return { tui, manager, config, saved };
}

test('T12: a bare number sets a DYNAMIC floor — the new default at the keyboard too', async () => {
  const { tui, manager, config } = tuiWith([oauth('a')]);
  await tui._doSetCap(0, '50');
  assert.equal(manager.accounts[0].capUtilization, 0.5);
  assert.equal(manager.accounts[0].capMode, 'dynamic');
  assert.equal(config.accounts[0].capUtilization, 0.5);
  assert.equal(config.accounts[0].capMode, 'dynamic', 'the mode is written explicitly, not left to a default');
});

test('T12b: an f-prefix pins the FIXED cap', async () => {
  const { tui, manager, config } = tuiWith([oauth('a')]);
  await tui._doSetCap(0, 'f60');
  assert.equal(manager.accounts[0].capUtilization, 0.6);
  assert.equal(manager.accounts[0].capMode, 'fixed');
  assert.equal(config.accounts[0].capMode, 'fixed');
});

test('T12c: 0 / off removes both the cap and the mode', async () => {
  const { tui, manager, config } = tuiWith([oauth('a', { capUtilization: 0.5, capMode: 'dynamic' })]);
  await tui._doSetCap(0, 'off');
  assert.equal(manager.accounts[0].capUtilization, null);
  assert.equal(manager.accounts[0].capMode, null);
  assert.ok(!('capMode' in config.accounts[0]), 'no orphan mode is left behind in config');
  assert.ok(!('capUtilization' in config.accounts[0]));
});

test('T12d: an out-of-range value changes nothing', async () => {
  const { tui, manager } = tuiWith([oauth('a', { capUtilization: 0.5, capMode: 'dynamic' })]);
  await tui._doSetCap(0, '150');
  assert.equal(manager.accounts[0].capUtilization, 0.5, 'the existing cap survives a bad input');
  assert.equal(manager.accounts[0].capMode, 'dynamic');
});

test('T12e: a failed config write rolls BOTH the cap and the mode back', async () => {
  const { tui, config } = tuiWith([oauth('a', { capUtilization: 0.5, capMode: 'fixed' })], { failWrite: true });
  await assert.rejects(() => tui._doSetCap(0, '70'), /disk full/);
  assert.equal(config.accounts[0].capUtilization, 0.5, 'cap rolled back');
  assert.equal(config.accounts[0].capMode, 'fixed', 'and the mode with it — not left on the new value');
});

// ── each window is judged against ITS OWN clock (T13/M10 closed this gap) ────
// The two windows ramp independently: a 5h window 90% elapsed sits near the ceiling
// while the weekly it belongs to is barely started. Judging one by the other's clock
// silently opens or closes the wrong reserve, and no earlier test could see it.

test('T9b: the weekly bench reads the WEEKLY window, never the session one — provider', () => {
  const m = am([provider('p', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  // Session window nearly over (would ramp to ~0.9), weekly window fresh (floor 0.5).
  setWindow(a, 'ses', { util: 0.1, remainingMs: 0.02 * FIVE_H });
  setWindow(a, 'wk', { util: 0.6, remainingMs: WEEK });
  assert.equal(m._weeklyRawState(a, T0), 'capped',
    'weekly 0.6 is over the weekly floor 0.5 — the session window being nearly over is irrelevant');
});

test('T9c: the weekly bench reads the WEEKLY window, never the session one — OAuth', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  a.quota.unifiedStatus = 'allowed';
  setWindow(a, 'ses', { util: 0.1, remainingMs: 0.02 * FIVE_H });
  setWindow(a, 'wk', { util: 0.6, remainingMs: WEEK });
  assert.equal(m._weeklyRawState(a, T0), 'capped',
    'a nearly-closed 5h window must not unlock the weekly reserve');
});

test('T9d: and the converse — a nearly-closed WEEKLY must not unlock the session reserve', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  setWindow(a, 'ses', { util: 0.6, remainingMs: FIVE_H });         // fresh → floor 0.5 → benched
  setWindow(a, 'wk', { util: 0.1, remainingMs: 0.02 * WEEK });     // nearly over → ramped high
  assert.equal(m._isSessionQuotaUnavailable(a, T0), true,
    'the session reserve is governed by the session clock alone');
});

test('T6b: the fail-closed floor holds however far in the past the stamp is', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  for (const past of [-1, -HOUR, -5 * WEEK, -520 * WEEK]) {
    setWindow(a, 'wk', { util: 0.5, remainingMs: past });
    assert.equal(m._effectiveCap(a, 'wk', T0), 0.5,
      `a stamp ${past}ms in the past must never lift the cap off its floor`);
  }
});

// ── the hold is the RAMP CROSSING, not the window reset (pre-mortem finding 2) ──
// A fixed cap only unbenches at the reset, so keying the hold there was right. A rising
// cap unbenches on its own ramp — often hours earlier — and telling the client to wait
// the full window stalls work that could have run, precisely near reset where this
// feature is supposed to help.

test('T7b: a dynamically-capped account holds until the ramp crosses it, not until the reset', () => {
  const m = am([oauth('only', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  const reset = T0 + 20 * HOUR;
  a.quota.unified7d = 0.85;
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  assert.equal(m._weeklyRawState(a, T0), 'capped', 'precondition: benched now');

  const at = m._capUnbenchAt(a, 0.85, 'wk', T0);
  assert.ok(at != null && at > T0 && at < reset,
    `must unbench strictly before the reset, got ${at} vs reset ${reset}`);
  // and the answer is exact: at that instant the effective cap has reached 0.85.
  assert.ok(Math.abs(m._effectiveCap(a, 'wk', at) - 0.85) < 1e-9,
    'the reported instant is where the ramp actually crosses the utilization');
  // The CAP has released it; the ordinary weekly ladder still applies (0.85 is a
  // 'reserve'-tier utilization, which is routable with a soft cost — the point is that
  // it is no longer 'capped', i.e. no longer held out by the owner's reservation).
  assert.notEqual(m._weeklyRawState(a, at + 1000), 'capped',
    'the reservation no longer benches it at the crossing');
});

test('T7c: utilization above the ceiling can never be reached by the ramp — falls back to the reset', () => {
  const m = am([oauth('only', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  const reset = T0 + 20 * HOUR;
  a.quota.unified7d = 0.97;                     // above switchThreshold 0.90
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  assert.equal(m._capUnbenchAt(a, 0.97, 'wk', T0), null,
    'the ramp tops out at the ceiling — only the reset helps');
});

test('T7d: a FIXED cap still holds to the reset (its recovery really is the window end)', () => {
  const m = am([oauth('only', { capUtilization: 0.5, capMode: 'fixed' })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.85;
  a.quota.unified7dReset = T0 + 20 * HOUR;
  assert.equal(m._capUnbenchAt(a, 0.85, 'wk', T0), null, 'no ramp, no early crossing');
});

test('T7e: an unknown window position gives no crossing — the hold falls back, never to null', () => {
  const m = am([oauth('only', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  a.quota.unified7d = 0.85;
  a.quota.unified7dReset = null;                // no stamp at all
  assert.equal(m._capUnbenchAt(a, 0.85, 'wk', T0), null);
  a.quota.unified7dReset = T0 - WEEK;           // rolled, not yet re-learned
  assert.equal(m._capUnbenchAt(a, 0.85, 'wk', T0), null);
});

// ── config hygiene (pre-mortem findings 7) ──────────────────────────────────

test('T10d: an unrecognised capMode is reported, not silently honoured', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const m = am([oauth('typo', { capUtilization: 0.5, capMode: 'fxied' })]);
    assert.equal(m.accounts[0].capMode, 'dynamic', 'falls back to the default');
    assert.ok(logs.some(l => /Ignoring unknown capMode/.test(l)),
      'and says so — a typo must not fail open in silence');
  } finally { console.log = orig; }
});

test('T10e: an absent capMode migrates SILENTLY — every legacy config has that shape', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const m = am([oauth('legacy', { capUtilization: 0.5 })]);
    assert.equal(m.accounts[0].capMode, 'dynamic');
    assert.ok(!logs.some(l => /capMode/.test(l)), 'the migration is not an error to report');
  } finally { console.log = orig; }
});

test('T10f: an invalid cap is reported exactly ONCE per account, not once per internal read', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    am([oauth('bad', { capUtilization: 'abc', capMode: 'dynamic' })]);
    const complaints = logs.filter(l => /Ignoring invalid capUtilization/.test(l));
    assert.equal(complaints.length, 1, `expected one complaint, got ${complaints.length}`);
  } finally { console.log = orig; }
});

// ── learned window span (pre-mortem finding 8) ───────────────────────────────
// The 5h/7d table is an assumption about the vendor. A provider whose "weekly" is
// really 3 days would sit part-way up the ramp from the moment the window is born —
// permanently over-open. Learn the span from what we actually observe instead.

test('T14: a shorter-than-nominal vendor window is learned, and the cap stays at its floor', () => {
  const m = am([provider('p', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  const THREE_DAYS = 3 * 24 * HOUR;
  // A FRESH 3-day weekly window: 3 days remaining. Against the nominal 7d assumption
  // that reads as 57% elapsed — already past rampStart, so the cap would lift on day one.
  m.applyProviderUsage(0, { ses: null, wk: { utilization: 0.55, resetAt: Date.now() + THREE_DAYS } });
  assert.ok(a.quota.capSpanWk >= THREE_DAYS - 1000, 'the observed span is recorded');
  const eff = m._effectiveCap(a, 'wk', Date.now());
  assert.equal(eff, 0.5,
    `a fresh window must sit at the floor whatever its length, got ${eff}`);
});

test('T14b: the learned span is bounded by nominal — a long stamp cannot push the cap UP', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  m.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + 30 * 24 * HOUR } });
  assert.ok(a.quota.capSpanWk <= WEEK + 1000,
    'never learn a span longer than nominal — that is the fail-open direction');
});

test('T14c: the span only ever grows, so a late-window observation cannot shrink it', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  m.applyUsageData(0, { sevenDay: { utilization: 0.1, resetAt: Date.now() + 6 * 24 * HOUR } });
  const wide = a.quota.capSpanWk;
  m.applyUsageData(0, { sevenDay: { utilization: 0.9, resetAt: Date.now() + 2 * HOUR } });
  assert.equal(a.quota.capSpanWk, wide, 'a near-reset reading must not redefine the window');
});

// ── per-account ceiling / ramp start (pre-mortem finding 5) ──────────────────
// How much of their own account to hold back, and from when, is the OWNER's call —
// not a constant in DEFAULT_SCHEDULER.

test('T15: a per-account ceiling bounds the ramp below switchThreshold', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capCeiling: 0.7 })]);
  const a = m.accounts[0];
  setWindow(a, 'wk', { util: 0.5, remainingMs: 60_000 });   // effectively at expiry
  const eff = m._effectiveCap(a, 'wk', T0);
  assert.ok(eff <= 0.7 + 1e-9, `must not exceed the account's own ceiling, got ${eff}`);
  assert.ok(eff > 0.69, 'and it does reach it');
});

test('T15b: a per-account rampStart moves when the lift begins', () => {
  const late = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capRampStart: 0.9 })]);
  const early = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capRampStart: 0.1 })]);
  for (const m of [late, early]) setWindow(m.accounts[0], 'wk', { util: 0.5, remainingMs: WEEK * 0.4 });
  assert.equal(late._effectiveCap(late.accounts[0], 'wk', T0), 0.5,
    'a 0.9 ramp start keeps the full reserve until the last tenth of the window');
  assert.ok(early._effectiveCap(early.accounts[0], 'wk', T0) > 0.5,
    'a 0.1 ramp start has already begun opening up');
});

test('T15c: the unbench solver honours the SAME per-account numbers as the bench', () => {
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capCeiling: 0.7, capRampStart: 0.25 })]);
  const a = m.accounts[0];
  const reset = T0 + 0.5 * WEEK;
  a.quota.unified7d = 0.65;
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  const at = m._capUnbenchAt(a, 0.65, 'wk', T0);
  assert.ok(at != null, 'a crossing exists below the 0.7 ceiling');
  assert.ok(Math.abs(m._effectiveCap(a, 'wk', at) - 0.65) < 1e-9,
    'and the bench agrees with the solver at that instant — one set of numbers, two readers');
});

test('T15d: an invalid per-account override is rejected and reported, falling back to the default', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capRampStart: 1.5 })]);
    assert.equal(m.accounts[0].capRampStart, null, 'rejected');
    assert.ok(logs.some(l => /Ignoring invalid capRampStart/.test(l)), 'and reported');
    setWindow(m.accounts[0], 'wk', { util: 0.5, remainingMs: WEEK });
    assert.equal(m._effectiveCap(m.accounts[0], 'wk', T0), 0.5, 'default ramp still applies');
  } finally { console.log = orig; }
});

test('T7f: the unbench time is never reported beyond the window reset', () => {
  // The solver inverts the ramp; if the account also carries a per-account ceiling or a
  // learned span, the algebraic crossing can land past the reset. Reporting that would
  // hold a request LONGER than the window it is waiting on — the over-hold this whole
  // ramp-aware path exists to remove, reintroduced at the other end.
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic', capRampStart: 0.95 })]);
  const a = m.accounts[0];
  // REAL clock here, not the fixed T0: the leg below goes through nextRetryForRequest,
  // which reads Date.now() itself. Mixing the two would measure the gap between the
  // fake and real clocks rather than the hold.
  const nowReal = Date.now();
  const reset = nowReal + 2 * HOUR;
  a.quota.unified7d = 0.89;                    // just under the ceiling → crossing very late
  a.quota.unifiedStatus = 'allowed';
  a.quota.unified7dReset = reset;
  const at = m._capUnbenchAt(a, 0.89, 'wk', nowReal);
  if (at != null) {
    assert.ok(at <= reset, `the hold must never outlast the window itself: ${at} > ${reset}`);
  }
  // and through the real oracle, the client-facing hold obeys the same bound
  const retry = m.nextRetryForRequest({ profile: 'claude' });
  if (retry && Number.isFinite(retry.retryAfterMs)) {
    assert.ok(retry.retryAfterMs <= 2 * HOUR + 1000,
      `client hold must not exceed the window reset, got ${retry.retryAfterMs}ms`);
  }
});

test('T14d: a reset stamp further out than a nominal window reads as "just started", not negative', () => {
  // The low-side clamp on the elapsed ratio: a vendor window longer than we assume (or a
  // stamp we cannot explain) must read as the START of a window — floor — never as a
  // negative position, which would flow into the ramp arithmetic.
  const m = am([oauth('o', { capUtilization: 0.5, capMode: 'dynamic' })]);
  const a = m.accounts[0];
  setWindow(a, 'wk', { util: 0.6, remainingMs: 30 * 24 * HOUR });   // 30d out, nominal 7d
  assert.equal(m._effectiveCap(a, 'wk', T0), 0.5, 'holds the floor, no negative elapsed');
  assert.equal(m._weeklyRawState(a, T0), 'capped', 'and the reserve is genuinely enforced');
});
