import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardExpiry, listResetCards, redeemResetCard } from '../src/zai-reset-cards.js';
import { decideZai, decideClaude, POLICY, LAST_RESORT_REASON } from '../src/reset-policy.js';

const H = 3600_000;
const DAY = 24 * H;
const soon = (ms) => Date.now() + ms;

function acct({ ses, wk, weeklyAbsent = false, enabled = true } = {}) {
  // C1 freshness prerequisites: a claim only fires on a probe-fresh reading whose
  // weekly window has not rolled (CLAIM_FRESH_MS / unified7dReset gates, 2026-11-10).
  return { name: 't', enabled, quota: { providerSes: ses, providerWk: wk, weeklyAbsent,
    unified5h: ses, unified7d: wk, unified7dReset: Date.now() + 3 * DAY, lastProbeOkAt: Date.now() } };
}

// ── expiry parsing ────────────────────────────────────────────────────────────
test('parseCardExpiry reads z.ai timestamps as Beijing time (UTC+8)', () => {
  const t = parseCardExpiry('2026-10-01 23:59:59');
  assert.equal(t, Date.UTC(2026, 9, 1, 15, 59, 59), '23:59:59 Beijing = 15:59:59 UTC');
  assert.equal(parseCardExpiry('garbage'), null);
  assert.equal(parseCardExpiry(null), null);
});

// ── R0: the owner's enabled gate ──────────────────────────────────────────────
test('R0: a DISABLED account never redeems — even at 100% with a card in its last hours', () => {
  const cards = { weekly: [{ recordId: 1, expiresAt: soon(2 * H), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 1, enabled: false }), cards), null);
  const grants = { grants: [grant({ endsAt: soon(2 * H) })], eligible: true, nextGrantId: null, cooldownUntil: null };
  assert.equal(decideClaude(acct({ wk: 1, enabled: false }), grants), null);
});

// ── R1: at-the-limit ──────────────────────────────────────────────────────────
test('R1: weekly card fires only at 100% weekly (owner 2026-11-27: nothing before fully used)', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] };
  // Was 0.90: a card was spent with up to 10% of the week left.
  for (const wk of [0.91, 0.95, 0.99, 0.999]) assert.equal(decideZai(acct({ wk, ses: 0.2 }), cards), null, `${wk}: card kept`);
  const act = decideZai(acct({ wk: 1, ses: 0.2 }), cards);
  assert.equal(act?.card?.recordId, 9);
  assert.equal(act?.resetType, 'WEEK');
  assert.equal(act?.reason, 'weekly at wall');
});

test('R1: an expiring card is NOT spent below 100% until its last 30 minutes', () => {
  // Owner, 2026-11-28 (replacing the 24h "dying value" window and the 2-hour proposal:
  // "Why two hours and not 30 minutes or 10 minutes?"): expiry is a reason to spend below
  // 100% only inside POLICY.lastResortMs, and only with the week at least 30% used.
  assert.equal(POLICY.lastResortMs, 30 * 60_000);
  for (const left of [31 * 60_000, 2 * H, 12 * H, 23 * H]) {
    const cards = { weekly: [{ recordId: 9, expiresAt: soon(left), expired: false }], fiveHour: [] };
    for (const wk of [0.05, 0.30, 0.45, 0.80, 0.99, 0.999]) {
      assert.equal(decideZai(acct({ wk, ses: 0.3 }), cards), null, `card dying in ${left / H}h at weekly ${wk}: kept`);
    }
    // The same expiring card at 100% is spent.
    assert.equal(decideZai(acct({ wk: 1, ses: 0.3 }), cards)?.reason, 'weekly at wall', `card dying in ${left / H}h at 100%: spent`);
  }
});

test('R1: LAST RESORT — inside its last 30 minutes a card is spent from 30% used, unless the free refill lands first', () => {
  for (const left of [1 * 60_000, 20 * 60_000, 30 * 60_000]) {
    const cards = { weekly: [{ recordId: 9, expiresAt: soon(left), expired: false }], fiveHour: [] };
    for (const wk of [0.30, 0.45, 0.80, 0.999]) {
      assert.equal(decideZai(acct({ wk, ses: 0.3 }), cards)?.reason, LAST_RESORT_REASON, `${left / 60_000} min left at ${wk}: spent`);
    }
    // Under 30% used the card buys too little: kept.
    assert.equal(decideZai(acct({ wk: 0.29, ses: 0.3 }), cards), null, `${left / 60_000} min left at 29%: kept`);
    // A free refill BEFORE the card expires makes it worthless: kept.
    const refillFirst = acct({ wk: 0.8, ses: 0.3 });
    refillFirst.quota.providerWkReset = soon(left / 2);
    assert.equal(decideZai(refillFirst, cards), null, 'the free refill lands first: kept');
    // A last-resort spend is never held for the free refill by spare accounts.
    assert.equal(decideZai(acct({ wk: 0.8, ses: 0.3 }), cards, Date.now(), { peersWithRoom: () => 5 })?.reason, LAST_RESORT_REASON);
  }
  // A five-hour card is never a last resort: only a full five-hour window spends it.
  const fiveHour = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(10 * 60_000), expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.5, ses: 0.9 }), fiveHour), null);
});

test('R1: below the wall does NOT fire (save the card)', () => {
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.5 }), cards), null);
});

// ── 5-hour cards (owner 2026-11-27: "it's okay to spend 5-hour cards too") ───────
// This REPLACES the 2026-10-30 "never spent" rule. EXACT LIMIT applies to them too: a
// DEDICATED five-hour card is spent only once the 5h window has reached its own limit
// (it serves to 100%, so the limit is 100%) — never at a routine 96/99/90% — and never
// on an account that is blocked for some other reason (the card would lift nothing).
test('5h card: spent ONLY once the 5h window has reached its limit (100%)', () => {
  const cards = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  for (const ses of [0.50, 0.90, 0.95, 0.96, 0.99, 0.999]) {
    assert.equal(decideZai(acct({ wk: 0.2, ses }), cards), null, `session at ${ses}: below the limit, nothing spent`);
  }
  const act = decideZai(acct({ wk: 0.2, ses: 1 }), cards);
  assert.equal(act?.resetType, 'FIVE_HOUR', 'the 5h limit is reached');
  assert.equal(act?.card?.recordId, 5);
  assert.equal(act?.reason, 'session at limit');
});

test('5h card: a DEDICATED card for the session limit — the weekly card is never spent for it, and vice versa', () => {
  const onlyWeekly = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 1 }), onlyWeekly), null,
    'session at its limit, no 5h card: the WEEKLY card is kept (owner 2026-10-30, weekly never spent for a session limit)');
  // Both held, weekly NOT at its wall, session at its limit: the 5h card goes, the weekly stays.
  const both = { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }],
    fiveHour: [{ recordId: 6, expiresAt: soon(20 * DAY), expired: false }] };
  const act = decideZai(acct({ wk: 0.5, ses: 1 }), both);
  assert.equal(act?.resetType, 'FIVE_HOUR', 'the dedicated card clears the session limit');
  assert.equal(act?.card?.recordId, 6);
  // R4 (order) still holds: the weekly card at ITS limit clears BOTH windows, so it goes
  // first even when the session is also at its limit.
  const atWeeklyWall = decideZai(acct({ wk: 1, ses: 1 }), both);
  assert.equal(atWeeklyWall?.resetType, 'WEEK', 'the weekly card clears both, so it goes first');
  assert.equal(atWeeklyWall?.card?.recordId, 9);
});

test('5h card: NEVER while the weekly window is full (owner, final contract 2026-11-27)', () => {
  // A session-only card cannot clear a full weekly limit: the account stays blocked by
  // its week, so the card would lift nothing. It waits for the weekly refill or a
  // weekly card, even when the 5h window is also at 100% and the card is about to expire.
  const only5h = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  const dying5h = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(1 * H), expired: false }] };
  for (const cards of [only5h, dying5h]) {
    for (const wkReset of [null, Date.now() + 30 * H, Date.now() + 5 * DAY]) {
      const a = acct({ wk: 1, ses: 1 });
      a.quota.providerWkReset = wkReset;
      assert.equal(decideZai(a, cards), null, `weekly 100% (refill ${wkReset == null ? 'unknown' : 'in ' + Math.round((wkReset - Date.now()) / H) + 'h'}): the 5h card is kept`);
    }
  }
  // A 5h reading whose own window already rolled over is stale (the window is refilling
  // right now): the card is not spent on it either.
  const rolled = acct({ wk: 0.2, ses: 1 });
  rolled.quota.providerSesReset = Date.now() - 60_000;
  assert.equal(decideZai(rolled, only5h), null, 'the 5h window already rolled over: its 100% reading is stale, the card is kept');
  // Control: the same reading with the window still running spends the card.
  const live = acct({ wk: 0.2, ses: 1 });
  live.quota.providerSesReset = Date.now() + 2 * H;
  assert.equal(decideZai(live, only5h)?.resetType, 'FIVE_HOUR');
});

test('5h card: never spent on an account blocked for ANOTHER reason (it would lift nothing)', () => {
  const cards = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  const at = extra => decideZai({ ...acct({ wk: 0.2, ses: 1 }), ...extra }, cards);
  assert.equal(at({})?.resetType, 'FIVE_HOUR', 'control: the session limit alone spends it');
  assert.equal(at({ poolBenchedBy: 'cloud' }), null, 'benched to another pool');
  assert.equal(at({ subscriptionGone: true }), null, 'out of plan');
  assert.equal(at({ refreshDead: true }), null, 'dead credential');
  assert.equal(at({ enabled: false }), null, 'disabled (R0)');
  assert.equal(at({ outsideUsage: { outside: true } }), null, 'key used outside the pool (R7)');
});

test('5h card: not on a dying basis, and expired/undated cards are handled', () => {
  // Expiry is never a reason to spend (owner, final contract 2026-11-27): a 5h card in
  // its last hours is kept below 100% exactly like any other card.
  const dying = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(2 * H), expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 0.9 }), dying), null, 'dying 5h card below the limit: not spent');
  assert.equal(decideZai(acct({ wk: 0.2, ses: 1 }), dying)?.resetType, 'FIVE_HOUR', 'at the limit it is spent, dying or not');
  // An expired 5h card is never chosen (R3).
  const expired = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(-1 * H), expired: true }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 1 }), expired), null);
  // A card with no expiry date (null) is live and sorts after dated ones.
  const undated = { weekly: [], fiveHour: [{ recordId: 7, expiresAt: null, expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 1 }), undated)?.card?.recordId, 7);
  // Soonest-expiring first when two are held (R4).
  const two = { weekly: [], fiveHour: [{ recordId: 8, expiresAt: soon(9 * DAY), expired: false },
    { recordId: 3, expiresAt: soon(2 * DAY), expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 1 }), two)?.card?.recordId, 3, 'soonest expiry is spent first');
});

// ── R2 (REMOVED, owner 2026-11-27): expiry is never a reason to spend ──────────
test('R2 (removed): a card expiring in 2h is NOT spent on a partially used account', () => {
  // Was "dying value": the card below was redeemed at 45% of the week used because it
  // would expire in 2h. The owner's final contract: nothing below 100%, expiring or not.
  const cards = { weekly: [{ recordId: 9, expiresAt: soon(2 * H), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 0.45, ses: 0.3 }), cards), null, 'kept: 45% used is not 100%');
  // An already-expired card is never chosen either, at any level (R3).
  const expired = { weekly: [{ recordId: 9, expiresAt: soon(-1 * H), expired: false }], fiveHour: [] };
  assert.equal(decideZai(acct({ wk: 1, ses: 0.3 }), expired), null, 'an expired card is dropped by its expiry date, even unflagged');
  assert.equal(decideZai(acct({ wk: 1, ses: 0.3 }), { weekly: [{ recordId: 9, expiresAt: soon(-1 * H), expired: true }], fiveHour: [] }), null);
});

// ── Claude grants ─────────────────────────────────────────────────────────────
function grant({ endsAt = soon(20 * DAY), resetsLeft = 1, usableNow = true, paused = false, requiresLimit = false, clears = ['five_hour', 'seven_day'], ...rest } = {}) {
  return { id: 'g1', resetsLeft, resetsTotal: resetsLeft, endsAt, startsAt: null, usableNow: usableNow, paused, requiresLimit, clears,
    givesBackWeekly: false, blocking: false, unavailableReason: null, label: null, expired: endsAt <= Date.now(), ...rest };
}

test('claude: general grant fires only at 100% — the same limit as z.ai', () => {
  const g = grant();
  assert.equal(decideClaude(acct({ wk: 0.98 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null }), null,
    'below the 100% limit: no claim');
  // EXACT LIMIT (2026-11-27): 0.99 used to BE the Claude wall and claim; it is now below it.
  assert.equal(decideClaude(acct({ wk: 0.99 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null }), null,
    '0.99 is under the limit: no claim');
  const act = decideClaude(acct({ wk: 1 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null });
  assert.equal(act?.grant?.id, 'g1');
  assert.equal(act?.scope, 'general');
  assert.equal(act?.reason, 'weekly at wall');
});

test('claude: a DYING grant is NOT spent before 100%, requiresLimit or not (was "dying value")', () => {
  // Both of these used to differ: a no-requirement grant in its last hours was claimed
  // on an account at 40% of its week. Now expiry alone never claims.
  const listing = g => ({ grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null });
  assert.equal(decideClaude(acct({ wk: 0.4 }), listing(grant({ endsAt: soon(2 * H), requiresLimit: true }))), null);
  assert.equal(decideClaude(acct({ wk: 0.4 }), listing(grant({ endsAt: soon(2 * H), requiresLimit: false }))), null,
    'kept: 40% used is not 100%, however soon the grant expires');
  // The same dying grant is claimed once the account is full.
  assert.equal(decideClaude(acct({ wk: 1 }), listing(grant({ endsAt: soon(2 * H), requiresLimit: false })))?.reason, 'weekly at wall');
});

test('claude: cooldown blocks; spent grants (resets_left 0) dropped upstream', () => {
  const g = grant();
  const cooled = { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: soon(H) };
  assert.equal(decideClaude(acct({ wk: 1 }), cooled), null);
});

test('claude: per-grant scope beats the server-named order (pre-mortem #8)', () => {
  // A general grant and a Fable grant; the server names the GENERAL one next, but
  // only the Fable bucket is at its wall — the Fable grant must be chosen, never
  // the general grant through nextGrantId order.
  const general = grant({ id: 'gen', clears: ['seven_day'] });
  const fable = grant({ id: 'fab', clears: ['seven_day_overage_included'] });
  const a = acct({ wk: 0.50 });
  a.quota.scopedWeekly = { fable: { utilization: 1, resetAt: soon(3 * DAY), isActive: true } };
  const act = decideClaude(a, { grants: [general, fable], eligible: true, nextGrantId: 'gen', cooldownUntil: null });
  assert.equal(act?.grant?.id, 'fab', 'the scoped-wall grant is chosen, not nextGrantId');
  assert.equal(act?.scope, 'fable');
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
  const fakeFetch = async (url) => {
    seen.push(url);
    if (url.endsWith('/api/oauth/profile')) return { ok: true, json: async () => ({ account: { uuid: 'acc' }, organization: { uuid: 'org-singular' } }) };
    return { ok: true, status: 200, json: async () => ({ result: 'reset', reset: true }) };
  };
  await claimResetGrant('tok', 'g1', { fetchImpl: fakeFetch });
  assert.match(seen[1], /\/api\/organizations\/org-singular\/reset_rate_limits$/, 'claimed against the SINGULAR org');
  // plural-only shape still resolves
  seen.length = 0;
  const fakeFetch2 = async (url) => {
    seen.push(url);
    if (url.endsWith('/api/oauth/profile')) return { ok: true, json: async () => ({ organizations: [{ uuid: 'org-plural' }] }) };
    return { ok: true, status: 200, json: async () => ({ result: 'reset', reset: true }) };
  };
  await claimResetGrant('tok', 'g1', { fetchImpl: fakeFetch2 });
  assert.match(seen[1], /\/api\/organizations\/org-plural\//, 'plural fallback intact');
});

// ── grantType on the redeem wire (2026-10-23) ────────────────────────────────
// z.ai began rejecting redeems that omit grantType with the misleading
// "The specified reset attempt is unavailable" — 519 failed redeems over ~16h on
// two weekly-walled accounts. The list payload carries grantType per card; the
// redeem must echo it back, exactly as z.ai's own web UI does.
test('listResetCards keeps each card\'s grantType from the list payload', async () => {
  const fetchImpl = async () => ({ status: 200, json: async () => ({ code: 200, data: {
    fiveHourResets: [],
    weekResets: [{ recordId: 9, grantType: 'GLOBAL', expireTime: '2099-12-22 23:59:59', available: true }],
  } }) });
  const r = await listResetCards('tok', { fetchImpl });
  assert.equal(r.weekly.length, 1);
  assert.equal(r.weekly[0].grantType, 'GLOBAL');
});

test('redeemResetCard sends the card\'s grantType in the request body', async () => {
  let sent = null;
  const fetchImpl = async (_url, init) => { sent = JSON.parse(init.body);
    return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; };
  const r = await redeemResetCard('tok', 9, 'WEEK', { grantType: 'GLOBAL', fetchImpl });
  assert.equal(r.ok, true);
  assert.deepEqual(sent, { recordId: 9, targetType: 'PERSONAL', resetType: 'WEEK',
    requestId: sent.requestId, grantType: 'GLOBAL' });
});

test('prober redeem path passes the policy-chosen card\'s grantType to the wire', async () => {
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent = init?.body ? JSON.parse(init.body) : null;
    return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; };
  try {
    const logs = [];
    const { Prober } = await import('../src/prober.js');
    const self = { log: (m) => logs.push(m), am: {}, _withTimeout: (p) => p };
    await Prober.prototype._redeemZaiCard.call(self,
      { name: 'glm t', credential: 'tok', quota: {} },
      { card: { recordId: 9, grantType: 'GLOBAL' }, resetType: 'WEEK', reason: 'weekly at wall' });
    assert.equal(sent?.grantType, 'GLOBAL', 'grantType reached the wire');
    assert.ok(logs.some(l => /card 9 redeemed/.test(l)), 'success logged');
  } finally { globalThis.fetch = realFetch; }
});

// ── failed-redeem backoff (2026-10-23) ────────────────────────────────────────
// A failing redeem must not be retried every poll cycle: 519 identical failed
// attempts over 16h (2026-10-22/23) is the rapid-retry shape that drew z.ai's
// usage-risk notice. Backoff is per account+card, exponential 15m→6h, reset on success.
test('failed redeem backs off; success clears it', async () => {
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  const responses = [
    { status: 200, json: async () => ({ code: 400, success: false, msg: 'unavailable' }) },
    { status: 200, json: async () => ({ code: 400, success: false, msg: 'unavailable' }) },
    { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) },
  ];
  let calls = 0;
  globalThis.fetch = async () => responses[Math.min(calls, responses.length - 1)];
  const logs = [];
  const self = { log: m => logs.push(m), am: {}, _withTimeout: p => p,
                 _cardTries: new Map(), _cardRetryUntil: new Map() };
  const acct = { name: 'glm t', index: 0, credential: 'tok', quota: {} };
  const act = { card: { recordId: 9, grantType: 'GLOBAL' }, resetType: 'WEEK', reason: 'r' };
  const p = Object.create(Prober.prototype, { _cardTries: { value: self._cardTries }, _cardRetryUntil: { value: self._cardRetryUntil } });
  p.log = self.log; p.am = self.am; p._withTimeout = self._withTimeout;
  const call = () => Prober.prototype._redeemZaiCard.call(p, acct, act);

  await call(); calls++;                       // fail 1 → backoff armed
  assert.match(logs.at(-1), /try 1, next attempt in 15min/);
  const until = self._cardRetryUntil.get('glm t:9');
  assert.ok(until > Date.now(), 'backoff armed');
  const wireCallsBefore = calls;
  await call();                                 // suppressed — no wire call
  assert.equal(calls, wireCallsBefore, 'suppressed during backoff');
  self._cardRetryUntil.set('glm t:9', Date.now() - 1); // simulate backoff expiry
  await call(); calls++;                       // fail 2 → 30min
  assert.match(logs.at(-1), /try 2, next attempt in 30min/);
  self._cardRetryUntil.set('glm t:9', Date.now() - 1);
  await call(); calls++;                       // success → cleared
  assert.match(logs.at(-1), /card 9 redeemed/);
  assert.equal(self._cardRetryUntil.get('glm t:9'), 0, 'success clears backoff');
  globalThis.fetch = realFetch;
});

// LAST RESORT (owner 2026-11-28): a card inside its last 30 minutes cannot wait out the
// 15m/30m/1h steps — the attempt is repeated about every five minutes instead.
test('a failed last-resort redeem is retried in 5 minutes, not 15', async () => {
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: 400, success: false, msg: 'unavailable' }) });
  const logs = [];
  const self = { _cardTries: new Map(), _cardRetryUntil: new Map() };
  const acct = { name: 'glm t', index: 0, credential: 'tok', quota: { providerWk: 0.8, providerWkReset: Date.now() + 2 * DAY } };
  const act = { card: { recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 20 * 60_000 }, resetType: 'WEEK', reason: LAST_RESORT_REASON };
  const p = Object.create(Prober.prototype, { _cardTries: { value: self._cardTries }, _cardRetryUntil: { value: self._cardRetryUntil } });
  p.log = m => logs.push(m); p.am = {}; p._withTimeout = x => x;
  try {
    await Prober.prototype._redeemZaiCard.call(p, acct, act);
    assert.match(logs.at(-1), /try 1, next attempt in 5min/);
    assert.ok(self._cardRetryUntil.get('glm t:9') - Date.now() <= 5 * 60_000);
  } finally { globalThis.fetch = realFetch; }
});

// ── red-team hardening (2026-10-23, verdict CONCERNS ×4 minor) ────────────────
test('requestId idempotency key is account-scoped (card 9 on two accounts differ)', () => {
  // same recordId, different accounts → different requestIds; same pair → identical (retry-stable)
  const seen = [];
  const fakeFetch = async (_u, init) => { seen.push(JSON.parse(init.body)); 
    return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; };
  const call = (acct) => redeemResetCard('tok', 9, 'WEEK', { grantType: 'GLOBAL', accountKey: acct, fetchImpl: fakeFetch });
  return Promise.all([call('glm max+1@gomokka.com'), call('glm glm4@gomokka.com'), call('glm max+1@gomokka.com')]).then(rs => {
    assert(rs.every(r => r.ok));
    assert.notEqual(seen[0].requestId, seen[1].requestId, 'cross-account keys differ');
    assert.equal(seen[0].requestId, seen[2].requestId, 'same account retry-stable');
  });
});

test('grantType-less card gets one GLOBAL fallback retry on "unavailable"', async () => {
  const { Prober } = await import('../src/prober.js');
  const bodies = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_u, init) => { bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { status: 200, json: async () => ({ code: 400, success: false, msg: 'The specified reset attempt is unavailable' }) }
      : { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; };
  const logs = [];
  const p = Object.create(Prober.prototype, { _cardTries: { value: new Map() }, _cardRetryUntil: { value: new Map() } });
  p.log = m => logs.push(m); p.am = {}; p._withTimeout = x => x;
  try {
    await Prober.prototype._redeemZaiCard.call(p, { name: 'glm t', credential: 'tok', quota: {} },
      { card: { recordId: 9 }, resetType: 'WEEK', reason: 'r' });   // NO grantType on the card
    assert.equal(bodies.length, 2, 'exactly one fallback retry');
    assert.equal(bodies[0].grantType, undefined);
    assert.equal(bodies[1].grantType, 'GLOBAL');
    assert.ok(logs.some(l => /card 9 redeemed/.test(l)));
  } finally { globalThis.fetch = realFetch; }
});

test('backoff key is the account NAME (stable across reindex), and tries resets on success', async () => {
  const { Prober: _Prober } = await import('../src/prober.js');
  const src = (await import('node:fs')).readFileSync(new URL('../src/prober.js', import.meta.url), 'utf8');
  assert.match(src, /`\$\{account\.name\}:\$\{act\.card\.recordId\}`/, 'keyed by name');
  assert.match(src, /_cardTries\?\.set\(key, 0\)/, 'tries reset on success');
});

// ── wait for the free refill (owner 2026-10-23; final contract 2026-11-27) ───────
// A weekly card is spent ONLY at a measured 100%. At 100% it WAITS for z.ai's free
// weekly refill only when ALL of these hold:
//   • the refill lands within a day (freeRefillWaitMs), and
//   • the card will still be alive after that refill, and
//   • at least TWO compatible peer accounts have room right now (the 4th decideZai
//     argument, a peersWithRoom callback — the same count the Claude hold uses).
// Otherwise it is spent at once: no refill time known, refill more than a day away,
// card dies before the refill, or fewer than two peers with room.
const room = n => ({ peersWithRoom: () => n });
const WEEK_CARD = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
const full = (refillIn, ses = 0.2) => { const a = acct({ ses, wk: 1 }); a.quota.providerWkReset = refillIn == null ? null : Date.now() + refillIn; return a; };

test('W1: at 100%, refill in 12h, two compatible peers with room → the card WAITS for the free refill', () => {
  const act = decideZai(full(12 * H), WEEK_CARD, Date.now(), room(2));
  assert.equal(act, null, 'held: the free refill arrives first and the peers carry the load');
  assert.equal(decideZai(full(12 * H), WEEK_CARD, Date.now(), room(5)), null, 'more room keeps holding');
});

test('W2: at 100%, refill in 12h, but FEWER than two peers have room → the card is spent at once', () => {
  // The owner is never left blocked on a free refill when the pool has no room to wait in.
  assert.equal(decideZai(full(12 * H), WEEK_CARD, Date.now(), room(0))?.reason, 'weekly at wall', 'no room: spend');
  assert.equal(decideZai(full(12 * H), WEEK_CARD, Date.now(), room(1))?.reason, 'weekly at wall', 'ONE roomy peer is not enough to wait');
  // No callback at all (a caller that cannot count peers) is unknown capacity → spend.
  assert.equal(decideZai(full(12 * H), WEEK_CARD, Date.now())?.reason, 'weekly at wall', 'unknown capacity: spend');
  assert.equal(decideZai(full(12 * H), WEEK_CARD, Date.now(), room(undefined))?.reason, 'weekly at wall', 'a counter that answers undefined: spend');
});

test('W3: refill 30h away → the card is spent now, peers or not (a day is too long to wait)', () => {
  for (const n of [0, 2, 5]) {
    assert.equal(decideZai(full(30 * H), WEEK_CARD, Date.now(), room(n))?.card?.recordId, 9, `${n} peers: wall redeem stands when the refill is far`);
  }
});

test('W4: unknown refill time (null) → the card is spent now, peers or not (never wait on a guess)', () => {
  for (const n of [0, 2, 5]) {
    assert.equal(decideZai(full(null), WEEK_CARD, Date.now(), room(n))?.card?.recordId, 9, `${n} peers: no refill info → redeem`);
  }
});

test('W5: a card that DIES BEFORE the free refill is spent now — waiting would lose it', () => {
  // Refill in 5h, the card expires in 2h: it cannot wait for a refill it will never see.
  const cards = { weekly: [{ recordId: 5, grantType: 'GLOBAL', expiresAt: Date.now() + 2 * H, expired: false }], fiveHour: [] };
  for (const n of [2, 5]) {
    assert.equal(decideZai(full(5 * H, 0.6), cards, Date.now(), room(n))?.reason, 'weekly at wall', `${n} peers: spent, not held`);
  }
  // Control: the same refill with a card that outlives it is held.
  assert.equal(decideZai(full(5 * H, 0.6), WEEK_CARD, Date.now(), room(2)), null);
});

test('W6: below 100% an expiring card is NEVER spent — with the refill near or far, peers or not', () => {
  // Was "dying value": a card in its last 24h was redeemed at 30%+ used. Removed.
  const cards = { weekly: [{ recordId: 5, grantType: 'GLOBAL', expiresAt: Date.now() + 2 * H, expired: false }], fiveHour: [] };
  for (const refillIn of [5 * H, 5 * DAY, null]) {
    for (const n of [0, 2]) {
      const a = acct({ ses: 0.1, wk: 0.93 });
      a.quota.providerWkReset = refillIn == null ? null : Date.now() + refillIn;
      assert.equal(decideZai(a, cards, Date.now(), room(n)), null,
        `93% used, card dies in 2h, refill ${refillIn == null ? 'unknown' : 'in ' + Math.round(refillIn / H) + 'h'}, ${n} peers: kept`);
    }
  }
});

test('W7: the free-refill WAIT is strictly inside a day — 1s under 24h waits, exactly 24h spends', () => {
  const at = Date.now();
  const refill = at + 24 * H;
  const a = acct({ ses: 0.1, wk: 1 });
  a.quota.providerWkReset = refill;
  assert.equal(decideZai(a, WEEK_CARD, refill - 24 * H + 1000, room(2)), null, '23h59m59s to the refill: inside the wait window');
  assert.equal(decideZai(a, WEEK_CARD, refill - 24 * H, room(2))?.card?.recordId, 9, 'exactly 24h: outside the window → redeem');
  assert.equal(decideZai(a, WEEK_CARD, refill - 24 * H - 1000, room(2))?.card?.recordId, 9, 'more than 24h: redeem');
});

test('W8: a refill time already in the PAST (a rolled window, stale 100%) spends nothing', () => {
  // The 100% reading belongs to the window that just rolled: the account is refilling.
  const a = full(-60_000);
  assert.equal(decideZai(a, WEEK_CARD, Date.now(), room(0)), null, 'nothing to reset: the window already rolled');
  assert.equal(decideZai(a, WEEK_CARD, Date.now(), room(2)), null);
});

test('W9: R4 intact — at 100% the WEEKLY card clears both windows and goes first, hold or no hold', () => {
  const both = { ...WEEK_CARD, fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }] };
  // Refill far: the weekly card is spent (never the 5h one) even with the session full.
  assert.equal(decideZai(full(30 * H, 1), both, Date.now(), room(2))?.resetType, 'WEEK', 'weekly card preferred when not held');
  // Weekly held (refill near, room): the 5h card does NOT take its place — the account is
  // blocked by its full WEEK, which a session-only card cannot clear (final contract).
  const held = decideZai(full(12 * H, 1), both, Date.now(), room(2));
  assert.equal(held, null, 'weekly held and the session full: the 5h card is kept too');
});

// ── the 5h card vs a full WEEK (final contract 2026-11-27) ─────────────────────
test('the 5h card is spent for a 100% SESSION only, and never while the WEEK is at 100%', () => {
  const cards = {
    weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
    fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
  };
  // Weekly at 93% (not full), session at 97%: nothing is due.
  const a = acct({ ses: 0.97, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 12 * 3600_000;
  assert.equal(decideZai(a, cards, Date.now(), room(2)), null, '93% week and 97% session: neither limit is reached');
  // Session reaches 100% while the week is NOT full: the DEDICATED 5h card goes.
  a.quota.providerSes = 1;
  const act = decideZai(a, cards, Date.now(), room(2));
  assert.equal(act?.resetType, 'FIVE_HOUR', 'the 5h limit is reached: its own card is spent');
  assert.equal(act?.card?.recordId, 6, 'never the weekly card');
  // The week reaches 100% too, with the weekly card HELD for its refill: the 5h card is
  // kept — the account is blocked by its week, which the 5h card cannot clear.
  a.quota.providerWk = 1;
  assert.equal(decideZai(a, cards, Date.now(), room(2)), null, 'week full and held: the 5h card waits with it');
  // ...and with NO weekly card held at all, a full week still keeps the 5h card.
  const only5h = { weekly: [], fiveHour: cards.fiveHour };
  a.quota.providerWkReset = Date.now() + 5 * DAY;       // far: the week stays full for days
  assert.equal(decideZai(a, only5h, Date.now(), room(2)), null, 'a full week is not a session-only block: the 5h card is kept');
});

test('owner 2026-10-30, still true: a weekly card/grant is never spent because of the SESSION window alone', () => {
  const now = Date.now();
  const endsAt = now + 3 * 3600 * 1000;   // expiring in 3h
  // z.ai: weekly 10%, session 96%
  const zai = { enabled: true, quota: { providerSes: 0.96, providerWk: 0.10 } };
  const cards = { weekly: [{ recordId: 'w1', expiresAt: endsAt, expired: false }], fiveHour: [] };
  assert.equal(decideZai(zai, cards, now), null, 'session-driven spend refused');
  // Control (changed 2026-11-27): weekly at 40% used to spend this dying card ("dying
  // value"). It is now kept: only a measured 100% spends a weekly card.
  const zaiWk = { enabled: true, quota: { providerSes: 0.10, providerWk: 0.40 } };
  assert.equal(decideZai(zaiWk, cards, now), null, 'a dying card at 40% of the week: kept');
  // Claude: weekly-clearing grant, weekly 10%, session 96%, expiring in 3h
  const freshQ = { unified5h: 0.96, unified7d: 0.10, unified7dReset: now + 3 * DAY, lastProbeOkAt: now };
  const cl = { enabled: true, quota: freshQ };
  const listing = { eligible: true, grants: [{ id: 'g1', usableNow: true, endsAt, clears: ['five_hour', 'seven_day'], givesBackWeekly: false }] };
  assert.equal(decideClaude(cl, listing, now, { now }), null, 'session-driven grant claim refused');
  const clWk = { enabled: true, quota: { ...freshQ, unified5h: 0.10, unified7d: 0.40 } };
  assert.equal(decideClaude(clWk, listing, now, { now }), null, 'a dying grant at 40% of the week: kept');
});

// ── TEST 8 (A4, 2026-11-10): z.ai card listings keep the last good on error/timeout/drift ──
test('A4: error, timeout, all-unavailable, and renamed-field listings all HOLD the stored cards (stale), one log line', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', credential: 'k', apiKey: 'k' }], 0.9);
  const GOOD_CARDS = () => ({ weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: soon(20 * DAY), expired: false }], fiveHour: [], source: 'zai' });
  am.applyResetCards(0, GOOD_CARDS());
  const logs = [];
  let mode = 'error';
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m),
    providerProbeFn: async () => ({ ses: { utilization: 0.2, resetAt: soon(3 * H) }, wk: { utilization: 0.3, resetAt: soon(3 * DAY) }, source: 'zai' }),
    cardsFn: async () => {
    if (mode === 'error') return { error: 'HTTP 500' };
    if (mode === 'timeout') return null;                     // _withTimeout resolves null
    if (mode === 'unavailable') return { weekly: [], fiveHour: [] };   // raw parse of all-unavailable is legitimately empty — NOT drift
    if (mode === 'renamed') return { error: 'drift: 2 raw entries, 0 kept' };  // listResetCards-level drift
    return GOOD_CARDS();
  } });
  const cardLogs = () => logs.filter(l => /^\[reset-card\] glm t:/.test(l));
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].resetCards.weekly.length, 1, 'error: the stored cards are held');
  assert.equal(am.accounts[0].resetCards.stale, true, 'marked stale');
  mode = 'timeout';
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].resetCards.weekly.length, 1, 'timeout: held');
  mode = 'renamed';
  await prober.probeProvider(am.accounts[0]);
  assert.equal(am.accounts[0].resetCards.weekly.length, 1, 'renamed field (drift): held, never a good empty');
  assert.equal(cardLogs().length, 1, 'ONE failure line across the failed sweeps');
  mode = 'ok';
  await prober.probeProvider(am.accounts[0]);
  assert.equal(cardLogs().length, 2, 'recovery logs once');
  assert.match(cardLogs()[1], /listing recovered/);
  assert.equal(am.accounts[0].resetCards.stale, false);
});

test('A4: a 200 with every entry available:false is a legitimate empty list (not drift)', async () => {
  const { listResetCards } = await import('../src/zai-reset-cards.js');
  const fetchImpl = async () => ({ status: 200, json: async () => ({ code: 200, data: {
    fiveHourResets: [{ recordId: 5, expireTime: '2099-12-22 23:59:59', available: false }],
    weekResets: [],
  } }) });
  const r = await listResetCards('tok', { fetchImpl });
  assert.deepEqual(r, { fiveHour: [], weekly: [], source: 'zai' }, 'all-unavailable parses to an honest empty, no error');
});

test('A4: listResetCards treats a 200 with a RENAMED field as drift (raw>0 kept 0)', async () => {
  const { listResetCards } = await import('../src/zai-reset-cards.js');
  const fetchImpl = async () => ({ status: 200, json: async () => ({ code: 200, data: {
    fiveHourResets: [{ recordIdx: 5, expireTime: '2099-12-22 23:59:59', available: true }],   // recordId renamed
    weekResets: [],
  } }) });
  const r = await listResetCards('tok', { fetchImpl });
  assert.ok(r.error && /drift/.test(r.error), 'drift reads as an error, never a good empty list');
});

test('A4: expected arrays MISSING from a 200 is drift', async () => {
  const { listResetCards } = await import('../src/zai-reset-cards.js');
  const fetchImpl = async () => ({ status: 200, json: async () => ({ code: 200, data: { fiveHourResets2: [], weekResets: [] } }) });
  const r = await listResetCards('tok', { fetchImpl });
  assert.ok(r.error && /drift/.test(r.error));
});

// ── TEST 9 (A4/SC5): a redeem removes the card from the stored list even when the follow-up read fails ──
test('A4/SC5: a successful redeem removes the recordId locally; a FAILED follow-up listing keeps the removal', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', credential: 'k', apiKey: 'k' }], 0.9);
  am.applyResetCards(0, { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] });
  const realFetch = globalThis.fetch;
  let listFails = false;
  globalThis.fetch = async (_u, init) => {
    if (init?.method === 'POST') return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) };
    if (listFails) return { status: 500 };
    return { status: 200, json: async () => ({ code: 200, data: { fiveHourResets: [], weekResets: [] } }) };
  };
  const logs = [];
  const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m), providerProbeFn: async () => null,
    cardsFn: async () => ({ weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] }) });
  try {
    await Prober.prototype._redeemZaiCard.call({ ...prober, log: m => logs.push(m), am, _withTimeout: p => p },
      am.accounts[0], { card: { recordId: 9, grantType: 'GLOBAL' }, resetType: 'WEEK', reason: 'weekly at wall' });
    // The follow-up read FAILS — the removal must still hold.
    listFails = true;
    assert.ok(logs.some(l => /card 9 redeemed/.test(l)));
    const weekly = am.accounts[0].resetCards.weekly || [];
    assert.ok(!weekly.some(c => c.recordId === 9), 'the redeemed card is GONE from the stored list');
    // And the routing discount no longer sees a usable reset.
    assert.equal(am._holdsUsableReset(am.accounts[0]), false, 'no stale discount for a spent card');
  } finally { globalThis.fetch = realFetch; }
});

// ── A spent reset must put a PARKED account back in service ───────────────────
// Live 2026-11-27 09:00Z on the cloud pool: the weekly card was redeemed on glm6,
// glm7 and privacy while each was still parked for a 24h "rate limited" bench set
// earlier; the accounts then sat idle for up to 24h with a fresh week paid for.
test('a redeemed z.ai card puts a rate-limited account back in service at once', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  const logs = [];
  console.log = () => {};
  globalThis.fetch = async () => ({ status: 200, json: async () => ({ code: 200, success: true }) });
  try {
    const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', authToken: 'k', apiKey: 'k', credential: 'k' }], 0.95);
    const account = am.accounts[0];
    account.quota.providerWk = 1; account.quota.providerWkReset = Date.now() + 2 * 24 * 3600_000;
    account.quota.providerSes = 0; account.quota.providerSesReset = Date.now() + 3 * H;
    am.markRateLimited(0, 24 * 3600, { status: 429 });
    assert.equal(account.status, 'throttled');
    assert.ok(account.rateLimitedUntil - Date.now() > 23 * 3600_000, 'precondition: parked for most of a day');
    const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m),
      // z.ai's usage read AFTER the reset: the week is 2% used again.
      // Same shape as the real reader (fetchProviderUsage): {utilization, resetAt} per window.
      providerProbeFn: async () => ({ source: 'zai', ses: { utilization: 0.02, resetAt: Date.now() + 3 * H },
        wk: { utilization: 0.02, resetAt: Date.now() + 7 * 24 * 3600_000 } }),
      usageGapMs: 0 });
    await prober._redeemZaiCard(account, { card: { recordId: 9, grantType: 'GLOBAL' }, resetType: 'WEEK', reason: 'weekly at wall' });
    assert.ok(logs.some(l => /card 9 redeemed/.test(l)), 'precondition: the card was spent');
    assert.notEqual(account.status, 'throttled', 'a fresh week must not stay behind a stale park');
    assert.equal(am._isAvailable(account, { model: 'glm-5.4' }), true, 'the account can serve again');
    assert.ok(account.quota.providerWk < 0.1, `usage re-read after the reset (wk=${account.quota.providerWk})`);
    // A later, unrelated failure on a parked account must not keep it parked: an in-flight
    // request that ends in a timeout or a 5xx rewrites lastError while the bench stays.
    am.markRateLimited(0, 24 * 3600, { status: 429 });
    account.lastError = 'upstream_error'; account.lastErrorAt = Date.now();
    assert.equal(am.clearRateLimited(0), true, 'lifted on status alone');
    assert.equal(account.status, 'active');
    // A non-quota bench is NOT lifted: an auth error or a cooldown is not about quota.
    am.markRateLimited(0, 60, { status: 429 });
    am.markAuthFailed(0, 403);
    assert.equal(am.clearRateLimited(0), false);
    assert.equal(account.status, 'error', 'an auth error stays benched');
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

// ── The Z.ai card column: a FRESH card must not read as stale (fixed 2026-11-27) ──────
// Live symptom: a z.ai account's card, listed this very sweep, rendered GREY with a
// trailing '?'. The reset cell judged freshness off the Claude GRANT listing, which a
// z.ai account never has (resetGrants is null), so `freshGrants` was false for every
// z.ai account whenever it held a card. Goes through the real row renderer.
test('the z.ai reset column shows a freshly listed card as fresh (green, no ?) — no Claude grants needed', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { TUI, __tuiTest } = await import('../src/tui.js');
  const strip = __tuiTest.strip;
  const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', apiKey: 'k', credential: 'k' }], 0.9);
  const card = () => ({ weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: soon(20 * DAY), expired: false }], fiveHour: [] });
  am.applyResetCards(0, card());
  assert.equal(am.accounts[0].resetGrants, undefined, 'precondition: a z.ai account has NO Claude grant listing');
  assert.equal(am.accounts[0].resetCards.stale, false, 'precondition: the card listing is fresh');
  const tui = new TUI({ accountManager: am });
  const row = strip(tui._renderAcct(0, 11, true, true, true, 200));
  // The account-level reset cell: the count with its expiry, and NOT the stale marker.
  assert.match(row, /1~\d+d/, 'the weekly card count and expiry are shown');
  assert.doesNotMatch(row, /1~\d+d\?/, 'a fresh card carries no "?"');
  // NEGATIVE CONTROL — the same row, listing marked stale: the "?" must appear. This is
  // what proves the fix did not simply stop drawing the marker.
  am.accounts[0].resetCards = { ...am.accounts[0].resetCards, stale: true };
  const staleRow = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true, true, true, 200));
  assert.match(staleRow, /1~\d+d\?/, 'a stale card listing still reads stale');
  // ...and an OLD listing (past LISTING_FRESH_MS) reads stale too.
  am.applyResetCards(0, card());
  am.accounts[0].resetCards.checkedAt = Date.now() - 60 * 60 * 1000;
  const oldRow = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true, true, true, 200));
  assert.match(oldRow, /1~\d+d\?/, 'an old card listing reads stale');
});

// ── The five-hour-card column (owner 2026-11-27) ───────────────────────────────────
// "they should probably have their own column. And they should show nothing where they
// don't apply." Blank where it does not apply; a fresh zero, an unknown and a stale
// reading are three DIFFERENT things and never look alike.
test('the 5h column: blank where it does not apply; 0, unknown and stale are distinct', async () => {
  const { __tuiTest } = await import('../src/tui.js');
  const { fiveHourResetCell, strip } = __tuiTest;
  const t = Date.now();
  const cell = (account, now = t) => strip(fiveHourResetCell(account, now));
  const W = strip(fiveHourResetCell({ provider: 'zai' })).length;
  assert.ok(W >= 4 && W <= 5, `the cell is a fixed narrow width (${W})`);
  // BLANK: every account the column does not apply to.
  for (const a of [{ provider: 'anthropic' }, { provider: 'codex' }, { provider: 'kimi' }, {}]) {
    assert.equal(cell(a), ' '.repeat(W), `${JSON.stringify(a)}: blank`);
  }
  // BLANK too: a DISABLED z.ai account — its cards are not ours to spend.
  assert.equal(cell({ provider: 'zai', enabled: false, resetCards: { fiveHour: [{ recordId: 1, expiresAt: t + 9 * DAY, expired: false }], checkedAt: t } }),
    ' '.repeat(W), 'disabled: blank, a count would imply we may spend it');
  // A dim 0: a z.ai account whose FRESH listing shows no 5h card.
  assert.equal(cell({ provider: 'zai', resetCards: { fiveHour: [], checkedAt: t } }).trim(), '0', 'a fresh zero is a zero');
  // UNKNOWN: a z.ai account whose card listing was never read. NOT a zero.
  assert.equal(cell({ provider: 'zai' }).trim(), '?', 'no listing is unknown');
  assert.equal(cell({ provider: 'zai', resetCards: { weekly: [], checkedAt: t } }).trim(), '?', 'a listing without the 5h array is unknown');
  // STALE: cards seen, but the listing cannot be vouched for — grey with '?', never green.
  const stale = cell({ provider: 'zai', resetCards: { fiveHour: [{ recordId: 1, expiresAt: t + 3 * DAY, expired: false }], checkedAt: t, stale: true } });
  assert.equal(stale.trim(), '1~3d?', 'a stale count keeps its "?"');
  const old = cell({ provider: 'zai', resetCards: { fiveHour: [{ recordId: 1, expiresAt: t + 3 * DAY, expired: false }], checkedAt: t - 60 * 60 * 1000 } });
  assert.equal(old.trim(), '1~3d?', 'an old listing reads stale');
  assert.equal(cell({ provider: 'zai', refreshDead: true, resetCards: { fiveHour: [], checkedAt: t } }).trim(), '0?', 'a stale zero is marked, never plain');
  // A FRESH card: the count and its expiry, soonest first.
  const live = { provider: 'zai', resetCards: { fiveHour: [
    { recordId: 2, expiresAt: t + 9 * DAY, expired: false }, { recordId: 1, expiresAt: t + 11 * 3600_000, expired: false }], checkedAt: t } };
  assert.equal(cell(live).trim(), '2~11h', 'count and soonest expiry');
  assert.equal(fiveHourResetCell(live, t).includes('\x1b[32m'), true, 'a live card is GREEN');
  // Expired cards on the listing do not count.
  const withExpired = { provider: 'zai', resetCards: { fiveHour: [
    { recordId: 1, expiresAt: t + 3 * DAY, expired: false }, { recordId: 2, expiresAt: t - DAY, expired: true }], checkedAt: t } };
  assert.equal(cell(withExpired).trim(), '1~3d', 'an expired card is not a card');
});

test('the 5h column: the account-level count no longer folds five-hour cards in', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { TUI, __tuiTest } = await import('../src/tui.js');
  const strip = __tuiTest.strip;
  const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', apiKey: 'k', credential: 'k' }], 0.9);
  // One weekly card and two five-hour cards.
  am.applyResetCards(0, { weekly: [{ recordId: 9, expiresAt: soon(20 * DAY), expired: false }],
    fiveHour: [{ recordId: 5, expiresAt: soon(3 * DAY), expired: false }, { recordId: 6, expiresAt: soon(4 * DAY), expired: false }] });
  const wide = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true, true, true, 200));
  // ARst counts the WEEKLY card alone (it used to read 3); the 5h column carries the two.
  assert.match(wide, /1~\d+d +2~3d/, 'account-level = 1 weekly; five-hour column = 2~3d');
  // Below the width the column fits, the row carries NO five-hour cell at all.
  assert.equal(__tuiTest.show5hColumn(200), true);
  assert.equal(__tuiTest.show5hColumn(139), true, 'first width where the column costs no bar width');
  assert.equal(__tuiTest.show5hColumn(138), false);
  assert.equal(__tuiTest.show5hColumn(80), false);
  const narrow = strip(new TUI({ accountManager: am })._renderAcct(0, 11, true, true, true, 120));
  assert.doesNotMatch(narrow, /2~3d/, 'the five-hour cell is absent on a narrow terminal');
  assert.match(narrow, /1~\d+d/, 'the weekly card is still shown');
});

test('the 5h column never squeezes a quota bar: it is shown only where it costs no bar width', async () => {
  const { __tuiTest } = await import('../src/tui.js');
  const { barStart, barLayout, show5hColumn } = __tuiTest;
  // The column is shown from exactly one width, and adds exactly its own span there.
  assert.equal(show5hColumn(138), false);
  assert.equal(show5hColumn(139), true, 'the first width where the column costs nothing');
  // At a width where the name column has stopped growing (>=100), the ONLY thing that
  // can move barStart between 138 and 139 is the column itself.
  const span = barStart(139) - barStart(138);
  assert.equal(span, 6, 'the column is 5 cells plus its gap');
  // MEASURED against the real layout: at 139 and above, every bar keeps its full width
  // (three bars at 11). Below 139 the column is not shown, so that layout is unchanged
  // from before the column existed (barStart there has no column span in it).
  for (const W of [139, 140, 160, 200]) {
    const l = barLayout(W);
    assert.equal(l.showFable, true, `W=${W}: the Fable bar still shows`);
    assert.equal(l.bw, 11, `W=${W}: bars keep their full width (bw=${l.bw})`);
  }
  // Just below: no column, and the layout is the one that shipped before (Fable shows
  // from 127 with the column absent). This is the proof the column never REMOVES a bar.
  assert.equal(barLayout(127).showFable, true, '127 keeps its Fable bar (no column there)');
  assert.equal(barLayout(120).bw, 13, '120 keeps its 13-wide bars (no column there)');
});

// ── The 5h card through the REAL prober (the wiring a decideZai unit test cannot see) ──
// The decision reads the session usage from THIS sweep's probe (applyProviderUsage runs
// before decideZai), and the prober sends the policy's resetType on the wire.
test('REAL WIRING: a 5h card is redeemed through the prober only once the probed session window is at 100%', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  console.log = () => {};
  try {
    // [session reading, weekly reading, spent?]
    const cases = [
      [1.0, 0.2, true],    // session at 100%, week not full: the DEDICATED 5h card goes
      [1.0, 1.0, false],   // week at 100% too: the 5h card cannot clear it → kept
      [0.999, 0.2, false], // one step under the session limit: kept
      [0.96, 0.2, false],
      [0.02, 0.2, false],
    ];
    for (const [sesUtil, wkUtil, expectSpent] of cases) {
      const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', apiKey: 'k', credential: 'k' }], 0.9);
      const a = am.accounts[0];
      const posts = [];
      globalThis.fetch = async (_u, init) => {
        if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; }
        return { status: 200, json: async () => ({ code: 200, data: { fiveHourResets: [], weekResets: [] } }) };
      };
      const logs = [];
      const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m),
        // The probe reports both windows; the decision reads THOSE, this sweep.
        providerProbeFn: async () => ({ source: 'zai', ses: { utilization: sesUtil, resetAt: Date.now() + 2 * H },
          wk: { utilization: wkUtil, resetAt: Date.now() + 3 * DAY } }),
        cardsFn: async () => ({ weekly: [], fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 20 * DAY, expired: false }] }) });
      await prober.probeProvider(a);
      assert.equal(a.quota.providerSes, sesUtil, 'precondition: the probe reading is what the decision sees');
      if (expectSpent) {
        assert.equal(posts.length, 1, `session ${sesUtil} / week ${wkUtil}: the card is redeemed`);
        assert.equal(posts[0].resetType, 'FIVE_HOUR', 'the DEDICATED five-hour card is what is sent');
        assert.equal(posts[0].recordId, 6);
        assert.equal(a.resetOutcomes['5h'].kind, 'spent at 100%');
        assert.equal(a.resetOutcomes['5h'].util, 1);
        assert.equal(posts[0].grantType, 'GLOBAL');
        assert.ok(logs.some(l => /redeeming FIVE_HOUR card 6 \(session at limit/.test(l)), 'logged with its reason');
      } else {
        assert.equal(posts.length, 0, `session ${sesUtil} / week ${wkUtil}: no card is spent`);
      }
    }
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});

// The weekly hold needs a LIVE count of compatible peers with room. The prober passes
// `am.countPeersWithRoom` as the 4th decideZai argument; this is the only place that
// wiring exists, so it is walked through the REAL AccountManager + Prober.
test('REAL WIRING: at 100% a weekly card WAITS for the free refill only while two compatible GLM peers have room', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  console.log = () => {};
  const glm = name => ({ name, type: 'provider', provider: 'zai', apiKey: `k-${name}`, credential: `k-${name}`,
    modelMap: { sonnet: name === 'incompatible' ? 'glm-other' : 'glm-fixture' } });
  const stubFetch = posts => { globalThis.fetch = async (_u, init) => {
    if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; }
    return { status: 200, json: async () => ({ code: 200, data: { fiveHourResets: [], weekResets: [] } }) };
  }; };
  try {
    // Each peer's probe reading: [weekly, session]. "Roomy" = weekly ≤ 0.65 and session ≤ 0.65.
    const readings = { 'glm full': [1, 0.2], 'peer a': [0.2, 0.2], 'peer b': [0.3, 0.3], incompatible: [0.2, 0.2] };
    const run = async (names) => {
      const am = new AccountManager(names.map(glm), 0.9);
      const posts = [];
      stubFetch(posts);
      // Only the walled account carries a card; peers hold none, so they never redeem.
      const prober = new Prober(am, { intervalMs: 0, log: () => {},
        providerProbeFn: async acc => ({ source: 'zai', ses: { utilization: readings[acc.name][1], resetAt: Date.now() + 2 * H },
          wk: { utilization: readings[acc.name][0], resetAt: acc.name === 'glm full' ? Date.now() + 12 * H : Date.now() + 3 * DAY } }),
        cardsFn: async cred => cred === 'k-glm full'
          ? { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] }
          : { weekly: [], fiveHour: [] } });
      // The peers' probes land first so their room is FRESH when the walled account decides.
      for (const acc of [...am.accounts.slice(1), am.accounts[0]]) await prober.probeProvider(acc);
      return { am, posts, full: am.accounts.find(a => a.name === 'glm full') };
    };

    // Two compatible peers with room: the card waits for the refill 12h away.
    const held = await run(['glm full', 'peer a', 'peer b']);
    assert.equal(held.am.countPeersWithRoom(held.full), 2, 'precondition: both peers count as having room');
    assert.equal(held.posts.length, 0, 'held: two roomy peers carry the load until the free refill');

    // ONE roomy peer: not enough to wait — the card is spent at once.
    const one = await run(['glm full', 'peer a', 'incompatible']);
    assert.equal(one.am.countPeersWithRoom(one.full), 1, 'the second roomy account is incompatible and does not count');
    assert.equal(one.posts.length, 1, 'one roomy peer is not enough: the weekly card is redeemed');
    assert.equal(one.posts[0].resetType, 'WEEK');
    assert.equal(one.posts[0].recordId, 9);

    // Alone in the pool: nothing to wait in — the card is spent.
    const alone = await run(['glm full']);
    assert.equal(alone.posts.length, 1, 'no peers: the weekly card is redeemed');
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});
