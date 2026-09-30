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
 */
export const POLICY = {
  wallWeekly: 0.90,       // weekly at 90% = at the wall
  wallSes: 0.95,          // 5h at 95% = at the wall
  dyingWindowMs: 24 * 3600 * 1000, // redeem-don't-save horizon
  dyingMinUtilWeekly: 0.30, // below this a dying weekly refill buys too little
  dyingMinUtilSes: 0.50,    // 5h refills are cheap capacity; demand more waste first
};

function msLeft(t, now) { return t == null ? Infinity : t - now; }

/** Decide the z.ai action. Returns {kind:'card', card, resetType} | null. */
export function decideZai(account, cards, now = Date.now()) {
  if (account?.enabled === false) return null;               // R0
  if (!cards || cards.error) return null;
  const q = account.quota || {};
  const ses = q.providerSes ?? null;
  const wk = q.weeklyAbsent ? null : (q.providerWk ?? null);
  const wkUtil = wk; const sesUtil = ses;

  const weeklyCards = (cards.weekly || []).filter(c => !c.expired && c.recordId != null);
  const sesCards = (cards.fiveHour || []).filter(c => !c.expired && c.recordId != null);
  // R4: soonest expiry first inside each class.
  weeklyCards.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));
  sesCards.sort((a, b) => (a.expiresAt ?? Infinity) - (b.expiresAt ?? Infinity));

  const weeklyCard = weeklyCards[0] || null;
  const sesCard = sesCards[0] || null;

  // --- weekly card: clears BOTH windows (z.ai docs; measured: glm1 100%->0% both)
  if (weeklyCard) {
    const worst = Math.max(wkUtil ?? 0, sesUtil ?? 0);
    const atWall = wkUtil != null && wkUtil >= POLICY.wallWeekly;
    const dying = msLeft(weeklyCard.expiresAt, now) < POLICY.dyingWindowMs
      && worst >= POLICY.dyingMinUtilWeekly;
    if (atWall || dying) {
      return { kind: 'card', card: weeklyCard, resetType: 'WEEK',
               reason: atWall ? 'weekly at wall' : 'dying value' };
    }
  }

  // --- 5h card: clears only the session window
  if (sesCard) {
    const atWall = sesUtil != null && sesUtil >= POLICY.wallSes
      && (weeklyCard == null);   // R4: a weekly card can do this job AND more
    const dying = msLeft(sesCard.expiresAt, now) < POLICY.dyingWindowMs
      && (sesUtil ?? 0) >= POLICY.dyingMinUtilSes;
    if (atWall || dying) {
      return { kind: 'card', card: sesCard, resetType: 'FIVE_HOUR',
               reason: atWall ? 'session at wall' : 'dying value' };
    }
  }
  return null;
}

/** Decide the Claude action. Returns {kind:'grant', grant} | null. */
export function decideClaude(account, listing, now = Date.now()) {
  if (account?.enabled === false) return null;               // R0
  if (!listing || listing.error || listing.eligible === false) return null;
  if (listing.cooldownUntil != null && listing.cooldownUntil > now) return null;
  const grants = (listing.grants || [])
    .filter(g => g.usableNow && !g.paused && !g.expired)
    .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity));
  // The server names the next grant it would spend; honoring it avoids surprises.
  const chosen = grants.find(g => listing.nextGrantId == null || g.id === listing.nextGrantId) || grants[0];
  if (!chosen) return null;

  const q = account.quota || {};
  const wkUtil = q.unified7d ?? null;
  const sesUtil = q.unified5h ?? null;
  const clearsWk = chosen.clears?.includes('seven_day');

  let atWall = false;
  if (clearsWk) atWall = wkUtil != null && wkUtil >= POLICY.wallWeekly;
  else atWall = sesUtil != null && sesUtil >= POLICY.wallSes;

  // use_requires_limit: some grants may only fire AT the wall (server-enforced).
  const dying = msLeft(chosen.endsAt, now) < POLICY.dyingWindowMs
    && Math.max(wkUtil ?? 0, sesUtil ?? 0) >= (clearsWk ? POLICY.dyingMinUtilWeekly : POLICY.dyingMinUtilSes);
  // A requires-limit grant cannot be redeemed pre-wall even for dying value.
  if (atWall || (dying && !chosen.requiresLimit)) {
    return { kind: 'grant', grant: chosen, reason: atWall ? 'at wall' : 'dying value' };
  }
  return null;
}
