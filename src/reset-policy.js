/**
 * WHEN to redeem a limit-reset: the deliberate decision layer.
 *
 * Two value sources, one policy:
 *  - z.ai reset cards: { fiveHour:[{recordId,expiresAt,expired}], weekly:[...] }
 *  - Claude cedar_ember grants: { grants:[{id,resetsLeft,endsAt,usableNow,paused,
 *    requiresLimit,clears}], nextGrantId, cooldownUntil, eligible }
 *
 * Rules (owner, 2026-09-30 — "account not just for exhaustion, but also the time
 * left until expiry of the reset"):
 *
 * R0  ENABLED GATE — the caller must never even ask about a disabled account. The
 *     policy asserts it too: a disabled account's cards/grants are someone else's.
 *     (privacy@gomokka.com: owner uses it elsewhere; readable key is not authority.)
 *
 * R1  AT-THE-WALL — redeem when the window the reset clears is effectively spent:
 *     weekly >= 0.90, or (no weekly-clearing reset and 5h >= 0.95). Wall, not 100%:
 *     routing benches an account before the bar reads full.
 *
 * R2  DYING VALUE — a reset expiring soon is worth MORE than waiting: redeem when
 *     expiry < 24h AND the account has consumed enough that the refill buys real
 *     capacity (utilization > 0.30 for weekly-clearing; > 0.50 for 5h-only). At
 *     expiry the reset is worth zero, so "save it for a worse moment" is the
 *     false economy — the worse moment must occur BEFORE expiry or never.
 *
 * R3  EXPIRED — never redeem an expired reset (idempotent keys protect retries,
 *     but a redeem against an expired card is just a guaranteed API error).
 *
 * R4  ORDER — prefer the reset that clears the MOST (weekly clears both windows);
 *     among equals, the soonest-expiring first. Never spend a weekly-clearing
 *     reset when a 5h-only one would do — EXCEPT under R2 with <24h left on the
 *     weekly reset and no 5h reset at all.
 *
 * R5  PACE — at most ONE redeem per account per evaluation. The caller invokes the
 *     policy each poll cycle; the deterministic z.ai requestId makes an accidental
 *     double-fire harmless, but the policy still returns a single action.
 *
 * R6  WAIT FOR THE FREE REFILL (owner, 2026-10-23) — a wall redeem (R1) burns a card
 *     that z.ai's free weekly refill is about to make redundant: when the refill
 *     lands <24h away and weekly util < 0.98, HOLD the card. At >= 0.98 redeem
 *     immediately — the owner is never blocked waiting for a free refill that is
 *     merely hours away. Dying-value redeems (R2) are exempt: an expiring card's
 *     value cannot survive a wait.
 */
import { appliesTo as defaultAppliesTo } from './claude-reset-grants.js';
import { CLAIM_FRESH_MS } from './reset-timing.js';

export const POLICY = {
  wallWeekly: 0.90,       // weekly at 90% = at the wall (z.ai cards; UNCHANGED — pre-mortem #22)
  wallSes: 0.95,          // 5h at 95% = at the wall
  dyingWindowMs: 24 * 3600 * 1000, // redeem-don't-save horizon
  dyingMinUtilWeekly: 0.30, // below this a dying weekly refill buys too little
  dyingMinUtilSes: 0.50,    // 5h refills are cheap capacity; demand more waste first
  freeRefillWaitMs: 24 * 3600 * 1000, // R6: hold a wall redeem this close to the free refill
  freeRefillImmediate: 0.98,          // R6: ...unless this full — never block the owner
  // R7 (owner, 2026-11-13): a Claude WALL claim also waits for the free refill when
  // OTHER accounts can absorb the load. Room per peer: probe-fresh (≤5 min) readings,
  // weekly util with ≥ 35% headroom left, 5h util with ≥ 25% headroom to the 0.90
  // session bench, routable now; a scoped wall asks the same for that model's bucket.
  holdPeerWeeklyRoom: 0.35,
  holdPeerSessionRoom: 0.25,
  holdMinPeers: 2,
};

// The plain-words decision reason for an R7 hold — exported so status/log surfaces
// and tests share one string.
export const HOLD_POOL_HAS_ROOM = 'free refill <24h away, other accounts have room';

// Claude cedar_ember claims read their OWN wall (pre-mortem #22): 0.99, deliberately
// NOT POLICY.wallWeekly (0.90) which z.ai shares — moving the shared constant would
// redeem GLM cards at a different point. Claude benches at 0.999 (weeklyExhausted)
// and tiers critical at 0.95; 0.99 is "the weekly is effectively spent" for a claim.
export const CLAUDE_WALL_WEEKLY = 0.99;

// Claim freshness bound (C1, pre-mortem #5): the usage reading the claim decides on
// must be THIS fresh (≤ 5 min) — a reading taken before this sweep's probe (up to
// ~36 min stale after failed probes) would spend a reset right after a free refill.
// The value lives in the shared timing leaf; re-exported for existing callers.
export { CLAIM_FRESH_MS };

function msLeft(t, now) { return t == null ? Infinity : t - now; }

/** R7 (owner, 2026-11-13): should a GENERAL weekly WALL claim of `grant` wait for the
 *  free refill at `refillAt`? GENERAL ONLY (red-team r3, orchestrator decision): a
 *  per-model (Fable) wall and a dying-value grant claim exactly as before R7. The ONE
 *  hold rule, shared by the sweep (decideClaudeWithReason) and the
 *  reactive 429 path (account-manager tryReactiveClaim) so neither can spend what the
 *  other holds. Reads only the refill stamp, the grant's end and a LIVE peer count —
 *  never the walled account's own usage reading, which is routinely stale at the wall.
 *  Conservative: an unknown / past / ≥24h-away refill, a grant that dies before (or
 *  within dyingWindowMs after) the refill — it would sit unspent at ~0% used — no
 *  counter, or a count that isn't an integer ≥ the pool-wide budget ⇒ false (claim).
 *  BUDGET (red-team r2 #2): roomy peers must cover EVERY wall currently held in this
 *  pool — holdMinPeers × holdersInPool(), where holdersInPool counts the walls
 *  holding now INCLUDING this one. Without a holders counter, this wall alone (1). */
export function wallClaimHeld(refillAt, grant, now, { peersWithRoom, holdersInPool } = {}) {
  if (!(refillAt > now) || refillAt - now >= POLICY.freeRefillWaitMs) return false;
  if (grant?.endsAt != null && grant.endsAt - refillAt < POLICY.dyingWindowMs) return false;
  const holders = holdersInPool ? holdersInPool() : 1;
  if (!Number.isInteger(holders) || holders < 1) return false;
  const count = peersWithRoom?.();
  return Number.isInteger(count) && count >= POLICY.holdMinPeers * holders;
}

/** Decide the z.ai action. Returns {kind:'card', card, resetType} | null. */
export function decideZai(account, cards, now = Date.now()) {
  if (account?.enabled === false) return null;               // R0
  if (!cards || cards.error) return null;
  if (account?.outsideUsage?.outside) return null;          // R7: key used by someone else — a card would feed the leak
  const q = account.quota || {};
  const wkUtil = q.weeklyAbsent ? null : (q.providerWk ?? null);

  const weeklyCards = (cards.weekly || []).filter(c => !c.expired && c.recordId != null);
  // R4: soonest expiry first inside each class.
  weeklyCards.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));

  const weeklyCard = weeklyCards[0] || null;

  // --- weekly card: clears BOTH windows (z.ai docs; measured: glm1 100%->0% both)
  if (weeklyCard) {
    const atWall = wkUtil != null && wkUtil >= POLICY.wallWeekly;
    // Dying gate reads the WEEKLY window alone (owner 2026-10-30: resets are never
    // spent on session limits). The old Math.max(wk,ses) let a 96% 5h window redeem
    // a scarce weekly card — the exact trade the owner banned.
    const dying = msLeft(weeklyCard.expiresAt, now) < POLICY.dyingWindowMs
      && wkUtil != null && wkUtil >= POLICY.dyingMinUtilWeekly;
    if (atWall || dying) {
      // R6: a wall redeem waits when the FREE weekly refill is imminent and the
      // account isn't critically full (dying-value redeems stay exempt above).
      if (atWall && !dying && q.providerWkReset != null
          && msLeft(q.providerWkReset, now) < POLICY.freeRefillWaitMs
          && wkUtil < POLICY.freeRefillImmediate) {
        /* HELD for the free refill — do not redeem */
      } else {
        return { kind: 'card', card: weeklyCard, resetType: 'WEEK',
                 reason: atWall ? 'weekly at wall' : 'dying value' };
      }
    }
  }

  // --- 5h card: NEVER SPENT (owner, 2026-10-30: "never spend resets on session
  // limits, only on weekly"). The 5h window refills ~33x per week on its own, so a
  // 5h card buys minutes of capacity at the cost of a scarce card. Historically
  // both the atWall and dying-value branches spent them; both are gone.
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

/** Decide the Claude action AND say why when there is none.
 *  Returns { action: {kind:'grant', grant, scope, giveBack?, reason} | null,
 *            reason: string | null, heldScope?: string | null }  — `reason` names
 *  the rejection when action is null (C5: the skip log prints exactly this), or the
 *  claim reason; `heldScope` is 'general' whenever the R7 hold kept the general
 *  weekly wall unclaimed on this decision — on EVERY return after that point, a claim
 *  of a dying model grant included, so the caller always registers the hold (null: none).
 *
 *  C1 (amended, 2026-11-10): the claim is decided per grant by appliesTo (D1),
 *  NEVER by the server's nextGrantId order alone (pre-mortem #8: a Fable 429 could
 *  pick the general grant through that order). Freshness gates (pre-mortem #5):
 *  lastProbeOkAt within CLAIM_FRESH_MS, unified7dReset in the future (a window
 *  that just rolled means 0% used — don't spend on it), and a probe SENT after
 *  any claim we already made (no second claim for one wall).
 *  D4: a dying-value claim (not at the wall) waits when the free refill of the
 *  limit it clears is < 24h away; a wall claim never waits (limit effectively full).
 *  Session-only grants are NEVER claimed (owner 2026-10-30).
 *  R7 (owner, 2026-11-13, task-2026-11-13-maxpool-hold-resets-when-pool-has-room):
 *  the GENERAL weekly WALL claim is HELD when its free refill is < 24h away
 *  (freeRefillWaitMs) AND opts.peersWithRoom() answers at least POLICY.holdMinPeers
 *  × opts.holdersInPool() — other accounts in THIS pool can absorb the load. Model
 *  (Fable) walls are never held (red-team r3) — but while the general wall is held the
 *  model WALL claim is skipped too: the account is benched by its general wall, so a
 *  Fable reset would buy nothing until the general refill lands. The hold
 *  re-evaluates every decision tick (the caller supplies a live count), and fails
 *  CLAIM-side: capacity unknown (no counter, non-number answer) or a grant that
 *  would expire before the refill (or within a day after it — it would sit unspent
 *  at ~0% used) is claimed as today. Dying-value claims stay exempt: an expiring
 *  grant's value cannot survive any wait. */
export function decideClaudeWithReason(account, listing, now = Date.now(), opts = {}) {
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
  const weeklyWall = wkUtil != null && wkUtil >= CLAUDE_WALL_WEEKLY;
  // D4: the free refill of a limit < 24h away makes a not-at-the-wall spend redundant.
  const refillSoon = resetAt => resetAt != null && msLeft(resetAt, now) < POLICY.freeRefillWaitMs;
  // R7: hold the GENERAL wall claim for the imminent free refill while other accounts
  // in this pool can absorb the load (wallClaimHeld). A hold NOTES its reason and
  // moves on (red-team #2): the model-scoped loop below must still run, so a dying
  // model grant is spent. `generalHeld` rides on every return after it (red-team r3
  // #2) so the caller registers the hold even when this decision claims a dying model
  // grant — it feeds the pool-wide budget and the held-wall rescue (r2 #1/#2).
  let generalHeld = false;
  const out = (action, why) => ({ action, reason: why, heldScope: generalHeld ? 'general' : null });
  let reason = null;
  const note = r => { if (reason == null) reason = r; };

  // GENERAL (clears the general weekly, or gives_back_weekly): claim at the wall.
  // "Weekly reached" is the fresh unified7d reading ONLY — never the generic
  // `rejected` status (that conflates the 5h window and per-model caps; pre-mortem #8).
  const general = grants.filter(g => appliesTo(g).includes('general'));
  for (const g of general) {
    const giveBack = g.givesBackWeekly === true && !(Array.isArray(g.clears) && g.clears.includes('seven_day'));
    if (weeklyWall) {
      // R7: the free refill is imminent and the pool has room — hold the claim.
      if (wallClaimHeld(q.unified7dReset, g, now, { peersWithRoom: opts.peersWithRoom, holdersInPool: opts.holdersInPool })) {
        generalHeld = true; note(HOLD_POOL_HAS_ROOM); continue;
      }
      // A give-back-only grant (no seven_day in clears) returns only what the model
      // used — the claim snapshots unified7d so the next probe measures the drop.
      return out({ kind: 'grant', grant: g, scope: 'general', giveBack, reason: 'weekly at wall' }, 'weekly at wall');
    }
    const dying = msLeft(g.endsAt, now) < POLICY.dyingWindowMs
      && wkUtil != null && wkUtil >= POLICY.dyingMinUtilWeekly;  // weekly window only (owner 2026-10-30)
    if (!dying) continue;
    if (g.requiresLimit) { note('requires limit'); continue; }
    if (refillSoon(q.unified7dReset)) { note('free refill <24h away'); continue; }
    return out({ kind: 'grant', grant: g, scope: 'general', giveBack, reason: 'dying value' }, 'dying value');
  }
  if (weeklyWall && !general.length) note('general not held');

  // MODEL-SCOPED (D3): claim when THAT model's probe-measured weekly bucket is at
  // its wall. `reactive` entries (a 429's authoritative-high mark) do NOT count —
  // only the probe's own measurement (pre-mortem #3/#8: a scoped 429 classified by
  // guesswork must not spend a reset). D4 dying-value is evaluated per bucket
  // BEFORE the below-the-wall skip (it applies exactly there).
  const scopedFams = new Set();
  for (const g of grants) for (const s of appliesTo(g)) if (s !== 'general' && s !== 'session') scopedFams.add(s);
  for (const fam of scopedFams) {
    const e = q.scopedWeekly?.[fam];
    const measured = e && e.reactive !== true && e.utilization != null;
    if (!measured) continue;
    const cand = grants.find(g => appliesTo(g).includes(fam));
    if (!cand) continue;
    if (e.utilization >= CLAUDE_WALL_WEEKLY) {
      // Never held on its own (red-team r3) — but skipped while the GENERAL wall is
      // held: the account is benched by its general wall, so a model reset buys
      // nothing now; the hold re-evaluates every tick and, once the general refill
      // lands (or the hold lets go), this wall claims as before R7.
      if (generalHeld) continue;
      return out({ kind: 'grant', grant: cand, scope: fam, reason: `${fam} weekly at wall` }, `${fam} weekly at wall`);
    }
    const dying = msLeft(cand.endsAt, now) < POLICY.dyingWindowMs
      && e.utilization >= POLICY.dyingMinUtilWeekly;
    if (!dying) continue;
    if (cand.requiresLimit) { note('requires limit'); continue; }
    if (refillSoon(e.resetAt)) { note('free refill <24h away'); continue; }
    return out({ kind: 'grant', grant: cand, scope: fam, reason: 'dying value' }, 'dying value');
  }
  // A scoped bucket measured at the wall with no grant for it.
  for (const [fam, e] of Object.entries(q.scopedWeekly || {})) {
    if (e && e.reactive !== true && e.utilization != null && e.utilization >= CLAUDE_WALL_WEEKLY
      && !grants.some(g => appliesTo(g).includes(fam))) note(`${fam} not held`);
  }

  // Session-only grants: NEVER claimed (owner 2026-10-30) — falls through.
  return out(null, reason ?? 'below wall');
}
