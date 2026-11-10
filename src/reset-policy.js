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

export const POLICY = {
  wallWeekly: 0.90,       // weekly at 90% = at the wall (z.ai cards; UNCHANGED — pre-mortem #22)
  wallSes: 0.95,          // 5h at 95% = at the wall
  dyingWindowMs: 24 * 3600 * 1000, // redeem-don't-save horizon
  dyingMinUtilWeekly: 0.30, // below this a dying weekly refill buys too little
  dyingMinUtilSes: 0.50,    // 5h refills are cheap capacity; demand more waste first
  freeRefillWaitMs: 24 * 3600 * 1000, // R6: hold a wall redeem this close to the free refill
  freeRefillImmediate: 0.98,          // R6: ...unless this full — never block the owner
};

// Claude cedar_ember claims read their OWN wall (pre-mortem #22): 0.99, deliberately
// NOT POLICY.wallWeekly (0.90) which z.ai shares — moving the shared constant would
// redeem GLM cards at a different point. Claude benches at 0.999 (weeklyExhausted)
// and tiers critical at 0.95; 0.99 is "the weekly is effectively spent" for a claim.
export const CLAUDE_WALL_WEEKLY = 0.99;

// Claim freshness bound (C1, pre-mortem #5): the usage reading the claim decides on
// must be THIS fresh (≤ 5 min) — a reading taken before this sweep's probe (up to
// ~36 min stale after failed probes) would spend a reset right after a free refill.
export const CLAIM_FRESH_MS = 5 * 60_000;

function msLeft(t, now) { return t == null ? Infinity : t - now; }

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
 *
 *  C1 (amended, 2026-11-10): the claim is decided per grant by appliesTo (D1),
 *  NEVER by the server's nextGrantId order alone (pre-mortem #8: a Fable 429 could
 *  pick the general grant through that order). Freshness gates (pre-mortem #5):
 *  lastProbeOkAt within CLAIM_FRESH_MS, unified7dReset in the future (a window
 *  that just rolled means 0% used — don't spend on it), and lastProbeOkAt newer
 *  than any claim we already made (no second claim for one wall).
 *  Session-only grants are NEVER claimed (owner 2026-10-30). */
export function decideClaude(account, listing, now = Date.now(), opts = {}) {
  if (account?.enabled === false) return null;               // R0
  if (!listing || listing.error || listing.stale || listing.eligible === false) return null; // only a FRESH listing may claim
  if (listing.cooldownUntil != null && listing.cooldownUntil > now) return null;
  const q = account.quota || {};

  // FRESHNESS (pre-mortem #5): decide on THIS sweep's probe, never an aging one.
  // `freshNow` defaults to the real clock; tests may inject a frozen one.
  const freshNow = opts.now ?? now;
  const lastProbeOkAt = q.lastProbeOkAt ?? null;
  if (lastProbeOkAt == null || freshNow - lastProbeOkAt > CLAIM_FRESH_MS) return null;
  // A weekly window that already rolled over is empty — a claim right now buys
  // nothing (spent right after the free refill, at 0% used).
  if (q.unified7dReset != null && q.unified7dReset <= freshNow) return null;
  // No second claim for one wall: a probe newer than the last claim must land first.
  const lastClaimAt = account.lastClaimAt ?? null;
  if (lastClaimAt != null && lastProbeOkAt <= lastClaimAt) return null;

  // Per-grant applicability (D1 via appliesTo), soonest-expiring first among
  // SAME-scope grants. Grants with unknown scope (appliesTo []) are never chosen.
  const grants = (listing.grants || [])
    .filter(g => g && g.usableNow !== false && !g.paused && !g.expired
      && !g.blocking && !g.unavailableReason && (g.endsAt == null || g.endsAt > now))
    .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  if (!grants.length) return null;

  const appliesTo = opts.appliesTo || defaultAppliesTo;
  const wkUtil = q.unified7d ?? null;
  const weeklyWall = wkUtil != null && wkUtil >= CLAUDE_WALL_WEEKLY;

  // GENERAL (clears the general weekly, or gives_back_weekly): claim at the wall.
  // "Weekly reached" is the fresh unified7d reading ONLY — never the generic
  // `rejected` status (that conflates the 5h window and per-model caps; pre-mortem #8).
  const general = grants.filter(g => appliesTo(g).includes('general'));
  for (const g of general) {
    const atWall = weeklyWall;
    const dying = msLeft(g.endsAt, now) < POLICY.dyingWindowMs
      && wkUtil != null && wkUtil >= POLICY.dyingMinUtilWeekly;  // weekly window only (owner 2026-10-30)
    if (atWall || (dying && !g.requiresLimit)) {
      return { kind: 'grant', grant: g, scope: 'general', reason: atWall ? 'weekly at wall' : 'dying value' };
    }
  }

  // MODEL-SCOPED (D3): claim when THAT model's probe-measured weekly bucket is at
  // its wall. `reactive` entries (a 429's authoritative-high mark) do NOT count —
  // only the probe's own measurement (pre-mortem #3/#8: a scoped 429 classified by
  // guesswork must not spend a reset).
  const scopedFams = new Set();
  for (const g of grants) for (const s of appliesTo(g)) if (s !== 'general' && s !== 'session') scopedFams.add(s);
  for (const fam of scopedFams) {
    const e = q.scopedWeekly?.[fam];
    const measured = e && e.reactive !== true && e.utilization != null;
    if (!measured || e.utilization < CLAUDE_WALL_WEEKLY) continue;
    const cand = grants.find(g => appliesTo(g).includes(fam));
    if (!cand) continue;
    const dying = msLeft(cand.endsAt, now) < POLICY.dyingWindowMs
      && e.utilization >= POLICY.dyingMinUtilWeekly;
    if (dying && !cand.requiresLimit && e.utilization < CLAUDE_WALL_WEEKLY) {
      return { kind: 'grant', grant: cand, scope: fam, reason: 'dying value' };
    }
    return { kind: 'grant', grant: cand, scope: fam, reason: `${fam} weekly at wall` };
  }

  // Session-only grants: NEVER claimed (owner 2026-10-30) — falls through to null.
  return null;
}
