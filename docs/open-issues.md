# Maxpool — open issues & roadmap

Living tracker for in-flight work. One core issue at a time. Newest status on top of each item.

## Core philosophy (the goal everything serves)

**Avoid being rate-limited.** The way to do that: keep as many accounts *healthy* as possible and spread load so requests parallelize across them. Concentrating load on one account is what triggers short-term (per-session/per-minute) rate limits.

- **Default mode = healthy spread.** Distribute across all non-exhausted accounts to keep everyone healthy and maximize parallelism. Don't pick "which accounts to starve."
- **Use-it-or-lose-it = a LATE, secondary signal.** Only lean hard into an account when its *binding* window (session 5h or weekly 7d — whichever is most constraining) is genuinely about to reset soon; then drain that soon-to-reset quota before it's wasted.
- Never let a *raw-healthy* account (lots of real quota left, reset far off) get benched to last-resort purely because of pace.

---

## OPEN

### 1. Routing: spread-to-stay-healthy; use-it-or-lose-it only near reset  ⟵ CORE
**Status:** Phase 1 SHIPPED (v1.2.0). Phases 2-3 deferred pending live observation.
**Problem:** The scheduler over-weighted pace + near-reset (`scarcity×6` was the dominant term), so it *concentrated* load on the single soonest-to-reset account and benched raw-healthy accounts (mk@gomokka at 69% raw) to last-resort "critical" via pace. Concentration is exactly what triggers the short-term throttle — the opposite of the goal.
**Design:** 3-advocate council + lead-architect synthesis (2026-06-26). Continuous, load-gated additive scoring — no mode switches. Phased "prove-it" rollout.
**Phase 1 (DONE, v1.2.0):**
- In-flight concurrency is now the DOMINANT score term (`concurrencyWeight=2`) + a steep per-account soft cap (`capPenaltyWeight=10` past `perAccountConcurrencyTarget D=3`) so no account absorbs a deep burst.
- Burn-pace demoted from `×6` dominant to a soft `paceCostWeight=1.5` de-preference (never a bench).
- Eligibility gates on RAW weekly state (`_weeklyRawState`), so a raw-healthy fast-burner stays in the spread pool.
- Screenshot-replay regression test: 6 concurrent over the 4-account state fans out across max@dubner.io + mk@gomokka, no account absorbs the burst.
- `D=3` chosen from observed evidence (max@dubner.io throttled ~6 concurrent); tunable.
**Phase 2 — safe-point session rebalancing (DONE, v1.4.0):**
- A bound session no longer sticks to a HOT account forever. `_selectNext` migrates it to a much-healthier account, but ONLY on a **thinking-safe** request (per-request body carries no signed `thinking` block; fail-closed on unparsed bodies) so Anthropic's non-retryable "invalid signature" can never fire.
- Flap-stable: HOT = `_isNearQuota` (weekly reserve/critical or 5h-cap, NOT live in-flight); migrate only to a `normal/soft/unknown`-weekly alt that is ≥2× cheaper AND a strictly healthier tier; suppressed during queue admission; `_bindSession` re-homes on a same-priority *choice* migration but not on failover (snap-back-on-recovery preserved).
- This is the fix for "I added an account mid-session but it didn't get picked up": added/cooled capacity now drains in-progress hot sessions at their next safe turn.
- Pre-mortem (9 failure modes) + focused adversarial review (SHIP); red→green tests for migrate-when-safe-and-hot, never-on-signed-thinking, fail-closed-unparsed, never-when-healthy, queue-suppressed, no-flap, describeRequest fail-closed.
**Phase 3 (remaining, optional — only if observed):**
- Per-account `throttlePressure` (decaying ~90s) so the fleet steers *around* a freshly-429'd account (today the throttle is a single global pause).
- Herd-jitter on the rebalance burst-drain: many sessions on one hot account + a fresh account appear → they migrate in a burst (self-damped by the score-margin backpressure, fine for a small pool, but un-staggered). Add a per-tick migration cap/jitter + a bounded-migrations-per-tick test if the account pool grows. Reviewer-flagged nit, not ship-blocking.
**Open knob:** `D` (per-account concurrency where Anthropic 429s). Default 3; add telemetry to auto-tune from live 429-rate-vs-depth.

### 2. Hold the session on rate-limit instead of killing it (+ routing-oracle correctness) — DONE
**Status:** SHIPPED (v1.3.0, branch feat/hold-session-and-routing merged to main). 165 tests.
**What shipped:** A rate-limited STREAMING session is now HELD ALIVE on an SSE heartbeat (up to `streamHoldMaxMs`, 7d) and resumed the instant any account frees — never killed. The hold-vs-error oracle (`nextRetryForRequest`/`_retryInfo`) error-fasts ONLY on genuinely-unrecoverable states (all accounts logged out / weekly-exhausted with unknown reset / no eligible route), and HOLDS finite for everything recoverable (weekly-critical last-resort, 5h cap, rate-limit, cooldown, concurrency cap). Retry-after now reflects the SOONEST real recovery (3-bucket min-merge), not a far weekly reset.
**Rigor:** 5 full code-review council rounds + focused adversarial passes; every confirmed finding fixed with a red-before/green-after test. Fixes included: session-kill on weekly-critical+unknown-reset, fairness-gate starvation, misleading multi-day retry-after, auth-dead spin, Bug-A heartbeat SSE interleave, post-resume-failover drop, lease-leak on client disconnect, healthy-concurrency-cap symmetry + 15-min bound, non-SSE-resume framing, EPIPE ghost eviction.

### 3. Remove the import mechanic (browser login only) — DONE
**Status:** SHIPPED (commit b6353fa on main). CLI `import` + TUI `i` + `importCredentials`/Keychain read + the upsert path + tests removed; no import-mechanic refs remain in src. Browser `maxpool login` (+ `login --api`) is the only add-account path.
**Problem:** The Keychain `import` path (a fallback I added) snapshots the CLI's own OAuth token, creating a shared-credential account that breaks when the CLI rotates the token (this is what kept erroring max@dubner.io). The original fork's browser login worked for all accounts.
**Plan:** remove CLI `import` + TUI `i` "Import Claude login" + `importCredentials`/Keychain read + the upsert-via-import path + tests + docs. Keep `maxpool login` (browser) and `login --api`.

### 4. max@dubner.io stability
**Status:** solution known; blocked on a one-time user action.
**Fix:** re-add max@dubner.io via **browser login** (TUI `a`→`l` on ≥1.0.5, or `maxpool login`) so maxpool holds its *own* independent grant, decoupled from the CLI's Keychain token. Resolves once done. Tied to #3.

---

### 5. TUI clarity: "throttled" and "Load X/Y" under-communicate — DONE
**Status:** SHIPPED (v1.3.1).
- **"throttled"** now renders `throttled Ns` (single-unit countdown from `rateLimitedUntil`, s/m/h/d, ≤3 chars so it never shifts the quota-bar columns) — reads as auto-recovering, not stuck.
- **"Load X/Y"** → **`Now N (Ww)`**: N in-flight requests, W combined weight, clearly distinct from the `15m`/`1h` throughput counts that follow.
- Focused code-review pass; red→green tests for the countdown + label + the multi-hour-overflow guard.

### 6. Seamless version upgrade — near-zero-downtime reload (single-writer baton) — DONE
**Status:** SHIPPED (v1.5.0). Supervisor-owns-socket + single-writer baton: the supervisor binds :3456 for life and hands the socket to a worker over IPC; on reload it spawns a fresh headless worker and runs a baton so exactly ONE worker holds the writer lease (token refresh / config+state persist / probe) — reads overlap (streams never cut), writes are single-owner (the single-use OAuth refresh token is never double-spent). Any failure falls back to today's tested exit-75 restart (~2s self-heal). Freeze autoUpdate + double-probe during reload.
**Rigor:** brick-safety EMPIRICALLY PROVEN (`reload-refresh-torture` — concurrent refresh across a reload rotates the token EXACTLY once, no invalid_grant). Focused adversarial review = SHIP (single-writer integrity + socket ownership + baton rollback all sound + test-covered).
**Real bugs found & fixed this pass (red→green):** (1) the reload/quit FINAL quota flush was a silent no-op — `persistQuotaState()` ran AFTER `releaseLease()` dropped the lease, so the new primary booted from ≤60s-stale quota and the state generation never advanced (now forced); (2) the forced flush bypasses the cross-worker gen-guard so a racing interval write can't get it refused; (3) test bugs: M4 sent an unhandled SIGUSR2 that terminated the supervisor; the child exit-wait hung the suite; subprocess files contended → now one-process-per-file via `run-tests.sh`. Full suite green.

## DONE (this session, for context)

- Keychain import fix (1.0.1) — **to be reverted per #3.**
- Quit/drain bounded to 15s so `q`/Ctrl-C actually quits under load (1.0.2).
- Backward-compat `x-teamclaude-*` headers so running sessions survive the rename (1.0.3).
- TUI active-account indicator + browser login (`l`) + rename (`n`); CLI `rename` (1.0.5).
- README setup guide + FAQ + account-risk/ToS disclaimer (1.0.6 / 1.0.7).
- Queue: weekly caps now wait+retry instead of fail-fast; non-stream cap, capacity clamp, backpressure, stale-head reaper, poll jitter, honest messages (1.1.0).
- ToS review (4-advocate council + judge): personal use = contested gray area; public promotion = do-not. Launch held.
