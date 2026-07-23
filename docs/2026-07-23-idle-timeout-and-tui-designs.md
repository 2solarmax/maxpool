# 2026-07-23 — Streaming idle-timeout + TUI/routing work — DESIGNS (pre-mortem input)

Ground-truth established by reading the live code (`origin/main` == local HEAD af92e11). Four work items.

## W1 — "Stream idle timeout - no chunks received" (the reported bug)

**Root cause (verified, NOT count_tokens):** A STREAMING `/v1/messages` request receives ZERO client bytes during route-selection + failover attempts + the upstream TTFB wait. The only client keep-alive is `ensureQueueHeartbeat` (server.js:1510), which fires ONLY once a request is QUEUED (server.js:1485). `UPSTREAM_TTFB_MS`=120s (server.js:24) is ABOVE the client (Claude Code) idle timeout (~23–60s; "observed as low as ~23s"). So a streaming request that (a) hits a slow-TTFB upstream, or (b) burns >client-timeout cycling failover (Anthropic thinking-sig reject → glm 429 → kimi 502 @20.6s in the live log) before it queues, sends the client nothing → client aborts "no chunks received." v1.5.37's count_tokens cap is a NON-streaming path, unrelated.

**Fix:** Proactive streaming keep-alive during the forward window. In `forwardRequest`, for a streaming + uncommitted (`!res.headersSent`) request, anchor once `requestInfo.streamGraceDeadline ??= Date.now()+graceMs` (new `DEFAULT_QUEUE.streamForwardGraceMs`, default 10000ms, env `MAXPOOL_STREAM_FORWARD_GRACE_MS`). Around the fetch (server.js:489–507) arm a timer for `max(0, deadline-now)`; on fire → `ensureQueueHeartbeat(res, requestInfo, queueConfig, accountManager)` (commits `200 text/event-stream` + starts the 10s heartbeat, reusing `queueHeartbeatActive`). Clear the per-attempt timer in the `finally` (line 505–507); LEAVE the deadline so re-forwards cover cumulative failover time. No change to `UPSTREAM_TTFB_MS`. Common fast case (TTFB 1–5s < 10s grace) never early-commits → unchanged behavior; only currently-BREAKING slow requests change.

**Why safe:** the queue path ALREADY commits headers early then re-forwards through the exact same error/failover paths (server.js:1494–1503), so those paths are already `headersSent`/`queueHeartbeatActive`-safe. `streamResponse` stops the heartbeat on first real byte (1500–1503). Extends a proven path to the forward window.

## W2 — TUI: list Claude/OAuth accounts BEFORE providers

**Root cause:** render loop (tui.js:998) iterates `am.accounts` in array order; providers interleave.
**Fix:** compute a display order `[…non-provider idxs…, …provider idxs…]` (stable within each group); render `_renderAcct(realIdx)` in that order; keep `selIdx` = REAL account index (so `isSel`/`isCur` at 1069/1066 stay correct) but make up/down navigation traverse DISPLAY order. `am.accounts` canonical order UNCHANGED (routing/`nextIndex`/FIFO untouched). Enumerate every `selIdx`/`accounts[idx]` action handler ([t]/[n]/[d]/[a]/preference) — they key on real idx, so they keep working; only NAV mapping changes.

## W3 — TUI: "Type" → real "Provider" column (Anthropic / z.ai / Moonshot)

**Fix:** replace the Type column (header 'Type' tui.js:48, `TYPE_W`=8 line 33, render `a.type.padEnd` line 1082, provider path 1130) with a Provider column via `providerLabel(a)`: `provider==='zai'→'z.ai'`, `'kimi'→'Moonshot'`, `'anthropic'/oauth/apikey→'Anthropic'`, else Titlecase(provider) (graceful for future Codex/Grok). Widen to fit 'Anthropic'(9) → `PROVIDER_W`=9, header 'Provider'. Recompute the header offset comment (tui.js:29–32). `account.provider` is set at account-manager.js:192/2454 (`'anthropic'` for oauth/apikey; `'zai'`/`'kimi'` for providers).

## W4 — mid-session-added account used WITHOUT a reload

**Root cause (verified — prior "null unified7dReset outscored" hypothesis was WRONG; a fresh account scores LOW/attractive):** session affinity. `_boundAccount` (1352) keeps a session on its account unless `_hasHigherPriorityAvailable` (fresh oauth = same priority 0, not higher) or `_shouldRebalanceBoundSession`, which requires `_isBoundAccountHot` (1144) = the bound account burning quota fast. If existing accounts are healthy/not-hot, no session migrates → a fresh idle account draws only NEW sessions → idles until a reload clears bindings.

**SHIPPED FIX — warmup-pull (after pre-mortem REJECTED two prior designs).** Rejected: (v1) a concurrency-score gap never fires in the exact steady-state case (a sequential bound session has `activeWeight≈0` at the instant its own request routes → boundScore≈fresh score). (v2) a 15-min spread-SHARE gap structurally OSCILLATES in maxpool's primary regime (#sessions < #accounts): the share is a LAGGING signal, so a vacated account shows phantom load for the whole window and carriers sit ~0.5 while ≥3 accounts sit at 0 → no gap value both onboards a fresh account AND stays stable.

The shipped design keys on the fresh account's OWN absolute onboarding state, not relative load — so it PROVABLY TERMINATES and cannot flap for any ratio:
- `addAccount` stamps `addedAt: Date.now()` (ONLY the mid-session-add path; the boot/config constructor leaves it unset, so an established fleet account is never "warming").
- `_isWarming(account, now)`: non-provider, `addedAt` set, `completedRequests < WARMUP_REQUESTS` (5), within `WARMUP_MS` (5 min). Both bounds terminate it; `completedRequests` (incremented in `releaseAccount`) only grows.
- `_warmupPullTarget(bound, …)`: a cheap `accounts.some(_isWarming)` early-out (near-free in the common no-warming steady state), then guards `_migrationSafeForRequest` (fail-closed on unscanned/incompatible bodies) + not `queueTicket`/`queueAdmitted` + bound NOT warming + bound carrying recent load (`_loadSummary.weight > 0`); scans NON-provider warming healthy (`allowWeeklyReserve:false`) targets and returns the best by score, or null.
- `_selectNext` bound block: calls `_warmupPullTarget` and, if non-null, returns it DIRECTLY (before the sticky bound-return). Directed selection GUARANTEES a non-provider destination even under `always` cross-provider policy — a signed-thinking session can never be shuttled onto a provider (the shared candidate loop, keyed only on `_matchesRequest`, would NOT prevent that). `_bindSession` re-homes on acquire → each session re-homes at most once → no ping-pong.

Terminates + no flap: once the fresh account serves WARMUP_REQUESTS (or WARMUP_MS elapses) it stops warming and is never pulled onto again; a re-homed session is thereafter bound to it (`_boundAccount` returns it → no re-pull). Tests (`test/warmup-pull-mid-session-add.test.js`) assert all 6 judge invariants: onboard-fires, fail-closed on unscanned body, never-a-provider (incl. `always` + signed thinking), terminates-bounded, one-and-done, idle-near-cap-hot-rebalance-preserved — plus idle-carrier-not-pulled and boot-account-never-warming.
