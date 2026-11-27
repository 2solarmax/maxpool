import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardExpiry, listResetCards, redeemResetCard } from '../src/zai-reset-cards.js';
import { decideZai, decideClaude } from '../src/reset-policy.js';

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
  // R4 (order) still holds: the weekly card at ITS wall clears BOTH windows, so it goes
  // first even when the session is also at its limit.
  const atWeeklyWall = decideZai(acct({ wk: 0.95, ses: 1 }), both);
  assert.equal(atWeeklyWall?.resetType, 'WEEK', 'the weekly card clears both, so it goes first');
  assert.equal(atWeeklyWall?.card?.recordId, 9);
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
  // The weekly rule's final precaution is NOT worth a 5h card: one dying unused costs
  // minutes of capacity, so a 5h card is only ever spent at the session limit.
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
function grant({ endsAt = soon(20 * DAY), resetsLeft = 1, usableNow = true, paused = false, requiresLimit = false, clears = ['five_hour', 'seven_day'], ...rest } = {}) {
  return { id: 'g1', resetsLeft, resetsTotal: resetsLeft, endsAt, startsAt: null, usableNow: usableNow, paused, requiresLimit, clears,
    givesBackWeekly: false, blocking: false, unavailableReason: null, label: null, expired: endsAt <= Date.now(), ...rest };
}

test('claude: general grant fires at the Claude weekly wall (the 0.999 limit, NOT the z.ai 0.90)', () => {
  const g = grant();
  assert.equal(decideClaude(acct({ wk: 0.98 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null }), null,
    'below CLAUDE_WALL_WEEKLY: no claim (z.ai 0.90 wall must NOT move)');
  // EXACT LIMIT (2026-11-27): 0.99 used to BE the Claude wall and claim; it is now below it.
  assert.equal(decideClaude(acct({ wk: 0.99 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null }), null,
    '0.99 is under the limit: no claim');
  const act = decideClaude(acct({ wk: 0.995 }), { grants: [g], eligible: true, nextGrantId: 'g1', cooldownUntil: null });
  assert.equal(act?.grant?.id, 'g1');
  assert.equal(act?.scope, 'general');
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
  assert.equal(decideClaude(acct({ wk: 0.995 }), cooled), null);
});

test('claude: per-grant scope beats the server-named order (pre-mortem #8)', () => {
  // A general grant and a Fable grant; the server names the GENERAL one next, but
  // only the Fable bucket is at its wall — the Fable grant must be chosen, never
  // the general grant through nextGrantId order.
  const general = grant({ id: 'gen', clears: ['seven_day'] });
  const fable = grant({ id: 'fab', clears: ['seven_day_overage_included'] });
  const a = acct({ wk: 0.50 });
  a.quota.scopedWeekly = { fable: { utilization: 0.995, resetAt: soon(3 * DAY), isActive: true } };
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

// ── wait-for-free-refill (owner-approved 2026-10-23) ──────────────────────────
// A weekly card is NOT redeemed at the 90% wall when z.ai's free weekly refill
// lands <24h away and the account is not critically full (<98%) — the free
// refill makes the card redundant. At >=98% redeem regardless: the owner is
// never blocked waiting for a free refill that is only hours away.
test('W1 RED: holds weekly card when free refill <24h away and util <0.98', () => {
  const soon = Date.now() + 12 * 3600_000;            // free refill in 12h
  const cards = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.2, wk: 0.93 });
  a.quota.providerWkReset = soon;
  assert.equal(decideZai(a, cards), null, 'must HOLD the card — free refill in 12h, util 93%');
});

test('W2: redeems at >=0.98 even with free refill imminent', () => {
  const soon = Date.now() + 3 * 3600_000;             // refill in 3h but account critically full
  const cards = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.2, wk: 0.98 });
  a.quota.providerWkReset = soon;
  const act = decideZai(a, cards);
  assert.equal(act?.card?.recordId, 9, 'never-block guarantee: redeem at 98%');
});

test('W3: refill >=24h away → existing wall behavior unchanged', () => {
  const later = Date.now() + 30 * 3600_000;           // refill in 30h
  const cards = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.2, wk: 0.93 });
  a.quota.providerWkReset = later;
  assert.equal(decideZai(a, cards)?.card?.recordId, 9, 'wall redeem stands when refill is far');
});

test('W4: unknown refill time (null) → existing behavior unchanged', () => {
  const cards = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.2, wk: 0.93 });
  a.quota.providerWkReset = null;
  assert.equal(decideZai(a, cards)?.card?.recordId, 9, 'no refill info → redeem as today');
});

test('W5: hold does not affect dying-value weekly redeems', () => {
  // dying-value (<24h on the CARD) still fires even with free refill imminent
  const cards = { weekly: [{ recordId: 5, grantType: 'GLOBAL', expiresAt: Date.now() + 2 * H, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.6, wk: 0.4 });
  a.quota.providerWkReset = Date.now() + 5 * 3600_000;
  const act = decideZai(a, cards);
  assert.equal(act?.reason, 'dying value', 'dying card redeemed, not held');
});

test('W6: wall AND dying together with imminent free refill — dying wins over hold (card expiring)', () => {
  // Card expires in 2h, util at wall 0.93, free refill in 5h. Holding burns the card's
  // remaining life for a refill that lands after the card dies — must redeem (dying).
  const cards = { weekly: [{ recordId: 5, grantType: 'GLOBAL', expiresAt: Date.now() + 2 * H, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.1, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 5 * 3600_000;
  const act = decideZai(a, cards);
  assert.ok(act?.kind === 'card' && act.card.recordId === 5, 'dying-value redeem must not be held by R6 (reason label may read "weekly at wall" when both are true)');
});

// ── R6 hold does not starve the 5h wall (red-team concern 1, 2026-10-23) ──────
test('W7: during a weekly hold, a 5h card is spent only once the 5h LIMIT is reached', () => {
  const cards = {
    weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
    fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
  };
  const a = acct({ ses: 0.97, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 12 * 3600_000;   // free refill in 12h → weekly HELD
  // Session at 97%: below the 5h limit. The weekly is held AND the 5h card is not due.
  assert.equal(decideZai(a, cards), null, 'weekly held, and 97% of the 5h window is not its limit');
  // The 5h limit is reached while the weekly is still held: the DEDICATED 5h card goes.
  // The weekly hold is about the WEEKLY refill; it says nothing about a full 5h window,
  // which the free weekly refill would also clear but which is blocking the account NOW.
  a.quota.providerSes = 1;
  const act = decideZai(a, cards);
  assert.equal(act?.resetType, 'FIVE_HOUR', 'the 5h limit is reached: its own card is spent');
  assert.equal(act?.card?.recordId, 6, 'never the held weekly card');
});

test('W8: R4 intact — a 5h window below its limit never takes a card while the weekly card is redeemable', () => {
  const cards = {
    weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
    fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
  };
  const a = acct({ ses: 0.97, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 30 * 3600_000;   // refill far → weekly redeemable → R4 rules
  const act = decideZai(a, cards);
  assert.equal(act?.resetType, 'WEEK', 'weekly card still preferred when not held');
  // And with the weekly card at its wall, a 5h window AT its limit changes nothing: the
  // weekly card clears both windows, so it is the one card that is spent.
  a.quota.providerSes = 1;
  assert.equal(decideZai(a, cards)?.resetType, 'WEEK');
});

test('W9: 24h boundary — refill exactly 24h+1s away redeems at the wall', () => {
  const cards = { weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }], fiveHour: [] };
  const a = acct({ ses: 0.1, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 24 * 3600_000 + 1000;
  assert.equal(decideZai(a, cards)?.card?.recordId, 9, 'outside the wait window → redeem');
});

test('owner 2026-10-30: a dying weekly card/grant is never spent because of the SESSION window alone', () => {
  const now = Date.now();
  const soon = now + 3 * 3600 * 1000;   // < 24h left — dying
  // z.ai: weekly 10%, session 96%, weekly card expiring in 3h
  const zai = { enabled: true, quota: { providerSes: 0.96, providerWk: 0.10 } };
  const cards = { weekly: [{ recordId: 'w1', expiresAt: soon, expired: false }], fiveHour: [] };
  assert.equal(decideZai(zai, cards, now), null, 'session-driven dying spend refused');
  // control: same card, weekly at 40% → dying value on the WEEKLY window → spend
  const zaiWk = { enabled: true, quota: { providerSes: 0.10, providerWk: 0.40 } };
  assert.equal(decideZai(zaiWk, cards, now)?.reason, 'dying value', 'weekly-driven dying spend still allowed');
  // Claude: weekly-clearing grant, weekly 10%, session 96%, dying
  const freshQ = { unified5h: 0.96, unified7d: 0.10, unified7dReset: now + 3 * DAY, lastProbeOkAt: now };
  const cl = { enabled: true, quota: freshQ };
  const listing = { eligible: true, grants: [{ id: 'g1', usableNow: true, endsAt: soon, clears: ['five_hour', 'seven_day'], givesBackWeekly: false }] };
  assert.equal(decideClaude(cl, listing, now, { now }), null, 'session-driven dying grant refused');
  const clWk = { enabled: true, quota: { ...freshQ, unified5h: 0.10, unified7d: 0.40 } };
  assert.equal(decideClaude(clWk, listing, now, { now })?.reason, 'dying value', 'weekly-driven dying grant still allowed');
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
  assert.equal(cell(live).includes('\x1b[32m'), true, 'a live card is GREEN');
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
test('REAL WIRING: a 5h card is redeemed through the prober only once the probed session window is at its limit', async () => {
  const { AccountManager } = await import('../src/account-manager.js');
  const { Prober } = await import('../src/prober.js');
  const realFetch = globalThis.fetch;
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const [sesUtil, expectSpent] of [[1.0, true], [0.999, false], [0.96, false], [0.02, false]]) {
      const am = new AccountManager([{ name: 'glm t', type: 'provider', provider: 'zai', apiKey: 'k', credential: 'k' }], 0.9);
      const a = am.accounts[0];
      const posts = [];
      globalThis.fetch = async (_u, init) => {
        if (init?.method === 'POST') { posts.push(JSON.parse(init.body)); return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; }
        return { status: 200, json: async () => ({ code: 200, data: { fiveHourResets: [], weekResets: [] } }) };
      };
      const logs = [];
      const prober = new Prober(am, { intervalMs: 0, log: m => logs.push(m),
        // The probe reports the session window; the decision reads THAT, this sweep.
        providerProbeFn: async () => ({ source: 'zai', ses: { utilization: sesUtil, resetAt: Date.now() + 2 * H },
          wk: { utilization: 0.2, resetAt: Date.now() + 3 * DAY } }),
        cardsFn: async () => ({ weekly: [], fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 20 * DAY, expired: false }] }) });
      await prober.probeProvider(a);
      assert.equal(a.quota.providerSes, sesUtil, 'precondition: the probe reading is what the decision sees');
      if (expectSpent) {
        assert.equal(posts.length, 1, `session ${sesUtil}: the card is redeemed`);
        assert.equal(posts[0].resetType, 'FIVE_HOUR', 'the DEDICATED five-hour card is what is sent');
        assert.equal(posts[0].recordId, 6);
        assert.equal(posts[0].grantType, 'GLOBAL');
        assert.ok(logs.some(l => /redeeming FIVE_HOUR card 6 \(session at limit/.test(l)), 'logged with its reason');
      } else {
        assert.equal(posts.length, 0, `session ${sesUtil}: below the 5h limit, no card is spent`);
      }
    }
  } finally { globalThis.fetch = realFetch; console.log = realLog; }
});
