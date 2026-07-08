import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager } from '../src/account-manager.js';
import { classifyZaiLimit, fetchProviderUsage } from '../src/oauth.js';

const DAY = 24 * 60 * 60 * 1000;

function oauthAM(count = 3) {
  return new AccountManager(
    Array.from({ length: count }, (_, i) => ({
      name: `a${i + 1}`, type: 'oauth',
      accessToken: `t${i + 1}`, refreshToken: `r${i + 1}`, expiresAt: Date.now() + 3600_000,
    })),
    0.90,
  );
}

function mixedAM() {
  return new AccountManager([
    { name: 'a1', type: 'oauth', accessToken: 't1', refreshToken: 'r1', expiresAt: Date.now() + 3600_000 },
    { name: 'glm-fallback', type: 'provider', provider: 'zai', authToken: 'zt', upstream: 'https://api.z.ai/api/anthropic' },
    { name: 'kimi-fallback', type: 'provider', provider: 'kimi', authToken: 'kt', upstream: 'https://api.moonshot.ai/anthropic' },
  ], 0.90);
}

// ── THE regression: 90%/critical is NOT "maxed" and is NOT benched ────────────

test('a scoped weekly at 90% with severity:critical is NOT benched (the "Fable maxed" bug)', () => {
  const am = oauthAM(2);
  // Exactly max@dubner's live state: Fable 90%, Anthropic-labelled critical, active.
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.90, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const a1 = am.accounts[0];

  assert.equal(am._scopedExhausted(a1, 'claude-fable-5'), null, '90% has headroom — must NOT bench');
  assert.equal(am._isAvailable(a1, { allowWeeklyReserve: true, model: 'claude-fable-5' }), true, 'Fable still served at 90%');
});

test('the SAME predicate benches at genuine exhaustion (>= 0.985) and on a real 429 (util:1)', () => {
  const am = oauthAM(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.99, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  assert.ok(am._scopedExhausted(am.accounts[0], 'claude-fable-5'), '99% is exhausted → benched');

  const am2 = oauthAM(2);
  am2.markRateLimited(0, 3600, { modelScope: 'fable', status: 429 }); // util:1
  assert.ok(am2._scopedExhausted(am2.accounts[0], 'claude-fable-5'), 'a real 429 (util:1) still benches');
});

test('just below exhaustion (0.98) is still not benched — only >= 0.985', () => {
  const am = oauthAM(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.98, severity: 'critical', isActive: true, resetAt: Date.now() + DAY } } });
  assert.equal(am._scopedExhausted(am.accounts[0], 'claude-fable-5'), null);
});

// ── sticky reactive-429 across a probe refresh (prevents the 60s flap) ────────

test('a reactive 429 bench is NOT lowered by a lagging probe reporting the pre-429 level', () => {
  const am = oauthAM(2);
  am.markRateLimited(0, 3600, { modelScope: 'fable', status: 429 }); // reactive util:1, resetAt +1h
  // A 60s probe fires and reports Anthropic's real reading (0.96) — the pre-429 level.
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.96, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  const e = am.accounts[0].quota.scopedWeekly.fable;
  assert.equal(e.utilization, 1, 'reactive bench held — probe did not lower it below exhaustion');
  assert.ok(am._scopedExhausted(am.accounts[0], 'claude-fable-5'), 'still benched (no un-bench → no re-429 flap)');
});

test('a probe that OMITS the reactively-benched family does not drop the bench', () => {
  const am = oauthAM(2);
  am.markRateLimited(0, 3600, { modelScope: 'fable', status: 429 });
  am.applyUsageData(0, { scopedWeekly: { opus: { utilization: 0.2, severity: 'normal', isActive: true, resetAt: Date.now() + DAY } } });
  assert.ok(am.accounts[0].quota.scopedWeekly.fable, 'fable bench survived a probe that omitted it');
  assert.ok(am._scopedExhausted(am.accounts[0], 'claude-fable-5'));
});

test('a probe CONFIRMING >= reactive level is taken (fresh reading wins when it agrees)', () => {
  const am = oauthAM(2);
  am.markRateLimited(0, 3600, { modelScope: 'fable', status: 429 });
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 1, severity: 'critical', isActive: true, resetAt: Date.now() + 5 * DAY } } });
  const e = am.accounts[0].quota.scopedWeekly.fable;
  assert.equal(e.utilization, 1);
  assert.ok(!e.reactive, 'probe-confirmed entry drops the reactive latch (a later real drop can now lower it)');
});

test('a reactive bench self-clears at its resetAt even if probes keep it alive', () => {
  const am = oauthAM(2);
  am.markRateLimited(0, 1, { modelScope: 'fable', status: 429 }); // resetAt ~ now+1s
  am.accounts[0].quota.scopedWeekly.fable.resetAt = Date.now() - 1000; // simulate elapsed
  am.refreshExpiredQuotas();
  assert.equal(am.accounts[0].quota.scopedWeekly.fable, undefined, 'expired reactive bench removed');
});

// ── provider quota goes to SEPARATE fields, never the OAuth gates ─────────────

test('applyProviderUsage writes ONLY provider* fields (never unified*/scopedWeekly)', () => {
  const am = mixedAM();
  am.applyProviderUsage(1, {
    source: 'zai',
    ses: { utilization: 0.42, resetAt: Date.now() + 3600_000 },
    wk: { utilization: 0.61, resetAt: Date.now() + 3 * DAY },
  });
  const q = am.accounts[1].quota;
  assert.equal(q.providerSes, 0.42);
  assert.equal(q.providerWk, 0.61);
  assert.equal(q.providerQuotaSource, 'zai');
  assert.equal(q.unified5h, null, 'must NOT pollute the OAuth 5h gate');
  assert.equal(q.unified7d, null, 'must NOT pollute the OAuth 7d gate');
  assert.deepEqual(q.scopedWeekly, {}, 'must NOT write scopedWeekly');
  assert.ok(q.lastProbeOkAt > 0, 'stamps freshness');
});

test('applyProviderUsage clears a weekly that dropped out of the response', () => {
  const am = mixedAM();
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.4, resetAt: Date.now() + 1000 }, wk: { utilization: 0.6, resetAt: Date.now() + DAY } });
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.5, resetAt: Date.now() + 1000 } }); // no wk
  assert.equal(am.accounts[1].quota.providerWk, null, 'stale weekly cleared when plan/window has none');
});

test('Kimi (no pollable quota) records a console-only marker, no fake bars', () => {
  const am = mixedAM();
  am.applyProviderUsage(2, { error: 'unsupported', source: 'console-only' });
  const q = am.accounts[2].quota;
  assert.equal(q.providerQuotaSource, 'console-only');
  assert.equal(q.providerSes, null);
  assert.equal(q.providerWk, null);
});

test('a transient provider probe error does not blank existing bars', () => {
  const am = mixedAM();
  am.applyProviderUsage(1, { source: 'zai', ses: { utilization: 0.4, resetAt: Date.now() + 1000 }, wk: { utilization: 0.6, resetAt: Date.now() + DAY } });
  am.applyProviderUsage(1, { error: 'HTTP 429', status: 429 });
  assert.equal(am.accounts[1].quota.providerSes, 0.4, 'last-known Ses retained through a transient failure');
});

// ── freshness / staleness ─────────────────────────────────────────────────────

test('_quotaProbeStale: off when probe disabled, false when fresh, true past 2x interval', () => {
  const am = oauthAM(1);
  const a = am.accounts[0];

  am.quotaProbeIntervalMs = 0; // probe off
  a.quota.lastProbeOkAt = Date.now() - 10 * 60_000;
  assert.equal(am._quotaProbeStale(a), false, 'probe off → nothing to be stale against');

  am.quotaProbeIntervalMs = 60_000;
  a.quota.lastProbeOkAt = Date.now() - 30_000;
  assert.equal(am._quotaProbeStale(a), false, 'probed 30s ago → fresh');

  a.quota.lastProbeOkAt = Date.now() - 5 * 60_000;
  assert.equal(am._quotaProbeStale(a), true, 'probed 5m ago with a 60s cadence → stale');

  a.quota.lastProbeOkAt = null;
  assert.equal(am._quotaProbeStale(a), false, 'never probed (startup) → "no data", not "stale"');
});

test('applyUsageData stamps lastProbeOkAt (freshness confirmed on every successful probe)', () => {
  const am = oauthAM(1);
  assert.equal(am.accounts[0].quota.lastProbeOkAt, null);
  am.applyUsageData(0, { sevenDay: { utilization: 0.5, resetAt: Date.now() + DAY } });
  assert.ok(am.accounts[0].quota.lastProbeOkAt > 0);
});

// ── soft scoped-weekly de-preference (judge-endorsed; no hard bench) ──────────

test('_scopedScarcity: 0 below reserve, positive when high, 0 for a model with no cap', () => {
  const am = oauthAM(1);
  const a = am.accounts[0];
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.90, severity: 'critical', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  assert.ok(am._scopedScarcity(a, 'claude-fable-5') > 0, 'Fable 90% → positive de-preference');
  assert.equal(am._scopedScarcity(a, 'claude-opus-4-8'), 0, 'Opus has no scoped cap → 0');

  const am2 = oauthAM(1);
  am2.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.50, severity: 'normal', isActive: true, resetAt: Date.now() + 3 * DAY } } });
  assert.equal(am2._scopedScarcity(am2.accounts[0], 'claude-fable-5'), 0, '50% is below reserve → no steering');
});

test('a high-Fable account is scored worse for Fable but unchanged for Opus (soft, not benched)', () => {
  const am = oauthAM(2);
  am.applyUsageData(0, { scopedWeekly: { fable: { utilization: 0.92, severity: 'critical', isActive: true, resetAt: Date.now() + 4 * DAY } } });
  const hi = am.accounts[0], lo = am.accounts[1];

  const fableHi = am._scoreAccount(hi, { model: 'claude-fable-5', weight: 1 });
  const fableLo = am._scoreAccount(lo, { model: 'claude-fable-5', weight: 1 });
  assert.ok(fableHi > fableLo, 'Fable requests de-prefer the high-Fable account');

  const opusHi = am._scoreAccount(hi, { model: 'claude-opus-4-8', weight: 1 });
  const opusLo = am._scoreAccount(lo, { model: 'claude-opus-4-8', weight: 1 });
  assert.equal(opusHi, opusLo, 'Opus is unaffected by a Fable cap');

  // Still ELIGIBLE for Fable — de-preference is soft, not a bench.
  assert.equal(am._isAvailable(hi, { allowWeeklyReserve: true, model: 'claude-fable-5' }), true);
});

// ── z.ai envelope parsing ─────────────────────────────────────────────────────

test('classifyZaiLimit maps TOKENS_LIMIT to Ses/Wk and ignores TIME_LIMIT', () => {
  const now = Date.now();
  // The exact live entries observed from api.z.ai.
  const ses = classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: now + 3600_000 }, now);
  assert.deepEqual(ses, { bucket: 'ses', utilization: 0.42, resetAt: now + 3600_000 });

  const wk = classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 61, nextResetTime: now + 3 * DAY }, now);
  assert.equal(wk.bucket, 'wk');
  assert.equal(wk.utilization, 0.61);

  assert.equal(classifyZaiLimit({ type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1 }, now), null, 'tool-call cap ignored');

  // Unknown unit → classify by reset distance.
  assert.equal(classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 99, percentage: 10, nextResetTime: now + 2 * 3600_000 }, now).bucket, 'ses');
  assert.equal(classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 99, percentage: 10, nextResetTime: now + 5 * DAY }, now).bucket, 'wk');
});

test('fetchProviderUsage parses a live-shaped z.ai envelope; Kimi is console-only', async () => {
  const now = Date.now();
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      code: 200, message: 'Operation successful',
      data: {
        level: 'max',
        limits: [
          { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, nextResetTime: now + 20 * DAY },
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 7, nextResetTime: now + 4 * 3600_000 },
        ],
      },
    }),
  });
  try {
    const u = await fetchProviderUsage({ provider: 'zai', credential: 'zt' });
    assert.equal(u.source, 'zai');
    assert.equal(u.ses.utilization, 0.07);
    assert.equal(u.wk, null, 'weekly absent from this plan → null (no fake bar)');

    const k = await fetchProviderUsage({ provider: 'kimi', credential: 'kt' });
    assert.deepEqual(k, { error: 'unsupported', source: 'console-only' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('an AM-constructed provider account exposes .credential (the probe token hop)', () => {
  // Guards the authToken→credential mapping the prober relies on: fetchProviderUsage
  // reads account.credential, so a future rename of this mapping must go RED here.
  const am = mixedAM();
  assert.equal(am.accounts[1].credential, 'zt', 'zai authToken mapped to credential');
  assert.equal(am.accounts[1].provider, 'zai');
  assert.equal(am.accounts[2].credential, 'kt', 'kimi authToken mapped to credential');
});

test('fetchProviderUsage surfaces an HTTP error as a transient, non-fatal result', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
  try {
    const u = await fetchProviderUsage({ provider: 'zai', credential: 'zt' });
    assert.equal(u.error, 'HTTP 429');
    assert.equal(u.status, 429);
  } finally {
    globalThis.fetch = origFetch;
  }
});
