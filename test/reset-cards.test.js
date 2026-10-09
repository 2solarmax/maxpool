import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardExpiry, listResetCards, redeemResetCard } from '../src/zai-reset-cards.js';
import { decideZai, decideClaude } from '../src/reset-policy.js';

const H = 3600_000;
const DAY = 24 * H;
const soon = (ms) => Date.now() + ms;

function acct({ ses, wk, weeklyAbsent = false, enabled = true } = {}) {
  return { name: 't', enabled, quota: { providerSes: ses, providerWk: wk, weeklyAbsent, unified5h: ses, unified7d: wk } };
}

// ── expiry parsing ────────────────────────────────────────────────────────────
test('parseCardExpiry reads z.ai timestamps as Beijing time (UTC+8)', () => {
  const t = parseCardExpiry('2026-10-01 23:59:59');
  assert.equal(t, Date.UTC(2026, 9, 1, 15, 59, 59), '23:59:59 Beijing = 15:59:59 UTC');
  assert.equal(parseCardExpiry('garbage'), null);
  assert.equal(parseCardExpiry(null), null);
});

// ── R0: the owner's enabled gate ──────────────────────────────────────────────
test('R0: a DISABLED account never redeems — even at the wall with a dying card', () => {
  const cards = { weekly: [{ recordId: 1, expiresAt: soon(2 * H), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.99, enabled: false }), cards), null);
  const grants = { grants: [grant({ endsAt: soon(2 * H) })], eligible: true, nextGrantId: null, cooldownUntil: null };
  assert.equal(decideClaude(acct({ wk: 0.99, enabled: false }), grants), null);
});

// ── R1: at-the-wall ───────────────────────────────────────────────────────────
test('R1: weekly card fires at 90% weekly', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] };
  const act = decideZai(acct({ wk: 0.91, ses: 0.2 }), cards);
  assert.equal(act?.card?.recordId, 9);
  assert.equal(act?.resetType, 'WEEK');
  assert.equal(act?.reason, 'weekly at wall');
});

test('R1: below the wall does NOT fire (save the card)', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.5 }), cards), null);
});

test('R1: 5h card only used at the 5h wall when no weekly card exists (R4)', () => {
  const cards = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  const act = decideZai(acct({ wk: 0.2, ses: 0.96 }), cards);
  assert.equal(act?.resetType, 'FIVE_HOUR');
  // with a weekly card available, the 5h wall does NOT spend it — the weekly card
  // clears both windows and will handle the bigger problem
  const both = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }],
                 fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  const act2 = decideZai(acct({ wk: 0.2, ses: 0.96 }), both);
  assert.equal(act2, null, 'weekly card at low weekly util + 5h wall = wait');
});

// ── R2: dying value ───────────────────────────────────────────────────────────
test('R2: card expiring <24h fires even BELOW the wall (value evaporates)', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(2 * H), expired: false }], fiveHour: [] };
  const act = decideZai(acct({ wk: 0.45, ses: 0.3 }), cards);
  assert.equal(act?.reason, 'dying value');
});

test('R2: dying card does NOT fire at trivial utilization (refill buys nothing)', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(2 * H), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.05, ses: 0.01 }), cards), null);
});

test('R3: expired cards are never chosen', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(-1 * H), expired: true }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.99 }), cards), null);
});

// ── Claude grants ─────────────────────────────────────────────────────────────
function grant({ endsAt = soon(20 * DAY), resetsLeft = 1, usableNow = true, paused = false, requiresLimit = false, clears = ['five_hour', 'seven_day'] } = {}) {
  return { id: 'g1', resetsLeft, resetsTotal: resetsLeft, endsAt, startsAt: null, usableNow: usableNow, paused, requiresLimit, clears, label: null, expired: endsAt <= Date.now() };
}

test('claude: weekly-clearing grant fires at weekly wall', () => {
  const g = grant();
  const act = decideClaude(acct({ wk: 0.92 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null });
  assert.equal(act?.grant?.id, 'g1');
});

test('claude: requiresLimit grant is NOT spent on dying value pre-wall', () => {
  const g = grant({ endsAt: soon(2 * H), requiresLimit: true });
  assert.equal(decideClaude(acct({ wk: 0.4 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null }), null);
});

test('claude: no-requirement grant IS spent on dying value', () => {
  const g = grant({ endsAt: soon(2 * H), requiresLimit: false });
  const act = decideClaude(acct({ wk: 0.4 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null });
  assert.equal(act?.reason, 'dying value');
});

test('claude: cooldown blocks; spent grants (resets_left 0) dropped upstream', () => {
  const g = grant();
  const cooled = { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: soon(H) };
  assert.equal(decideClaude(acct({ wk: 0.95 }), cooled), null);
});

test('claude: honors nextGrantId when server names one', () => {
  const a = grant(); const b = { ...grant(), id: 'g2' };
  const act = decideClaude(acct({ wk: 0.95 }), { grants: [a, b], eligible: true, nextGrantId: 'g2', cooldownUntil: null });
  assert.equal(act.grant.id, 'g2');
});

// ── idempotency of the redeem wire format ─────────────────────────────────────
test('redeemResetCard rejects invalid resetType without a network call', async () => {
  const r = await redeemResetCard('tok', 1, 'WEEKLY');
  assert.equal(r.ok, false);
  assert.match(r.error, /invalid resetType/);
});

test('listResetCards without a token returns an error, never throws', async () => {
  const r = await listResetCards(null);
  assert.ok(r.error);
});

// ── Claude claim org resolution (2026-10-09: personal accounts return organization, singular) ──
test('claim org: profile.organization.uuid wins; plural array is the fallback', async () => {
  const { claimResetGrant } = await import('../src/claude-reset-grants.js');
  const seen = [];
  const fakeFetch = async (url, opts) => {
    seen.push(url);
    if (url.endsWith('/api/oauth/profile')) return { ok: true, json: async () => ({ account: { uuid: 'acc' }, organization: { uuid: 'org-singular' } }) };
    return { ok: true, status: 200, json: async () => ({ result: 'reset', reset: true }) };
  };
  const r = await claimResetGrant('tok', 'g1', { fetchImpl: fakeFetch });
  assert.match(seen[1], /\/api\/organizations\/org-singular\/reset_rate_limits$/, 'claimed against the SINGULAR org');
  // plural-only shape still resolves
  seen.length = 0;
  const fakeFetch2 = async (url, opts) => {
    seen.push(url);
    if (url.endsWith('/api/oauth/profile')) return { ok: true, json: async () => ({ organizations: [{ uuid: 'org-plural' }] }) };
    return { ok: true, status: 200, json: async () => ({ result: 'reset', reset: true }) };
  };
  await claimResetGrant('tok', 'g1', { fetchImpl: fakeFetch2 });
  assert.match(seen[1], /\/api\/organizations\/org-plural\//, 'plural fallback intact');
});
