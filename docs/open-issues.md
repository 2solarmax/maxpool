# Maxpool — open issues & roadmap

Living tracker for in-flight work. One core issue at a time. Newest status on top of each item.

## Core philosophy (the goal everything serves)

**Avoid being rate-limited.** The way to do that: keep as many accounts *healthy* as possible and spread load so requests parallelize across them. Concentrating load on one account is what triggers short-term (per-session/per-minute) rate limits.

- **Default mode = healthy spread.** Distribute across all non-exhausted accounts to keep everyone healthy and maximize parallelism. Don't pick "which accounts to starve."
- **Use-it-or-lose-it = a LATE, secondary signal.** Only lean hard into an account when its *binding* window (session 5h or weekly 7d — whichever is most constraining) is genuinely about to reset soon; then drain that soon-to-reset quota before it's wasted.
- Never let a *raw-healthy* account (lots of real quota left, reset far off) get benched to last-resort purely because of pace.

---

## OPEN

### 1. Routing: spread-to-stay-healthy; use-it-or-lose-it only near reset  ⟵ CORE, START HERE
**Status:** designing (not implemented)
**Problem:** The scheduler over-weights pace + near-reset, so it *concentrates* load on the single soonest-to-reset account (e.g. max@dubner.io) and demotes raw-healthy accounts (e.g. mk@gomokka at 69% raw, resets in 5d) to last-resort "critical" via pace. That concentration is exactly what risks rate-limiting the hammered account — the opposite of the goal.
**Plan:**
- Make the "spread" (even-distribution) term dominate for all *healthy* accounts, so load fans out across them.
- Demote the pace / use-it-or-lose-it influence to a weak preference that only strongly activates when an account's binding window reset is *imminent* (e.g. within a few hours).
- Stop classifying a raw-healthy account as "critical" purely on pace (retune `weeklyBurnDebtWeight` / pace thresholds, or change the tier gate so reserve/pace accounts share load instead of being overflow-only).
- Validate by simulation/tests across realistic quota mixes (the 4-account state in the 2026-06-26 screenshot is a good fixture).

### 2. Wait-don't-error for the short-term "Server is temporarily limiting requests" throttle
**Status:** partially done — weekly-cap wait shipped in 1.1.0; the short-term throttle path is NOT yet covered the way the user wants.
**Problem:** "Server is temporarily limiting requests (not your usage limit)" is Anthropic's shared/short-term throttle (request-wide 429s → `markUpstreamThrottled`). That path queues only `capacityMaxWaitMs` (15 min) and then errors, killing the session. It is NOT the 5h/weekly cap.
**Plan:** confirm with real runtime evidence (the actual upstream status/headers), then make transient throttles wait+retry up to the user's tolerance instead of dying at 15 min — while keeping genuine "broken upstream" fast-fail distinct.

### 3. Remove the import mechanic (browser login only)
**Status:** agreed, not started.
**Problem:** The Keychain `import` path (a fallback I added) snapshots the CLI's own OAuth token, creating a shared-credential account that breaks when the CLI rotates the token (this is what kept erroring max@dubner.io). The original fork's browser login worked for all accounts.
**Plan:** remove CLI `import` + TUI `i` "Import Claude login" + `importCredentials`/Keychain read + the upsert-via-import path + tests + docs. Keep `maxpool login` (browser) and `login --api`.

### 4. max@dubner.io stability
**Status:** solution known; blocked on a one-time user action.
**Fix:** re-add max@dubner.io via **browser login** (TUI `a`→`l` on ≥1.0.5, or `maxpool login`) so maxpool holds its *own* independent grant, decoupled from the CLI's Keychain token. Resolves once done. Tied to #3.

---

### 5. TUI clarity: "throttled" and "Load X/Y" under-communicate
**Status:** logged (not started). Behavior is correct; the *display* is unclear.
- **"throttled"** is a temporary auto-recovering cooldown (account hit a 429 → rested a few seconds → request failed over to another account → auto-flips back to active). The TUI shows bare `throttled` with no countdown, so it looks stuck. Fix: show `throttled Ns` (the `rateLimitedUntil` cooldown is known), like the other countdowns.
- **"Load X/Y"** = X in-flight requests / Y their combined weight (~payload size). It's cryptic (weight denominator unexplained; "Load" collides with the 15m/1h throughput counts). Fix: clearer label and/or a one-line legend/help.

## DONE (this session, for context)

- Keychain import fix (1.0.1) — **to be reverted per #3.**
- Quit/drain bounded to 15s so `q`/Ctrl-C actually quits under load (1.0.2).
- Backward-compat `x-teamclaude-*` headers so running sessions survive the rename (1.0.3).
- TUI active-account indicator + browser login (`l`) + rename (`n`); CLI `rename` (1.0.5).
- README setup guide + FAQ + account-risk/ToS disclaimer (1.0.6 / 1.0.7).
- Queue: weekly caps now wait+retry instead of fail-fast; non-stream cap, capacity clamp, backpressure, stale-head reaper, poll jitter, honest messages (1.1.0).
- ToS review (4-advocate council + judge): personal use = contested gray area; public promotion = do-not. Launch held.
