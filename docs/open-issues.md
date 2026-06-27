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

### 3. Remove the import mechanic (browser login only)
**Status:** agreed, not started.
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

### 6. Seamless version upgrade — near-zero-downtime reload (single-writer baton)
**Status:** WIP re-integrated onto current main (2026-06-27) — branch `feat/reload-reintegrate` (clean merge of main: import-removal #3 + #2 + #1; no conflicts, removed-import refs gone, modules load). **NOT shipped — highest-risk item (a wrong move BRICKS accounts), and incomplete.**
**Remaining before ship:** the 6 council must-fixes (refresh-drain-before-release; supervisor-stop-own-accept-loop — currently `B2: steady-state throughput 100% worker-served` FAILS; config-write barrier; stateGeneration re-read; child.on('error')/uncaughtException; setWriterLease(false) at boot) → green the worker-spawning reload suite → **full multi-persona brick-safety council** (the concurrent-refresh torture proof) → merge + release. The brick-safety council needs healthy Claude quota (single-agent focused reviews are not enough for this risk class). Best done as a dedicated session. Today's behavior (2s self-healing restart blip) is benign, so #6 is an optimization, not a fix.
**Today:** restart respawns the worker (picks up the new version) but `closeAllConnections()` abruptly cuts in-flight streams → each active request retries once. Nothing lost; visible 2s self-healing blip.
**Pre-mortem (3 personas + architect, 2026-06-26) — DECISIVE:** TRUE symmetric two-worker overlap is unsafe. Both workers load the same `config.json` → same **single-use** OAuth refresh token; Anthropic rotates on every use; with 22 sessions, near-simultaneous refreshes → one worker invalidates the other's token → **bricked accounts** (manual re-login). Same for config/state last-writer-wins clobber. Strictly worse than today's self-healing blip. → Do NOT build symmetric overlap.
**Chosen design — supervisor-owns-socket + single-writer baton (near-zero-downtime):**
- Supervisor binds :3456 once and **owns the listening fd for life** (never closes it) → no ECONNREFUSED, deterministic routing, clean failure if it dies. Workers receive the handle via IPC (NOT node:cluster — its round-robin starves the drain).
- New worker boots **headless, no writer lease**: does NOT refresh tokens / write config / write state / probe. Quota handed in-memory via existing `exportQuotaState`/`restoreQuotaState`.
- Cutover: new conns → new worker; old worker stops accepting, `Connection: close` + `closeIdleConnections()`, **stops refreshing/probing/persisting** (baton release), flushes final config+state once, then new worker **acquires the writer lease** (flock/pidfile + generation counter on config/state as defense-in-depth), re-enables refresh/probe/persist, takes the TUI only after old `tui.stop()`.
- Old worker drains its bounded in-flight on existing access tokens (no refresh needed), exits; supervisor reaper SIGKILLs it past a hard cap.
- **Reads overlap (streams never cut); writes single-owner (tokens never double-spent).**
- **Safe fallback:** any failure mid-swap → today's tested abrupt restart (exit 75, clients retry ~2s). Never wedged, never both-writing. New worker NEVER `exit(1)` (would kill the supervisor loop) — always exit 75.
- Freeze autoUpdate + double-probe during reload.
**Must-have tests:** concurrent-refresh torture (only lease holder rotates; no invalid_grant), config/state gen-guard lost-update, drain under SSE+keep-alive+queue, socket-ownership + rollback on kill (zero ECONNREFUSED), TTY single-owner + terminal restored on every exit path, reload-storm guard.

## DONE (this session, for context)

- Keychain import fix (1.0.1) — **to be reverted per #3.**
- Quit/drain bounded to 15s so `q`/Ctrl-C actually quits under load (1.0.2).
- Backward-compat `x-teamclaude-*` headers so running sessions survive the rename (1.0.3).
- TUI active-account indicator + browser login (`l`) + rename (`n`); CLI `rename` (1.0.5).
- README setup guide + FAQ + account-risk/ToS disclaimer (1.0.6 / 1.0.7).
- Queue: weekly caps now wait+retry instead of fail-fast; non-stream cap, capacity clamp, backpressure, stale-head reaper, poll jitter, honest messages (1.1.0).
- ToS review (4-advocate council + judge): personal use = contested gray area; public promotion = do-not. Launch held.
