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
**Status:** Phase 1 SHIPPED (v1.2.0), Phase 2 SHIPPED (v1.4.0). Phase 3 CLOSED 2026-06-27 (not worth building — see below).
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
**Phase 3 — CLOSED 2026-06-27 (not worth building; the premise didn't survive a code read):**
- ~~Per-account `throttlePressure` so the fleet steers around a freshly-429'd account instead of a "single global pause".~~ FALSE PREMISE: a single 429 already benches only that account (`markRateLimited`, per-account). The global pause (`shouldPromoteUpstreamFailure`) opens ONLY when every eligible account fails the same request AND no healthy account is untried/recently-succeeded — those veto it. So healthy accounts are not swept into it. The only marginal add (de-prefer an account that JUST recovered) is minor tuning, not a correctness gap.
- ~~Herd-jitter on the rebalance burst-drain.~~ Only bites with a much larger pool; already damped by the score-margin backpressure. Not worth it at ~22 accounts.
- The "defer pending live observation" framing was hollow — nobody watches a passive metric. The TUI's `Anthropic upstream throttled` line + throttle count IS the live signal; if it recurs WITH healthy accounts idle, the fix would be to the global-pause/probe-recovery window, not these scoring tweaks. Re-open only against a concrete observed regression.
**Open knob (kept):** `D` (per-account concurrency where Anthropic 429s). Default 3; tune from the TUI throttle signal if 429s cluster at a given depth.

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

### 7. Signed-thinking session error-killed behind the FIFO queue (false "all at their limit") — DONE
**Status:** SHIPPED (v1.5.1). User-reported + REPRODUCED 2026-06-27: a thinking session died with "No Claude account can take this request — all N are at their 5h or weekly limit ... beyond the hold window" while `max@dubner.io` (88% free) and `2solarmax` (96% free) sat idle.
**Root cause:** `nextRetryForRequest` (the HOLD-vs-ERROR oracle) iterates accounts via `_matchesRequest`, which excludes ALL Claude accounts for an un-registered newcomer whenever a FIFO queue already exists (fairness gate: `queueState.waiting.length && !queueTicket`). A thinking request also can't use GLM/Kimi, so matchingRoutes=0 → retryAfterMs=Infinity → the server error-fasts (kills the session). The fairness gate is TRANSIENT (it lifts the instant the request registers a queue ticket), but the oracle read it as terminal. The "~1m / beyond the hold window" text was the hardcoded 60s Infinity-fallback, not a real reset.
**Fix:** a thinking newcomer behind the fairness gate now contributes a bounded re-poll hold (`queued_behind_fairness`) so the oracle returns FINITE → it queues and waits its FIFO turn instead of dying. Scoped to thinking-only on purpose: a non-thinking request can fall back to a provider or be cheaply retried, so the gate keeps shedding it as backpressure (an unscoped version regressed the 200-concurrent reload test 0→~54 client timeouts).
**Rigor:** reproduced via a standalone harness BEFORE the fix; pre-mortem (8 failure modes, scoped out admissionPaused + provider leak); adversarial code-review = SHIP; +6 red/green tests (hold-finite, FIFO-advances-to-served, non-thinking-unchanged, admissionPaused-stays-terminal, auth-dead-terminal, weekly-exhausted-not-faked). Full suite green.

### 8. Network interruption (VPN/internet drop) kills a thinking session — DONE
**Status:** SHIPPED (v1.5.2). User-reported 2026-06-27 (same "all N at their 5h or weekly limit" error, but triggered by switching off a VPN / losing connectivity). The 1.5.1 fix was incomplete: it only held when a HEALTHY account sat behind the queue.
**Root cause (two halves):** (a) a network blip cools EVERY account (`markTransientFailure` → finite `cooldownUntil`) and a queue forms; the thinking newcomer is fairness-gated → `_matchesRequest` skips all accounts → their real finite cooldown is LOST → `nextRetryForRequest`=Infinity → kill. 1.5.1 only caught `_isAvailable`-healthy accounts. (b) the in-flight request that ATE the blip was 503'd because `queueAndRetry` refused EVERY `cause==='network'` hold.
**Fix:** (a) for a thinking request, a fairness-gated account now flows into the normal `_retryInfo` bucketing (its real cooldown/rate-limit/5h reset drives a finite hold), never the multi-day weekly reset, never `available:true` (no oracle/selector desync). (b) a STREAMING, replayable network-failed request now HOLDS and resumes when connectivity returns instead of 503; the eventual give-up message is network-honest ("check your internet"), not the quota lie. Non-streaming network failures still fail fast.
**Rigor:** reproduced the all-cooled-down state BEFORE the fix (Infinity→KILL); pre-mortem (2 BLOCKERs caught: weekly-exhausted over-hold + dual available-return guards; MAJOR: server.js network-refusal in-scope); adversarial code-review = SHIP, no must-fix; +5 red/green tests (all-cooled-holds, soonest-cooldown min-merge, oracle/selector agree, streaming-blip holds+resumes, non-streaming fails fast) + rewrote the recovery-network-failure test. 136 tests + full suite green.
**Deferred (named reason):** a NON-thinking session with NO provider configured + all-cooled + queue has the same kill — left unfixed because widening the hold to non-thinking re-breaks the 200-concurrent burst-shed test (#7). Not applicable to this user (GLM/Kimi providers configured). Re-open if a no-provider topology hits it.

### 9. Multi-hour outage strands the whole fleet for 15 min after recovery (no auto-recovery) — DONE
**Status:** SHIPPED (v1.5.3). 2026-06-29: a 5-6h hotel-network nightly cutoff. maxpool correctly HELD the streaming requests through it (the #8 hold), but on recovery every agent stayed dead and a manual restart was needed.
**Root cause:** OAuth access tokens expired during the outage; the required token refreshes failed with `fetch failed`. `markTransientFailure`'s EXPONENTIAL backoff (cap 15 min) + `consecutiveFailures` bump pinned every account at the 15-min cap, so the fleet stayed benched up to 15 min AFTER connectivity returned (and a successful refresh never reset the counter, priming the next failure for the cap). A network outage is fleet-wide — exponential PER-account backoff is the wrong tool.
**Fix:** `markTransientFailure(idx, reason, { network: true })` → short FIXED `networkCooldownMs` (5s), no escalation, no `consecutiveFailures` bump → the fleet retries within seconds of connectivity returning and recovers AUTOMATICALLY (like Claude direct), no restart. Callers: token-refresh `fetch failed` (classified by absence of HTTP status; 429/5xx stay exponential, invalid_grant still disables) + request-level `ECONNRESET`/`terminated`. `networkCooldownMs` in `DEFAULT_SCHEDULER` (not just config — avoids a NaN strand). Added a 10s refresh-fetch timeout so a hung connect can't pin the single-flight refresh. The "recovering" upstream-throttle clears transitively once an account is selectable again (~5s), so no separate fix needed.
**Rigor:** pre-mortem (BLOCKER brick-risk + 2 MAJORs assessed — brick mitigated by single-flight `_refreshPromise` + proven by test; `consecutiveFailures` conflation avoided by not bumping); adversarial code-review = SHIP, no must-fix; +5 red/green tests incl. the gating brick-safety (8 concurrent refreshes → exactly 1 rotation, no `invalid_grant`) + NaN-fallback + classification + exponential-preserved. Full suite green. Caveat (not maxpool's to fix): Claude Code's OWN per-request timeout — if CC gives up client-side during a multi-hour wait, that errored turn needs a re-message, but new requests route instantly.

### 10. Closing the terminal leaves a headless un-quittable orphan; `r` loses the TUI — DONE
**Status:** SHIPPED (v1.5.4). 2026-06-29: closing the maxpool terminal left a supervisor reparented to launchd (PPID 1) still holding :3456, no TUI, un-quittable but by PID; and pressing `r` dropped into raw logs (no TUI). Both rooted in interactive sessions taking the headless seamless-reload path.
**Root cause:** a terminal hangup delivers SIGHUP to the whole foreground group; supervisor + worker both treated SIGHUP as "reload" → the worker reloaded and the supervisor outlived the terminal. And a reload-worker has `useTUI=false`, so any reload (incl. `r`) lost the TUI forever.
**Fix:** SIGHUP is now interactivity-gated (`isInteractiveTerminal()`): in a terminal → drain+exit cleanly (no orphan); headless/service → conventional reload (unchanged — keeps every reload test green). The supervisor forwards NOTHING on an interactive SIGHUP (the worker already got the group signal) — avoids the double-signal force-exit→crash-respawn (a pre-mortem BLOCKER). A terminal-close drain-timeout exits 0 (never misread as a crash to respawn — F2). stdout/stderr EPIPE swallowed + uncaughtException won't exit-75 while draining (write-after-hangup BLOCKER). Interactive `r` now full-cold-restarts (`reloadStrategy`) so the fresh worker re-renders the TUI; `restartWorkerNow` drains in-flight refreshes first (brick-safety). Headless keeps the zero-downtime baton.
**Rigor:** pre-mortem caught both design BLOCKERs (double-signal + write-after-hangup) + a brick gap in the cold-restart path; adversarial code-review = SHIP, no must-fix (216→217 tests, lint clean). New `test/terminal-hangup.test.js` reproduces a real group-SIGHUP hangup via a `MAXPOOL_FORCE_TTY` hook (zero-dep, no pty) and is red without the fix. Known limit: the post-reload TUI *render* can't be CI-tested zero-dep — rides the tested cold-restart path + user verification.

### 11. No persistent logs → incidents un-investigable (e.g. "connection_unavailable across all sessions") — DONE
**Status:** SHIPPED (v1.5.5). 2026-06-30: a fleet-wide `connection_unavailable` hit all sessions a few hours earlier; impossible to diagnose because maxpool persisted nothing (TUI feed is in-memory; request logging opt-in/off).
**Fix:** default-on rotating event log at `<config>.log` (`~/.config/teamclaude.log`) mirroring the `[Maxpool]` console stream (routing, network errors, cooldowns, token refreshes, reloads, upstream-throttle). `src/event-log.js`: fire-and-forget serialized append (never throws into the proxy), bounded queue + drop sentinel, secret redaction + byte-capped lines (<PIPE_BUF for atomic concurrent O_APPEND on macOS), SINGLE-OWNER timer rotation (supervisor or lone unsupervised worker → no reload-window archive clobber), 0600. Teed via console mirror (plain) + `tui._addLog` (TUI mode). Explicit `connection_unavailable (503)` marker for greppability. Opt-out via `eventLog: false`.
**Watcher:** a recurring monitor (cron `230acff9`, every 20 min, durable) reads the log and stays silent unless a real cluster appears (≥2 503s / ≥3-account fleet blip / sustained run), then reports the incident in plain English with the likely cause. Watermark in `~/.config/maxpool-watch.state`. Caveat: cron fires only while a Claude Code REPL is idle (not 24/7) and recurring crons auto-expire after 7 days — re-arm or move to a LaunchAgent for always-on.
**Rigor:** pre-mortem (predicted + drove the multi-writer-rotation + PIPE_BUF fixes) + adversarial code-review (SHIP; should-fix byte-cap closed in-PR with a CJK/emoji test). 7 red/green event-log tests; full suite green (224 tests); existing stdout-grepping tests unaffected by the mirror.

## DONE (this session, for context)

- Keychain import fix (1.0.1) — **to be reverted per #3.**
- Quit/drain bounded to 15s so `q`/Ctrl-C actually quits under load (1.0.2).
- Backward-compat `x-teamclaude-*` headers so running sessions survive the rename (1.0.3).
- TUI active-account indicator + browser login (`l`) + rename (`n`); CLI `rename` (1.0.5).
- README setup guide + FAQ + account-risk/ToS disclaimer (1.0.6 / 1.0.7).
- Queue: weekly caps now wait+retry instead of fail-fast; non-stream cap, capacity clamp, backpressure, stale-head reaper, poll jitter, honest messages (1.1.0).
- ToS review (4-advocate council + judge): personal use = contested gray area; public promotion = do-not. Launch held.
