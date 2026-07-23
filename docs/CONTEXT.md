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

Release hygiene + a reusable project-context harness shipped 2026-07-23 (pushed to
`private/main` @ `02d9f9b`; judge verdict SHIP):
- `CHANGELOG.md` is now auto-generated from Conventional Commits (git-cliff) and
  folds into each release via the package.json `version` hook. It regenerates on
  the NEXT `npm run release` (nothing releases on its own).
- This repo now has a committed Claude Code harness: `CLAUDE.md` (durable facts +
  invariants), this file (`docs/CONTEXT.md`, living memory), a SessionStart read
  hook, and the `/maxpool-builder` skill (memory ritual + reuse seed).
- npm account hardened: 2FA on + package publishing set to "require 2FA and
  disallow tokens" (OIDC publish unaffected).

No open feature work owned by this thread. Ongoing product roadmap lives in
`docs/open-issues.md` (rate-aware load balancing is the core problem).

---

## Decisions

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
