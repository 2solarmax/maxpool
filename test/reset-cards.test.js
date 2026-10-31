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

test('R1 (owner 2026-10-30): 5h cards are NEVER spent — not at the 5h wall, even dying', () => {
  const cards = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(20 * DAY), expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 0.96 }), cards), null, 'session wall never spends a card');
  const dying = { weekly: [], fiveHour: [{ recordId: 5, expiresAt: soon(2 * H), expired: false }] };
  assert.equal(decideZai(acct({ wk: 0.2, ses: 0.9 }), dying), null, 'dying 5h card also never spent');
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
  const { Prober } = await import('../src/prober.js');
  let sent = null;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => { sent = init?.body ? JSON.parse(init.body) : null;
    return { status: 200, json: async () => ({ code: 200, success: true, data: 1 }) }; };
  try {
    const logs = [];
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
  const { Prober } = await import('../src/prober.js');
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

test('W5: hold does not affect 5h cards or dying-value weekly redeems', () => {
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
test('W7 (owner 2026-10-30): during a weekly hold, a 5h wall still redeems NOTHING', () => {
  const cards = {
    weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
    fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
  };
  const a = acct({ ses: 0.97, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 12 * 3600_000;   // free refill in 12h → weekly HELD
  const act = decideZai(a, cards);
  assert.equal(act, null, '5h cards never spend; held weekly stays held');
});

test('W8: R4 intact — 5h wall does NOT spend the 5h card when the weekly card is redeemable', () => {
  const cards = {
    weekly: [{ recordId: 9, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
    fiveHour: [{ recordId: 6, grantType: 'GLOBAL', expiresAt: Date.now() + 60 * DAY, expired: false }],
  };
  const a = acct({ ses: 0.97, wk: 0.93 });
  a.quota.providerWkReset = Date.now() + 30 * 3600_000;   // refill far → weekly redeemable → R4 rules
  const act = decideZai(a, cards);
  assert.equal(act?.resetType, 'WEEK', 'weekly card still preferred when not held');
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
  const cl = { enabled: true, quota: { unified5h: 0.96, unified7d: 0.10 } };
  const listing = { eligible: true, grants: [{ id: 'g1', usableNow: true, endsAt: soon, clears: ['five_hour', 'seven_day'] }] };
  assert.equal(decideClaude(cl, listing, now), null, 'session-driven dying grant refused');
  const clWk = { enabled: true, quota: { unified5h: 0.10, unified7d: 0.40 } };
  assert.equal(decideClaude(clWk, listing, now)?.reason, 'dying value', 'weekly-driven dying grant still allowed');
});
