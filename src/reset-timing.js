// Reset-machinery timing constants — ONE leaf module (judge note, 2026-11-10: the
// 5*60_000 literal had spread across account-manager.js, prober.js and tui.js).
// Leaf by construction: imports nothing, so every consumer can share it.

// A2: grants are listed at most this often per account (the call shares the
// per-IP rate-limited /api/oauth/usage endpoint with the usage probe).
export const GRANTS_EVERY_MS = 5 * 60_000;
// A stale/errored listing retries at this shorter cadence so a transient blank
// recovers fast.
export const GRANTS_RETRY_MS = 30_000;
// C3: the cap lift survives listing failures this long before ending.
export const LIFT_GRACE_MS = 10 * 60_000;
// C2: a stored listing may serve a reactive claim up to this age.
export const CLAIM_STALE_LISTING_MAX_MS = 6 * 3600_000;
// C6: a FAILED Claude claim backs off per (account, grantId) on these steps,
// capped at CLAIM_BACKOFF_CAP_MS (matches the z.ai card-redeem schedule).
export const CLAIM_BACKOFF_STEPS_MS = [15 * 60_000, 30 * 60_000, 60 * 60_000];
export const CLAIM_BACKOFF_CAP_MS = 6 * 3600_000;
// B3: a listing older than LISTING_FRESH_MULT × GRANTS_EVERY_MS reads not-fresh
// in the TUI and cannot start a cap lift (C3).
export const LISTING_FRESH_MULT = 3;
export const LISTING_FRESH_MS = LISTING_FRESH_MULT * GRANTS_EVERY_MS;
// C1: the usage reading a claim decides on must be this fresh.
export const CLAIM_FRESH_MS = 5 * 60_000;
// C2: a reactive claim runs off the request path and gives up after this long,
// so a hung profile GET / POST can never hold the claim lock for minutes.
export const REACTIVE_CLAIM_TIMEOUT_MS = 10_000;
