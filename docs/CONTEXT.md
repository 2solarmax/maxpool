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

Multi-provider + routing modes + restart UX shipped v1.5.64–v1.5.83. The proxy now
load-balances across Anthropic OAuth + GLM (z.ai) + Kimi (Moonshot) with five named
routing modes. Current version: **v1.5.83** (installed as a global symlink to
`~/maxpool`, so `git pull` updates the running install).

**Recently shipped (2026-08-10/11):**
- v1.5.80: routing modes (`balance`, `prefer-claude`, `prefer-zai`, `prefer-kimi`,
  `sticky`) replacing the opaque 3-policy knob. Utilisation-weighted scoring in
  `balance` mode. Session binding only under `sticky`.
- v1.5.81: restart UX fix — seamless path skips the 10s pre-drain (it was pure cost:
  30-60s requests never finish in 10s, so it was always 10s of guaranteed 503s for
  zero drained requests). Progress ticks during cold-path drain. Honest confirm text.
- v1.5.82: cache-first secret resolution (reads `~/.claude/.credentials-cache` before
  `gcloud`, fixing `secret-unresolved` rows that spawned duplicate `-fallback`
  entries). Routing modes exposed in TUI (`f`/`m` key cycle).
- v1.5.83: hide inert "Cross-provider: always" text under non-sticky modes (it
  looked like two conflicting controls when only the mode governed routing).

**Open items:**
- `glm max@gomokka.com` (legacy TOKENS_LIMIT plan) has no weekly limit — confirmed
  real (not a parse gap), but z.ai is sunsetting legacy plans (migration notice
  April 2026). Don't rely on this long-term.
- Ahmed's RESTRICTED_AL_MAXPOOL_ZAI key is absent from Max's credentials cache
  (~17s gcloud resolution at boot on Max's machine; instant on Ahmed's).
- `crossProviderFallbackPolicy: when-exhausted` still in config.json — inert
  (routingMode takes precedence), cleaned up on next `f` key cycle.

---

## Decisions

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
