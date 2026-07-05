import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { modelFamily, parseLimitEntry, normalizeUsageBucket } from '../src/oauth.js';

function manager(count = 5) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`,
      type: 'oauth',
      accessToken: `t${i + 1}`,
      refreshToken: `r${i + 1}`,
      expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

const DAY = 24 * 60 * 60 * 1000;

// ── ingest helpers ────────────────────────────────────────────────────────

test('modelFamily maps request models AND usage display names to a family', () => {
  assert.equal(modelFamily('claude-fable-5'), 'fable');
  assert.equal(modelFamily('Fable'), 'fable');
  assert.equal(modelFamily('claude-opus-4-8'), 'opus');
  assert.equal(modelFamily('claude-sonnet-5'), 'sonnet');
  assert.equal(modelFamily('claude-haiku-4-5'), 'haiku');
  assert.equal(modelFamily('claude-mythos-5'), 'fable'); // Fable's sibling
  assert.equal(modelFamily(''), null);
  assert.equal(modelFamily(undefined), null);
  assert.equal(modelFamily('gpt-4o'), null);
});

test('parseLimitEntry reads percent as 0-100 int (a genuine 1% is 0.01, not 100%)', () => {
  // The exact normalizer-ambiguity bug: normalizeUsageBucket misreads raw 1.
  assert.equal(normalizeUsageBucket({ used_percentage: 1 }).utilization, 1); // legacy heuristic: wrong
  assert.equal(parseLimitEntry({ percent: 1 }).utilization, 0.01);           // limits[] path: correct
  assert.equal(parseLimitEntry({ percent: 100 }).utilization, 1);
  assert.equal(parseLimitEntry({ percent: 56 }).utilization, 0.56);
  assert.equal(parseLimitEntry({ percent: 100, severity: 'critical', is_active: true }).severity, 'critical');
  assert.equal(parseLimitEntry({ percent: 0, is_active: false }).isActive, false);
});

// ── the user's exact symptom: Fable maxed on ONE account, balance elsewhere ──

test('a Fable-capped account is never routed a Fable request but still serves Opus', () => {
  const am = manager(5);
  // a3 has Fable weekly at 100% (critical); every other account has Fable headroom.
  am.applyUsageData(2, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + 2 * DAY } } });

  // 40 Fable requests spread across the fleet — a3 must get ZERO.
  for (let i = 0; i < 40; i++) {
    const lease = am.acquireAccount({ model: 'claude-fable-5', profile: 'claude', weight: 1 });
    assert.ok(lease, 'a Fable request must always find a headroom account');
    assert.notEqual(lease.account.name, 'a3', 'a3 is Fable-capped — must never serve Fable');
    am.releaseAccount(lease, { success: true });
  }

  // The SAME account still serves an Opus request — the cap is per-model, not the account.
  let servedByA3 = false;
  for (let i = 0; i < 40; i++) {
    const lease = am.acquireAccount({ model: 'claude-opus-4-8', profile: 'claude', weight: 1 });
    if (lease.account.name === 'a3') servedByA3 = true;
    am.releaseAccount(lease, { success: true });
  }
  assert.ok(servedByA3, 'a3 has Opus headroom — it must still serve Opus requests');
});

test('_scopedExhausted + _isAvailable gate on the request model only', () => {
  const am = manager(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + DAY } } });
  const a1 = am.accounts[0];

  assert.ok(am._scopedExhausted(a1, 'claude-fable-5'), 'fable is exhausted on a1');
  assert.equal(am._scopedExhausted(a1, 'claude-opus-4-8'), null, 'opus is not');
  assert.equal(am._scopedExhausted(a1, 'claude-fable-5') && am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-fable-5' }), false);
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), true);
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true }), true, 'model-agnostic call fails OPEN');
});

test('an inactive scoped cap (is_active:false) does NOT bench the model', () => {
  const am = manager(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: false, resetAt: Date.now() + DAY } } });
  assert.equal(am._scopedExhausted(am.accounts[0], 'claude-fable-5'), null);
  assert.equal(am._isAvailable(am.accounts[0], { allowWeeklyReserve: true, model: 'claude-fable-5' }), true);
});

// ── per-model rejection must NOT block the account account-wide ─────────────

test('a Fable-only rejection (unified-status:rejected, unified healthy) does NOT bench the account for other models', () => {
  const am = manager(2);
  // Fable is capped (scoped) AND Anthropic returned unified-status:rejected on the
  // Fable 429 — but the unified weekly is only 72%. This must NOT block the account.
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + DAY } } });
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '0.72',
    'anthropic-ratelimit-unified-5h-utilization': '0',
  });
  const a1 = am.accounts[0];

  assert.equal(am._isAccountWideRejected(a1), false, 'a per-model rejection is NOT account-wide');
  assert.notEqual(am._weeklyRawState(a1), 'exhausted', '72% weekly must not read as exhausted');
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), true, 'Opus still served');
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-fable-5' }), false, 'Fable still benched (scoped)');
});

test('a GENUINE account-wide rejection (rejected + unified exhausted) still blocks everything', () => {
  const am = manager(2);
  am.updateQuota(0, {
    'anthropic-ratelimit-unified-status': 'rejected',
    'anthropic-ratelimit-unified-7d-utilization': '0.99',
  });
  const a1 = am.accounts[0];
  assert.equal(am._isAccountWideRejected(a1), true);
  assert.equal(am._weeklyRawState(a1), 'exhausted');
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), false);
});

test('a restored stale per-model rejected (low unified) is treated as NOT account-wide', () => {
  // The exact post-restart symptom: persisted unifiedStatus:rejected + low unified.
  const am = manager(1);
  am.accounts[0].quota.unifiedStatus = 'rejected';
  am.accounts[0].quota.unified7d = 0.72;
  am.accounts[0].quota.unified7dReset = Date.now() + DAY;
  assert.equal(am._isAccountWideRejected(am.accounts[0]), false);
  assert.equal(am._isAvailable(am.accounts[0], { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), true);
});

// ── oracle/selection consistency (no spin-loop) ─────────────────────────────

test('all accounts Fable-capped: oracle holds finite for Fable, Opus still routes', () => {
  const am = manager(3);
  for (let i = 0; i < 3; i++) {
    am.applyUsageData(i, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + DAY } } });
  }
  // Fable: selection returns null AND the oracle agrees with a FINITE weekly reset
  // (the desync the pre-mortem flagged would make one spin while the other stalls).
  assert.equal(am.getActiveAccount({ model: 'claude-fable-5', profile: 'claude' }), null);
  const retry = am.nextRetryForRequest({ model: 'claude-fable-5', profile: 'claude' });
  assert.equal(retry.available, false);
  assert.equal(retry.cause, 'weekly_exhausted');
  assert.ok(Number.isFinite(retry.retryAfterMs) && retry.retryAfterMs > 0, 'finite hold, never Infinity/spin');
  // Opus has fleet-wide headroom — it routes immediately.
  assert.ok(am.getActiveAccount({ model: 'claude-opus-4-8', profile: 'claude' }));
});

// ── reactive half of D: markRateLimited modelScope ──────────────────────────

test('markRateLimited modelScope benches only the model, not the account', () => {
  const am = manager(2);
  am.markRateLimited(0, 3600, { modelScope: 'fable', status: 429 });
  const a1 = am.accounts[0];

  assert.notEqual(a1.status, 'throttled', 'account must NOT be globally benched');
  assert.equal(a1.rateLimitedUntil, null, 'no account-wide cooldown');
  assert.ok(a1.quota.scopedWeekly.fable, 'fable scoped bench recorded');
  assert.ok(a1.quota.scopedWeekly.fable.resetAt > Date.now());
  assert.ok(am._scopedExhausted(a1, 'claude-fable-5'));
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-fable-5' }), false);
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), true);
});

test('a model-scoped 429 does not poison the account failure counters / scoring', () => {
  const am = manager(2);
  const lease = am.acquireAccount({ model: 'claude-fable-5', profile: 'claude', weight: 1 });
  am.markRateLimited(lease.account.index, 3600, { modelScope: 'fable', status: 429 });
  am.releaseAccount(lease, { status: 429, error: 'model_rate_limited' });
  const a = am.accounts[lease.account.index];
  assert.equal(a.consecutiveFailures, 0, 'a per-model cap is not an account failure');
  assert.equal(a.failedRequests, 0);
});

// ── expiry ──────────────────────────────────────────────────────────────────

test('a scoped cap past its reset is cleared on refresh', () => {
  const am = manager(1);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() - 1000 } } });
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].quota.scopedWeekly.fable, undefined, 'expired scoped cap removed');
  assert.equal(am._isAvailable(am.accounts[0], { allowWeeklyReserve: true, model: 'claude-fable-5' }), true);
});

// ── persistence round-trip + restore guard ──────────────────────────────────

test('scopedWeekly survives export/restore; a reset-less restored entry is dropped', () => {
  const am = manager(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + DAY } } });
  // Inject a reset-less entry that must NOT survive restore (can't be expired).
  am.accounts[1].quota.scopedWeekly = { opus: { utilization: 1, severity: 'critical', isActive: true, resetAt: null } };

  const saved = JSON.parse(JSON.stringify(am.exportQuotaState()));
  const am2 = manager(2);
  am2.restoreQuotaState(saved);

  assert.ok(am2.accounts[0].quota.scopedWeekly.fable, 'fable cap with a reset restored');
  assert.equal(am2.accounts[1].quota.scopedWeekly.opus, undefined, 'reset-less cap dropped on restore');
  assert.equal(am2._isAvailable(am2.accounts[1], { allowWeeklyReserve: true, model: 'claude-opus-4-8' }), true);
});
