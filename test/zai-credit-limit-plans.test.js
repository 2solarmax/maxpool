import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyZaiLimit } from '../src/oauth.js';

// z.ai names a plan's consumption cap differently per plan generation:
//   older coding plans → TOKENS_LIMIT
//   newer coding plans → CREDIT_LIMIT
// Both carry the same percentage/nextResetTime/unit fields. Accepting only
// TOKENS_LIMIT left a CREDIT_LIMIT account with NO quota reading, so the TUI showed
// "probing" forever while the poll was actually succeeding.
//
// Captured live 2026-08-07 from two real accounts on the same `max` plan level.

const HOUR = 3600_000;
const NOW = 1_786_100_000_000;

test('CREDIT_LIMIT is read as a consumption window (the reported "stuck probing" bug)', () => {
  // The exact shape the newly-provisioned account returned.
  const ses = classifyZaiLimit({ type: 'CREDIT_LIMIT', unit: 3, percentage: 5, nextResetTime: NOW + 4.5 * HOUR }, NOW);
  assert.ok(ses, 'CREDIT_LIMIT must classify — returning null is the bug');
  assert.equal(ses.bucket, 'ses');
  assert.equal(ses.utilization, 0.05);

  const wk = classifyZaiLimit({ type: 'CREDIT_LIMIT', unit: 6, percentage: 1, nextResetTime: NOW + 167.5 * HOUR }, NOW);
  assert.ok(wk);
  assert.equal(wk.bucket, 'wk');
  assert.equal(wk.utilization, 0.01);
});

test('TOKENS_LIMIT still classifies (the older plan must not regress)', () => {
  const ses = classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 3, percentage: 10, nextResetTime: NOW + 3 * HOUR }, NOW);
  assert.ok(ses);
  assert.equal(ses.bucket, 'ses');
  assert.equal(ses.utilization, 0.10);
});

test('TIME_LIMIT is still ignored — it is a tool-call cap, not a token/credit window', () => {
  // Counting it would render a web-search allowance as if it were model quota.
  assert.equal(classifyZaiLimit({ type: 'TIME_LIMIT', unit: 5, percentage: 1, nextResetTime: NOW + 500 * HOUR }, NOW), null);
});

test('an unknown limit type is ignored rather than guessed', () => {
  assert.equal(classifyZaiLimit({ type: 'SOMETHING_NEW', unit: 3, percentage: 50 }, NOW), null);
  assert.equal(classifyZaiLimit(null, NOW), null);
  assert.equal(classifyZaiLimit({}, NOW), null);
});

test('an unfamiliar unit falls back to reset-distance for TOKENS_LIMIT only', () => {
  // Pre-existing behaviour for the older type, kept. CREDIT_LIMIT deliberately does
  // NOT inherit it — see the C1 test below for why.
  const near = classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 99, percentage: 20, nextResetTime: NOW + 3 * HOUR }, NOW);
  assert.equal(near.bucket, 'ses', 'a soon reset is the session window');
  const far = classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 99, percentage: 20, nextResetTime: NOW + 100 * HOUR }, NOW);
  assert.equal(far.bucket, 'wk', 'a distant reset is the weekly window');
});

test('a missing/unparseable percentage yields null utilization, never a fake 0%', () => {
  // clamp01(NaN)=0 downstream would render a blind account as "0% used = fully
  // available" and route real traffic onto quota we cannot see.
  const r = classifyZaiLimit({ type: 'CREDIT_LIMIT', unit: 3, nextResetTime: NOW + HOUR }, NOW);
  assert.equal(r.utilization, null);
});

// ── hardening the widened type set (red-team C1/C2/C3) ───────────────────────

test('C1: CREDIT_LIMIT with an UNKNOWN unit is refused, not guessed by reset-distance', () => {
  // unit 5 is z.ai's monthly TOOL-call cap. If it were ever reported as CREDIT_LIMIT,
  // the reset-distance fallback would render a web-search allowance as MODEL quota.
  assert.equal(classifyZaiLimit({ type: 'CREDIT_LIMIT', unit: 5, percentage: 88, nextResetTime: NOW + 480 * HOUR }, NOW), null);
  assert.equal(classifyZaiLimit({ type: 'CREDIT_LIMIT', unit: 99, percentage: 50, nextResetTime: NOW + 3 * HOUR }, NOW), null);
  // But the OLDER type keeps its fallback — that behaviour predates this change.
  assert.equal(classifyZaiLimit({ type: 'TOKENS_LIMIT', unit: 99, percentage: 50, nextResetTime: NOW + 3 * HOUR }, NOW).bucket, 'ses');
});

test('C3: a CREDIT_LIMIT with no unit and no resetAt is refused rather than defaulted', () => {
  assert.equal(classifyZaiLimit({ type: 'CREDIT_LIMIT', percentage: 50 }, NOW), null);
});

test('C2: two entries in the SAME bucket keep the WORSE (higher) utilization', async () => {
  // Last-wins was optimistic: 95% then 4% reported 4% — an account at its cap looked
  // nearly empty. Drives the real fetchProviderUsage against a stubbed transport.
  const { fetchProviderUsage } = await import('../src/oauth.js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: 200, data: { level: 'max', limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 95, nextResetTime: NOW + HOUR },
      { type: 'CREDIT_LIMIT', unit: 3, percentage: 4, nextResetTime: NOW + HOUR },
    ] } }),
  });
  try {
    const u = await fetchProviderUsage({ provider: 'zai', credential: 'k', type: 'provider' });
    assert.equal(u.ses.utilization, 0.95, 'the account is at 95%, not 4%');
  } finally { globalThis.fetch = real; }
});

test('C2: a null utilization never displaces a real reading', async () => {
  const { fetchProviderUsage } = await import('../src/oauth.js');
  const real = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true, status: 200,
    json: async () => ({ code: 200, data: { level: 'max', limits: [
      { type: 'TOKENS_LIMIT', unit: 3, percentage: 42, nextResetTime: NOW + HOUR },
      { type: 'CREDIT_LIMIT', unit: 3, nextResetTime: NOW + HOUR },   // no percentage
    ] } }),
  });
  try {
    const u = await fetchProviderUsage({ provider: 'zai', credential: 'k', type: 'provider' });
    assert.equal(u.ses.utilization, 0.42, 'the readable entry wins over the blind one');
  } finally { globalThis.fetch = real; }
});
