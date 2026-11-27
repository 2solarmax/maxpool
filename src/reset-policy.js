/** Automatic resets require a measured 100% on the window the reset clears.
 * Expiry affects card ordering and routing, never whether partial use is full.
 * A free refill with spare capacity can make spending unnecessary even at 100%.
 */
import { appliesTo as defaultAppliesTo } from './claude-reset-grants.js';
import { CLAIM_FRESH_MS, CLAIM_STALE_LISTING_MAX_MS } from './reset-timing.js';

export const POLICY = {
  wallWeekly: 1,
  dyingWindowMs: 24 * 3600 * 1000, // Expiry affects routing, never the spend threshold.
  freeRefillWaitMs: 24 * 3600 * 1000,
  // R7 (owner, 2026-11-13): the Claude GENERAL weekly wall claim also waits for the
  // free refill when OTHER accounts can absorb the load. Room per peer: probe-fresh
  // (≤5 min) readings, weekly util with ≥ 35% headroom left, 5h util with ≥ 25%
  // headroom to the 0.90 session bench, routable now.
  holdPeerWeeklyRoom: 0.35,
  holdPeerSessionRoom: 0.25,
  holdMinPeers: 2,
  // A hold is tied to the refill it waited for (red-team r4 #4). The same refill is
  // read from two sources with different precision (rate-limit header: whole
  // seconds; usage probe: fractional), so a reading up to this much later is still
  // that refill; a rolled window moves it by days.
  holdRefillSlackMs: 3600 * 1000,
  // The 429 fast path and the rescue claim from the STORED listing, which they
  // refuse past CLAIM_STALE_LISTING_MAX_MS (6h). A hold therefore lets go this long
  // before that bound (red-team r4 #6), while the reset is still claimable — a dark
  // listing is unknown state, and unknown means claim. The rescue runs every sweep.
  holdListingMarginMs: 30 * 60 * 1000,
  limitReached: 1,
  sessionLimitReached: 1,
};

// The plain-words decision reason for an R7 hold — exported so status/log surfaces
// and tests share one string.
export const HOLD_POOL_HAS_ROOM = 'other accounts have room';

export const CLAUDE_WALL_WEEKLY = POLICY.limitReached;

// Claim freshness bound (C1, pre-mortem #5): the usage reading the claim decides on
// must be THIS fresh (≤ 5 min) — a reading taken before this sweep's probe (up to
// ~36 min stale after failed probes) would spend a reset right after a free refill.
// The value lives in the shared timing leaf; re-exported for existing callers.
export { CLAIM_FRESH_MS };

/** A scoped (per-model) bucket reading the decision can act on: a reading that is not
 *  the authority of a 429 (`reactive`), is still an active limit, has a utilization and
 *  has not already rolled over. An inactive limit binds nothing, and a bucket whose
 *  reset time has passed shows its pre-refill number: a claim on it spends a reset on
 *  an account that is already empty again, and its elapsed refill stamp reads as an
 *  imminent one. */
function liveScopedReading(e, now) {
  return Boolean(e) && e.reactive !== true && e.isActive !== false && e.utilization != null
    && !(e.resetAt != null && e.resetAt <= now);
}

/** EXACT LIMIT: has the WEEKLY limit been reached — the point the router stops serving
 *  from the account (POLICY.limitReached)? The reading alone decides: the vendor's own
 *  rejection is NOT read here, because a rejected status can belong to a per-model
 *  sub-limit (account-manager _isAccountWideRejected corroborates it with an exhausted
 *  bucket for exactly that reason), and a per-model rejection must never spend a weekly
 *  reset. Used for every weekly reset, and it is the ONLY routine spend point. */
export function weeklyLimitReached(util) {
  return Number.isFinite(util) && util >= POLICY.limitReached;
}

/** PLAN AHEAD (the final precaution only): should work be steered to `account` now, so a
 *  DYING reset is spent on an account that reached its limit honestly rather than dying
 *  unused on an idle one? True only while the reset is inside POLICY.dyingWindowMs of
 *  expiring, the pool may spend it on its own, and the account has not reached the limit
 *  (there the claim itself takes over). A reset with longer to live never steers: it is
 *  not dying, so filling the account now would be spending ahead of the limit. */
export function codexSteerForExpiry({ expiresAt, util, now } = {}) {
  if (!Number.isFinite(expiresAt) || !(expiresAt > now) || expiresAt - now > POLICY.dyingWindowMs) return false;
  if (!Number.isFinite(util)) return false;
  return util < POLICY.limitReached;
}

/** Is this the account whose banked Codex resets the pool may spend on its own? The
 *  setting is ON unless the owner turned it OFF (2026-11-27): an unset account of a
 *  locally owned native Codex login is enrolled, an explicit `false` always wins, and
 *  an account that is disabled, benched to another pool, dead or a cloud mirror is
 *  never enrolled whatever the setting says (a readable credential is not authority). */
export function codexAutoResetOn(account) {
  return account?.provider === 'codex' && account.codexAuth === 'native'
    && account.autoRedeemReset !== false
    && account.enabled !== false && !account.remote && !account.poolBenchedBy
    && !account.refreshDead && !account.subscriptionGone;
}

/** R7 (owner, 2026-11-13): should a GENERAL weekly WALL claim of `grant` wait for the
 *  free refill at `refillAt`? GENERAL ONLY (red-team r3, orchestrator decision): a
 *  per-model (Fable) wall and a dying-value grant claim exactly as before R7. The ONE
 *  hold rule, shared by the sweep (decideClaudeWithReason) and the
 *  reactive 429 path (account-manager tryReactiveClaim) so neither can spend what the
 *  other holds. Reads only the refill stamp, the grant's end and a LIVE peer count —
 *  never the walled account's own usage reading, which is routinely stale at the wall.
 *  R8 (owner, 2026-11-27): the hold no longer needs the refill to be under 24h away —
 *  spending a reset while other accounts can carry the work is the waste ("using them
 *  when we have enough capacity right now ... is a waste in and of itself"); the hold
 *  lets go the moment that room is gone.
 *  Conservative: an unknown / past refill, a grant that dies before (or within
 *  dyingWindowMs after) the refill — it would sit unspent at ~0% used — no counter,
 *  or a count that isn't an integer ≥ the pool-wide budget ⇒ false (claim).
 *  BUDGET (red-team r2 #2): roomy peers must cover EVERY wall currently held in this
 *  pool — holdMinPeers × holdersInPool(), where holdersInPool counts the walls
 *  holding now INCLUDING this one. Without a holders counter, this wall alone (1).
 *  LISTING AGE (red-team r4 #6): when the caller passes `listingCheckedAt`, a stored
 *  listing within holdListingMarginMs of the 6h claim bound — or of unknown age
 *  (null) — releases the hold: past that bound the reset could not be claimed at
 *  all while the listing stays dark. Both claim paths pass it. */
export function wallClaimHeld(refillAt, grant, now, { peersWithRoom, holdersInPool, listingCheckedAt } = {}) {
  if (!(refillAt > now)) return false;
  if (listingCheckedAt !== undefined
    && !(now - listingCheckedAt < CLAIM_STALE_LISTING_MAX_MS - POLICY.holdListingMarginMs)) return false;
  if (grant?.endsAt != null && grant.endsAt - refillAt < POLICY.dyingWindowMs) return false;
  const holders = holdersInPool ? holdersInPool() : 1;
  if (!Number.isInteger(holders) || holders < 1) return false;
  const count = peersWithRoom?.();
  return Number.isInteger(count) && count >= POLICY.holdMinPeers * holders;
}

/** Decide the z.ai action. Returns {kind:'card', card, resetType} | null. */
export function decideZai(account, cards, now = Date.now(), { peersWithRoom } = {}) {
  if (!account || account.enabled === false || account.poolBenchedBy || account.remote || account.subscriptionGone || account.refreshDead || account.quota?.noPlan) return null;               // R0
  if (!cards || cards.error) return null;
  if (account?.outsideUsage?.outside) return null;          // R7: key used by someone else — a card would feed the leak
  const q = account.quota || {};
  const wkUtil = q.weeklyAbsent ? null : (q.providerWk ?? null);

  const weeklyCards = (cards.weekly || []).filter(c => c && !c.expired && c.recordId != null && (c.expiresAt == null || c.expiresAt > now));
  // R4: soonest expiry first inside each class.
  weeklyCards.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));

  const weeklyCard = weeklyCards[0] || null;

  // --- weekly card: clears BOTH windows (z.ai docs; measured: glm1 100%->0% both)
  if (weeklyCard) {
    if (weeklyLimitReached(wkUtil)) {
      const refill = q.providerWkReset;
      const remaining = refill - now;
      if (Number.isFinite(refill) && remaining <= 0) return null;
      const canWait = remaining > 0 && remaining < POLICY.freeRefillWaitMs
        && (weeklyCard.expiresAt == null || weeklyCard.expiresAt > refill)
        && peersWithRoom?.() >= POLICY.holdMinPeers;
      if (!canWait) return { kind: 'card', card: weeklyCard, resetType: 'WEEK', reason: 'weekly at wall' };
      return null; // A session-only card cannot clear the weekly limit.
    }
  }

  // --- five-hour card (owner, 2026-11-27: "it's okay to spend 5-hour cards too" —
  // this REPLACES the 2026-10-30 "never spent" rule). It is a DEDICATED five-hour card:
  // it refills the session window only, so it is spent for a session limit and never
  // stands in for a weekly one. EXACT LIMIT: only once the 5h window has reached its
  // own limit (the window serves to 100%, so the limit IS 100%) — never at a routine
  // 96/99/90%, and never on a dying basis (a 5h card dying unused costs minutes of
  // capacity; the weekly rule's precaution is not worth a card here). The account
  // must be blocked by the SESSION limit and nothing else: an account that cannot
  // serve for another reason (benched to another pool, out of plan, outside usage)
  // would spend the card into a bench it does not lift.
  const fiveHourCards = (cards.fiveHour || [])
    .filter(c => c && !c.expired && c.recordId != null && (c.expiresAt == null || c.expiresAt > now))
    .sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  if (fiveHourCards.length) {
    const sesUtil = q.providerSes;
    const sessionOnlyBlocker = account.poolBenchedBy == null && !account.subscriptionGone && !account.refreshDead;
    if (sessionOnlyBlocker && !weeklyLimitReached(wkUtil) && (q.providerSesReset == null || q.providerSesReset > now) && Number.isFinite(sesUtil) && sesUtil >= POLICY.sessionLimitReached) {
      return { kind: 'card', card: fiveHourCards[0], resetType: 'FIVE_HOUR', reason: 'session at limit' };
    }
  }
  return null;
}

/** Decide the Claude action. Returns {kind:'grant', grant, scope, reason} | null.
 *  Thin wrapper over decideClaudeWithReason for callers that only need the action. */
export function decideClaude(account, listing, now = Date.now(), opts = {}) {
  return decideClaudeWithReason(account, listing, now, opts).action;
}

/** The ONE probe-send-time used to order a reading against a claim (finding 1):
 *  the SEND time of the last successful probe when the prober recorded it,
 *  else its apply time. A probe sent before a claim carries the pre-claim
 *  reading even when it lands after the claim. */
export function probeSentAt(q) {
  return q?.lastProbeOkSentAt ?? q?.lastProbeOkAt ?? null;
}

/** Returns a claim or the reason it is held; scoped windows require a measured, active reading. */
function decideSubscriptionWithReason(account, listing, now, opts) {
  const skip = reason => ({ action: null, reason });
  if (account?.enabled === false) return skip('account disabled');   // R0
  if (!listing) return skip('no listing');
  // Only a FRESH listing may claim.
  if (listing.error) return skip('listing failed');
  if (listing.stale) return skip('listing stale');
  if (listing.eligible === false) return skip('not eligible');
  if (listing.cooldownUntil != null && listing.cooldownUntil > now) return skip('cooldown');
  const q = account.quota || {};

  // FRESHNESS (pre-mortem #5): decide on THIS sweep's probe, never an aging one.
  // `freshNow` defaults to the real clock; tests may inject a frozen one.
  const freshNow = opts.now ?? now;
  const lastProbeOkAt = q.lastProbeOkAt ?? null;
  if (lastProbeOkAt == null || freshNow - lastProbeOkAt > CLAIM_FRESH_MS) return skip('probe not fresh');
  // A weekly window that already rolled over is empty — a claim right now buys
  // nothing (spent right after the free refill, at 0% used).
  if (q.unified7dReset != null && q.unified7dReset <= freshNow) return skip('weekly window elapsed');
  // No second claim for one wall: a probe SENT after the last claim must land first.
  const lastClaimAt = account.lastClaimAt ?? null;
  if (lastClaimAt != null && probeSentAt(q) <= lastClaimAt) return skip('already claimed for this wall');

  // Per-grant applicability (D1 via appliesTo), soonest-expiring first among
  // SAME-scope grants. Grants with unknown scope (appliesTo []) are never chosen.
  const held = (listing.grants || []).filter(g => g && !g.paused && !g.expired
    && (g.endsAt == null || g.endsAt > now) && (g.resetsLeft ?? 1) > 0);
  if (!held.length) return skip('no grant held');
  const grants = held
    .filter(g => g.usableNow !== false && !g.blocking && !g.unavailableReason)
    .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  if (!grants.length) return skip('grant not usable');

  const appliesTo = opts.appliesTo || defaultAppliesTo;
  const wkUtil = q.unified7d ?? null;
  // EXACT LIMIT: the wall IS the limit (CLAUDE_WALL_WEEKLY === POLICY.limitReached).
  const weeklyWall = weeklyLimitReached(wkUtil);
  // Record the general hold even if a separate model window is also full.
  let generalHeld = false;
  const out = (action, why) => ({ action, reason: why, heldScope: generalHeld ? 'general' : null });
  let reason = null;
  const note = r => { if (reason == null) reason = r; };

  // GENERAL (clears the general weekly, or gives_back_weekly): claim at the limit.
  // "Weekly reached" is the fresh unified7d reading ONLY — never the generic
  // `rejected` status (that conflates the 5h window and per-model caps; pre-mortem #8).
  const general = grants.filter(g => appliesTo(g).includes('general'));
  for (const g of general) {
    const giveBack = g.givesBackWeekly === true && !(Array.isArray(g.clears) && g.clears.includes('seven_day'));
    if (weeklyWall) {
      // R7: the free refill is imminent and the pool has room — hold the claim.
      if (wallClaimHeld(q.unified7dReset, g, now,
        { peersWithRoom: opts.peersWithRoom, holdersInPool: opts.holdersInPool, listingCheckedAt: listing.checkedAt })) {
        generalHeld = true; note(HOLD_POOL_HAS_ROOM); continue;
      }
      // A give-back-only grant (no seven_day in clears) returns only what the model
      // used — the claim snapshots unified7d so the next probe measures the drop.
      return out({ kind: 'grant', grant: g, scope: 'general', giveBack, reason: 'weekly at wall' }, 'weekly at wall');
    }
  }
  if (weeklyWall && !general.length) note('general not held');

  // MODEL-SCOPED (D3): claim when THAT model's probe-measured weekly bucket is at
  // its wall. `reactive` entries (a 429's authoritative-high mark) do NOT count —
  // only the probe's own measurement (pre-mortem #3/#8: a scoped 429 classified by
  // guesswork must not spend a reset).
  const scopedFams = new Set();
  for (const g of grants) for (const s of appliesTo(g)) if (s !== 'general' && s !== 'session') scopedFams.add(s);
  for (const fam of scopedFams) {
    const e = q.scopedWeekly?.[fam];
    if (!liveScopedReading(e, now)) continue;
    const cand = grants.find(g => appliesTo(g).includes(fam));
    if (!cand) continue;
    if (e.utilization >= CLAUDE_WALL_WEEKLY) {
      // Never held on its own (red-team r3) — but skipped while the GENERAL wall is
      // held: the account is benched by its general wall, so a model reset buys
      // nothing now; the hold re-evaluates every tick and, once the general refill
      // lands (or the hold lets go), this wall claims as before R7. ONLY when the
      // grant outlives the general refill by a day (red-team r4 #1) — one that
      // would expire before then is claimed now, or it is lost.
      if (generalHeld && (cand.endsAt == null || cand.endsAt - q.unified7dReset >= POLICY.dyingWindowMs)) continue;
      return out({ kind: 'grant', grant: cand, scope: fam, reason: `${fam} weekly at wall` }, `${fam} weekly at wall`);
    }
  }
  // A scoped bucket measured at the wall with no grant for it.
  for (const [fam, e] of Object.entries(q.scopedWeekly || {})) {
    if (liveScopedReading(e, now) && e.utilization >= CLAUDE_WALL_WEEKLY
      && !grants.some(g => appliesTo(g).includes(fam))) note(`${fam} not held`);
  }

  // Session-only grants: NEVER claimed (owner 2026-10-30) — falls through.
  return out(null, reason ?? 'below wall');
}

export function decideClaudeWithReason(account, listing, now = Date.now(), opts = {}) {
  return decideSubscriptionWithReason(account, listing, now, opts);
}

// Codex banked resets use the subscription's general weekly allowance. Only
// actual weekly data can support the decision: an unrelated 5h/model reading
// refreshing the account's generic probe timestamp is insufficient.
//
export function decideCodexWithReason(account, credits, now = Date.now(), opts = {}) {
  const q = account.quota || {};
  if (!(q.unified7dReset > now)) return { action: null, reason: 'weekly window unknown or elapsed' };
  const grants = (credits || []).filter(credit => credit?.status === 'available'
    && credit.supportedByPlan !== false).map(credit => ({
    id: credit.id, credit, endsAt: credit.expiresAt, resetsLeft: 1,
    clears: ['seven_day'],
  }));
  const { early: _ignoredEarly, ...rest } = opts;
  return decideSubscriptionWithReason({
    ...account,
    quota: { ...q, lastProbeOkAt: q.codexWeeklyReadingAt, lastProbeOkSentAt: q.codexWeeklyReadingAt },
  }, { grants, checkedAt: opts.listingCheckedAt }, now, rest);
}
