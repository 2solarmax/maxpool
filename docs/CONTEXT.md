# Maxpool — living context & decision log

> **This is the project memory.** Read it before non-trivial work; append to it as
> soon as a decision is made or a change ships. It travels with the repo, so any
> fresh Claude Code session (or teammate) picks up where the last one left off.
>
> **How to keep it useful (anti-rot):**
> - Keep **Current focus** short — what's active *now*. Overwrite it; don't append.
> - **Decisions** is append-only. Newest at the top. Each entry is dated, numbered,
>   and states *context → decision → consequences*. Never delete a decision; if one
>   is reversed, add a new entry that says "supersedes #N".
> - When this file passes ~400 lines, move the oldest resolved decisions to
>   `docs/CONTEXT-ARCHIVE.md` and leave a one-line pointer here.
> - The mechanics (what to read, what to write, wrap-up) live in the
>   `/maxpool-builder` skill.

---

## Current focus

MaxPool serves Claude Code and native Codex. The account analytics change adds cache measurements by account and provider and an operator-only subscription view.

---

## Decisions

### 2026-11-20 · Quota attribution after a worker handoff

Late coverage can establish that an unused window had no observed demand. A late request from a retiring worker can retract that conclusion. MaxPool saves corrections with the quota cycle so they survive the shorter demand-history retention. The terminal and status report share one demand summary across accounts. A malformed handoff stays on disk under its original ID and is retried when the file changes. Transient failures continue to retry.

### 2026-11-20 · Measure routing outcomes at ingress and quota expiry at the holder

Activity analytics opens routing with `v` then `r`. It reports terminal inference outcomes and router-controlled wait. Native and translated requests share the five-second queue budget. A forwarded hop is visible to the receiving account without adding another external arrival. Each worker reports its own observations and coverage through the versioned `routingAnalytics` field of the existing status response. The terminal can select an individual worker.

Unused quota is a conservative estimate from peak observed utilization in each natural window. It requires a fresh paired vendor reading near the reset, including on idle accounts. Confirmed session-only z.ai plans use their five-hour window. The distinction between no observed demand, eligible demand served elsewhere and incomplete evidence matters when sizing subscriptions. Historical service or end-of-window readings cannot be reconstructed from cache totals. The six-request default protects forwarded requests that bypass ordinary admission. New-placement measurement keeps established conversations and cache ownership intact.

During a rolling upgrade a legacy worker's unexpired five-hour reading continues to protect the account until an authoritative usage probe identifies its scope or the window expires. A request's explicit active meter determines which named quota can supply its retry time. Exhaustion on another model cannot lengthen that wait.

### 2026-11-20 · Import historical cache data once per worker

The first migration imports the old name-based hours into the accounts known at the time. An unmatched or ambiguous name is omitted from historical attribution, even if a matching name appears later, because later reuse cannot establish who served the old requests. Later identity and provider changes use owner-keyed observations. Imported hours from 1.24.116 have no source aliases or request IDs. Their affected windows carry an estimate warning. The original counters are preserved.

### 2026-11-20 · Account analytics and private subscription terms

Cache percentages divide cache-read tokens by all input tokens, including cache writes. Accounts shows the last three hours. Activity analytics provides one hour, one day, one week and all measured history. Each worker counts the requests it served locally. A linked viewer uses the serving worker’s summaries. Codex reports cached tokens as part of input and the two request adapters normalize that once.

Price, billing period and next renewal come from the operator’s private registry or a supported provider reading. A linked worker shares usage measurements. Commercial terms stay with the operator who has their source. Missing records are displayed as unknown. Subscription prices are distinct from metered usage and invoice charges.

### 2026-11-19 · Local terminal request cap

The local proxy checks the full terminal UUID and resolved caller before admitting a message. Operators can arm an existing terminal for a bounded task. Each incoming client attempt consumes one slot even when its eventual request fails. Slots persist across worker restarts. Cloud retries inside that request, generated tokens, and subscription quota use require separate measurement.

### 2026-11-19 · Account configuration writes

Claude browser login matches only Claude OAuth accounts. Another provider can keep the requested name and grant while the new Claude account gets a distinct label. Local CLI enrollment updates the latest locked config, and terminal account actions apply the selected row and fields so concurrent enrollment, credential rotation, and deletion survive.

### 2026-11-19 · Cache dashboard at terminal width

Show a named pair of 15-minute and 24-hour cache hit rates for Claude, GLM, and Codex when provisioned. A dash marks an idle or unmeasured window. Routing details show per-provider misses on their own line, and `maxpool status` keeps the existing quota-burn wording.

### 2026-11-19 · Codex prompt cache from Claude Code

The Codex Messages adapter sends stable Claude Code system text as the first developer input and drops the per-request Anthropic billing header. The native transport gives OpenAI matching prompt and session cache keys scoped to the authenticated caller, Claude Code thread and agent, serving account and resolved model. The dashboard continues to measure upstream cache-read tokens over total input tokens.

### 2026-11-19 · Desktop Claude Pool opt-in

Maxbar writes the Claude desktop Pool selection alongside its proxy settings. The loopback gate uses it to default unprofiled requests to `all`. Direct removes the opt-in. Explicit client and operator profiles keep precedence, and other gates retain the Claude default.

### 2026-11-19 · Provider cache and move summaries

The terminal displays separate Cache and Moves lines. Cache pairs each provider's 15-minute and 24-hour hit rates, including Codex. The 24-hour readings survive a restart. Routing and `maxpool status` show per-provider miss tokens. Move totals include Codex and preserve held-session release reasons from linked accounts.

### 2026-11-19 · Native Codex clients in Maxbar

The independent Codex routing switch uses the client's version-checked configuration service and a loopback Responses endpoint. The Mac's owner key authenticates the client. The scheduler selects a locally owned native account and binds subsequent requests to that identity for provider-owned state. Desktop and CLI share the model catalog, compaction and standalone search routes. Claude Code continues to use its Messages route.

### 2026-11-19 · Codex reset inventory

OpenAI reports separate counts for unused and currently applicable credits. Accounts shows the balance of unused credits, following the Codex CLI. Reset details lists unspent, unexpired credits supported by the plan. The optional usage-summary applicability count can stay zero as usage rises. At the weekly policy threshold, check the individual credit and use OpenAI’s redemption verdict. A decline leaves the credit banked. Free-credit policy and local opt-in are independent of this display.

### 2026-11-19 · Codex account display

Use the signed-in email as the default local account name. Reserve the Fable quota column for Anthropic rows. The dashboard summarizes cache hits by provider, with detailed counters available in Routing and `maxpool status`.

### 2026-11-19 · #10 — Native Codex provider behind Claude Code

**Context.** The first pilot used the app-scoped ChatGPT plan grant. Native
Codex login also exposes live quota, reset inventory, and model entitlements.

**Decision.** Reuse the TeamClaude native quota and reset interfaces and the
tested CLIProxyAPI Responses wire behavior in MaxPool's provider adapter.
The first serving provider of each Claude Code session controls its existing
provider-stickiness option. Codex stays pinned by default, with account
rotation and class-aware model selection within that family.

**Consequences.** Native Codex and the pilot's original grant have separate
credential/transport paths. Codex free reset automation is independently
opt-in. Stage on a separate port and verify before changing the normal local
package or enrolling a local account.

### 2026-11-19 · #9 — ChatGPT plan usage behind Claude Code

**Context.** Quota exhaustion needs a new provider on the existing `cc` path,
including cloud account onboarding and Remote Control sessions.

**Decision.** Add Sign in with ChatGPT to MaxPool and stream OpenAI Responses
as Claude Messages. Use the existing linked-pool account handoff. Set the
default session policy for ChatGPT to same provider, configurable per provider
or pool-wide. Preserve the client-owned tool loop and the original transcript.

**Consequences.** ChatGPT accounts can serve `cc all` traffic and rotate among
eligible accounts. Verification needs both the Claude Code tool round trip
and a real ChatGPT plan authorization before enabling it on the live pool.

### 2026-11-13 · release B red-team round 1 — first-byte floor vs client patience, mixed-version 504

- **Deadline present ⇒ the first-byte wait is min(remaining, hop cap), not the 120s floor.** The floor still applies to
  requests with no patience header. Before: a >120s non-streaming answer on the cloud timed out at the floor, came back as
  a bare 503 and the Mac booked a failure on the cloud row (F3). A pool-deadline request that times out with no route
  left now answers the request-scoped 504 (Mac books it neutral).
- **A request forwarded by another pool (hop header) without the pool deadline header is an OLD Mac: no deadline at all.**
  It forwards the client's X-Stainless-Timeout; answering a deadline 504 made it book a failed request (F1). Direct
  clients with X-Stainless-Timeout still get the 504 (T2).
- **Every re-send site shares one guard** (`resendAllowed`: client gone + 60s minimum-move); moves also check a route (F5).
- Nits: body read goes through an owned reader so a cancel really closes the socket (F4); the B11 exit line goes to the
  event log only (F6); the `ns` tag is POST /v1/messages only (F9).
- Release evidence for the two-pool tests needs an explicit gated run (`MAXPOOL_TWO_POOL_TESTS=1`, `MAXPOOL_OLD_MAC_DIR`).

### 2026-11-10 · reset machinery — scope from `clears`, cap lift (D2), reactive claim

**Context:** resets were invisible on cloud rows (the export omitted `eligible`),
the count flickered on transient listing failures (null-on-error), every measured
grant was model-scoped (`seven_day_overage_included` = Fable) while the claim gate
required a literal `seven_day` (so NO grant could ever be claimed), and capped
accounts could never reach their claim wall. Task:
`mokka-workspace/work/tooling/1-discovery/bug-2026-11-10-maxpool-reset-machinery-all-accounts/`.

**Decisions (owner D1-D4 + pre-mortem amendments):**
- Scope is Anthropic's own `clears` field via one shared `appliesTo()`
  (`seven_day`=general, `five_hour`=session, `seven_day_overage_included`=fable);
  missing `clears` → `[]` = unknown: shown, never claimed, never lifts. Missing
  `usable_now` → false (fail closed).
- Claude claims read their OWN wall `CLAUDE_WALL_WEEKLY=0.99`; z.ai's
  `POLICY.wallWeekly` stays 0.90 (shared constant would move GLM redeems).
- The claim decision runs AFTER this sweep's usage probe (freshness: lastProbeOkAt
  ≤5 min, unified7dReset future, lastProbeOkAt > lastClaimAt) and picks the grant
  by scope, never by the server's nextGrantId order.
- Cap lift (D2): a held full-refill reset (seven_day grant or z.ai weekly card)
  suspends the cap on BOTH windows + the provider max(ses,wk) cap, remaps
  soft/reserve/critical → normal below the wall, and ends on claim / grant-gone /
  10-min listing-failure grace expiry. Give-back grants lift only to cap + the
  MEASURED unified7d drop (never a full lift on an unmeasured one).
- capLift is computed ONLY by the holder pool and exported; mirrors honour it.
- Reactive claim: a weekly-class 429 (7d header ≥ wall) claims on the serving
  lease's local account at once; a scoped 429 only with a probe-MEASURED bucket;
  stored listing allowed stale ≤6h; current token only (a 401 defers to the sweep);
  one claim lock per account shared with the prober; failure backoff 15m/30m/1h
  cap 6h per (account, grantId).
- Grants listed ≤1 per 5 min per account (the call shares the rate-limited
  /api/oauth/usage endpoint); two calls kept (distinct header sets, no merge).
- TUI Rst column: fixed grammar at width 6 (`n~Xd` general, `nF~Xd` scoped,
  `g+sF` mixed, `n?` unknown, gray+`?` not-fresh); count = SUM of resetsLeft +
  live cards; expiry checked live in the render.
- ttfb = the serving attempt's upstream wait (its fetch resolve minus its own
  forward start), stamped only on a successful fetch; the queue heartbeat never
  stamps it.

**Review round (judge @2c4da59, same day):** one claim per wall is ordered by the
probe's SEND time (a probe sent before a claim cannot license another); a
successful claim spends the reset in the stored listing at once; the reactive
claim runs off the request (fire-and-forget, 10s abort) and a 401 defers to the
sweep without backoff; no lift — and no dying-value claim — within 24h of the
limit's free refill unless the reset itself dies first (D4); mirrors read the
holder's exported lift ceiling; the skip log prints the policy's own reason;
claim state (cached org, backoff) is per login and cleared on re-login/removal;
the give-back OR rule also holds for stored (normalized) grants. Timing constants
live in one leaf module, `src/reset-timing.js`.

**Consequences:** every row (cloud included) shows its resets with scope; capped
accounts spend their general resets; a 429 at the wall claims for the NEXT request
without slowing this one; z.ai schema drift reads as a failed listing, never a
silent 0.

### 2026-08-10 · #8 — Five named routing modes replace crossProviderFallbackPolicy

**Context:** `crossProviderFallbackPolicy: 'always'` read as "load balance across
everything" but only governed a session's FIRST request — after that, the session
was pinned to one account (per-ACCOUNT, not per-provider). ~30 sessions that started
on the same account hammered it forever while every other account idled. The pin
existed for signed-thinking-block safety, which was empirically disproven (2026-07-02,
cross-account replay returned 200) and provider-authored thinking blocks are now
auto-stripped (v1.5.64+).
**Decision:** Replace the single knob with five explicit modes. `balance` scores
every request across the whole pool. `prefer-*` modes bias toward a provider
family. `sticky` preserves the old behavior. Migration: `always`→`balance`,
`when-exhausted`→`prefer-claude`, `never`→`sticky`. TUI `f`/`m` cycles modes.
**Consequences:** The per-provider `claudeFallback` knob (`g`/`k` keys) is now
inert under every mode except `sticky`. The header only renders it under `sticky`.

### 2026-08-10 · #7 — Cache-first secret resolution

**Context:** Resolving 5 GCP secrets via `gcloud secrets versions access` in
parallel at boot caused 3 of 5 to hit the 45s timeout (gcloud invocations contend
on credential cache + network). Unresolved secrets left config providers in
`error: secret-unresolved` state, and the header-based runtime path created
duplicate `-fallback` rows beside them.
**Decision:** Read `~/.claude/.credentials-cache` (plaintext JSON, written by
`scripts/load-secrets.sh`, mode 0600, sanctioned) FIRST. Fall back to gcloud
sequentially only for names the cache lacks. Measured: 5/5 resolve in 17.5s
(4 from cache instantly, 1 gcloud miss) vs 2/5 before.
**Consequences:** No new attack surface (an attacker who can read the cache
already has everything). Cache staleness bounded: a rotated key 401s → provider
shows error → degrades gracefully. Maxpool restart picks up refreshed cache.

### 2026-08-10 · #6 — Seamless restart skips the pre-drain

**Context:** `r` → `y` paused admission immediately, then waited up to 10s for
in-flight requests to drain. With ~30 sessions running 30-60s requests, the drain
NEVER completed naturally — it always timed out, producing 10s of guaranteed 503s
across the fleet. The seamless baton path already drains in-flight requests
post-handoff (releaseBatonAndDrain, 60s+ cap), so the pre-drain was redundant.
**Decision:** `RestartController` now takes an `isSeamless()` predicate. When true,
the restart fires immediately — in-flight requests finish on the old worker after
the baton passes. Cold path still drains (socket closes, so in-flight would be
severed without it).
**Consequences:** `admissionPaused` is constructor-initialised false and never
persisted — a cold start always begins with admission open. The 503 message now
reads "finishing in-flight requests first" instead of "Retry immediately".

### 2026-08-07 · #5 — Multi-provider support (GLM/Kimi)

**Context:** Maxpool was Anthropic-only. Max wanted to add GLM (z.ai) and Kimi
(Moonshot) accounts to the pool so Claude Code sessions could spread across three
providers.
**Decision:** Provider accounts carry an API key (not OAuth). Keys stored in
`~/.config/teamclaude.json` as GCP secret names, resolved at boot. Provider quota
probed from each provider's own usage API. Providers participate in routing
according to the mode (see #8). Provider-authored thinking blocks are auto-stripped
before forwarding to Anthropic (rejected-block self-heal via revert-to-issuer).
**Consequences:** Provider keys are owner-scoped via GCP IAM. Adding a teammate's
key: `gcloud secrets create RESTRICTED_<USER>_MAXPOOL_ZAI` + IAM binding. Team
registry: `mokka-workspace/knowledge/technical/maxpool-api-key-registry.md`.

### 2026-07-23 · #4 — Project-context harness is committed in-repo

**Context:** Maxpool lives outside the mokka-workspace, so it inherits none of
that workspace's skills/rules/memory. Goal: a fresh Claude Code session should
pick up full project context + keep an evolving memory.
**Decision:** Ship the harness as committed files in *this* repo — `CLAUDE.md`
(always-loaded facts/invariants), `docs/CONTEXT.md` (this living log), a
`.claude/` SessionStart hook that injects the memory head at session open, and a
project-agnostic `/maxpool-builder` skill. Reading is guaranteed by a CLAUDE.md
imperative + the hook (not a skill that only loads when invoked); writing is
event-driven (append on each decision/change, not an end-of-session ritual).
**Consequences:** Everything travels with the clone. The skill body is generic,
so reusing this pattern on another repo is copy-the-folder + drop a seed
`CLAUDE.md`/`CONTEXT.md`, not a rewrite. A plugin/marketplace is deferred until a
second project actually needs it.

### 2026-07-23 · #3 — In-repo CHANGELOG via git-cliff; leave publish.yml's release notes as-is

**Context:** Releases shipped silently — no CHANGELOG, and GitHub Release bodies
were empty because `publish.yml` built notes from merged PRs while maxpool
commits directly to main. A parallel session had already fixed the *Release body*
(now generated from the commit log since the previous tag — works; see v1.5.37).
**Decision:** Add the missing **in-repo** `CHANGELOG.md` with **git-cliff** (a
changelog *generator*, pinned as a devDep, run from the package.json `version`
hook) — NOT a release orchestrator (semantic-release / release-please /
changesets), which would replace `release.sh`'s version/tag logic and break the
tag-triggered OIDC publish. **Leave the working `publish.yml` release-notes step
untouched** — both derive from the same Conventional Commits, so they stay
consistent, and there's no reason to churn release-critical CI another session
just shipped.
**Consequences:** `cliff.toml` + `scripts/update-changelog.sh` + a pinned
`git-cliff` devDep + a backfilled `CHANGELOG.md` (49 sections; pre-1.1 history is
a best-effort import). No change to `release.sh` or `publish.yml`. If the repo
ever adopts a PR flow, GitHub's native `--generate-notes` becomes viable and this
can be revisited.

### 2026-07-23 · #2 — Harden the npm account (2FA + disallow tokens)

**Context:** OIDC Trusted Publishing means no long-lived npm token is needed.
**Decision:** Enable "Require two-factor authentication and disallow tokens" on
the npm account. OIDC publishing keeps working with this on.
**Consequences:** Removes long-lived publish tokens as an attack surface.
**Status:** Done 2026-07-23 — 2FA enabled + `maxpool` package publishing access
set to "require 2FA and disallow tokens"; OIDC publish unaffected.

### 2026-07-23 · #1 — Release-record posture: forward-only + in-repo, log-not-announce

**Context:** Maxpool is a ToS gray-area tool; the public GitHub Release page is
the first npm-linked, search-indexed "what this does" surface, and commit
subjects can describe quota/rate mechanics.
**Decision:** Keep the rich record **in-repo** (`CHANGELOG.md`); go **forward-only**
on public GitHub Release bodies (do not bulk-populate the ~50 old ones); use
neutral, factual phrasing in anything release-surfaced. **Log everything, announce
almost nothing** — reserve any announcement for a major or security release.
**Consequences:** The low-profile posture is the default for all release work here.
