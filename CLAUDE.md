# Maxpool — project instructions for Claude Code

Maxpool is a multi-account, multi-provider proxy for Claude Code. It sits between
Claude Code and the Anthropic API (and GLM/Kimi) and spreads requests across all
accounts you own — Anthropic OAuth (subscription), GLM (z.ai), and Kimi
(Moonshot) — using adaptive, rate-aware load balancing. Node.js, zero runtime
dependencies, published to npm as `maxpool`.

## Providers (multi-provider since v1.5.64)

Three account types coexist in one pool:

| Type | Auth | Quota source | Notes |
|---|---|---|---|
| `oauth` (Anthropic) | Browser login → OAuth refresh tokens | `/api/oauth/usage` + response headers (unified 5h / 7d) | Single-use refresh tokens rotate on first use |
| `provider` (z.ai/GLM) | API key from GCP Secret Manager | `api.z.ai/api/monitor/usage/quota/limit` | `TOKENS_LIMIT` (legacy, no weekly) vs `CREDIT_LIMIT` (newer, has weekly) |
| `provider` (Kimi/Moonshot) | API key from GCP Secret Manager | `/v1/usages` | Session + weekly windows |

Provider keys are stored in `~/.config/teamclaude.json` as **secret names** (never
the key value). At startup `src/secret-resolver.js` resolves them via
`~/.claude/.credentials-cache` first (instant), falling back to `gcloud secrets
versions access` sequentially. See `mokka-workspace/knowledge/technical/maxpool-api-key-registry.md`
for the key registry.

## Model IDs (z.ai / Kimi)

Static defaults (`src/server.js`, `src/account-manager.js`) are release-time
hygiene only. Mokka's traffic always sends `x-maxpool-*-model` headers derived
from the mokka-workspace `llm_config/models.yaml` SSOT (via `cc`/`ccall`
aliases in ~/.zshrc), which override the defaults. Standalone users can pin any
model per-provider in their own config. Precedence trap: a persistent maxpool
config entry carrying the gomokka z.ai token would make config beat the SSOT
headers — do NOT add that token to maxpool config.

## Routing modes (since v1.5.80)

Five named modes replace the old opaque `crossProviderFallbackPolicy`:

| Mode | Behaviour |
|---|---|
| `balance` | Score every request across the whole pool. Accounts drain evenly. |
| `prefer-claude` | Claude first; GLM/Kimi pick up overflow when Claude is loaded. |
| `prefer-zai` | GLM first; others overflow. (Label: "Prefer GLM") |
| `prefer-kimi` | Kimi first; others overflow. |
| `sticky` | Session stays on the account it started on. The only mode where the per-provider `claudeFallback` knob matters. |

TUI: `f` or `m` cycles modes on the routing screen. The `cross-provider: …` header
fragment only renders under `sticky` (it's inert under other modes).

## ⚡ Prime directives — read/update the project memory

This repo carries a self-updating memory. Two rules, always:

1. **READ `docs/CONTEXT.md` before any non-trivial work** — its *Current focus*
   and *Decisions* tell you where things stand and why. A SessionStart hook also
   injects its head at session open; still open the file for the full log.
2. **APPEND a dated entry to `docs/CONTEXT.md` after any decision or shipped
   change** — the moment it happens, in-thread, not "at the end." A skipped
   update leaves the next session reading a stale log as if it were current.
   Format and discipline: `/maxpool-builder` (the skill) or the file's own header.

`docs/CONTEXT.md` is the source of truth for *state*; this file (CLAUDE.md) is the
source of truth for *durable facts and invariants*. Keep this file lean (~150
lines) — it loads in full every session.

## Hard invariants — do not break these

**Release pipeline** (details: `scripts/release.sh`, `.github/workflows/publish.yml`):
- Ship with `npm run release` (patch) / `scripts/release.sh minor|major|X.Y.Z`.
  It runs tests → lint → `npm version` (commit + `vX.Y.Z` tag) → push → GitHub
  Actions publishes to npm. **Never `npm publish` by hand.**
- **A manual `npm version --no-git-tag-version` + commit publishes NOTHING** —
  publish.yml fires on TAG push only. This exact bypass left npm 6 versions
  behind git (1.5.80 vs 1.5.86, 2026-08-17). A commit-msg hook (.githooks/)
  now blocks a bare `vX.Y.Z` subject with no matching tag.
- **GitHub fires workflows for at most 3 tags per push** — pushing 6 tags in
  one batch triggers ZERO runs, silently. Push tags in batches ≤3.
- **npm publish is tokenless — OIDC Trusted Publishing + provenance.** There is
  NO `NPM_TOKEN`. The `repository.url` in package.json MUST stay
  `2solarmax/maxpool` or OIDC breaks. The repo must stay **public** (OIDC needs it).
- **Conventional Commits are load-bearing**, not style: `feat:`, `fix:`, `perf:`,
  `ci:`, `docs:`, `chore: release vX.Y.Z`. Both the CHANGELOG and the GitHub
  Release notes are generated from commit subjects. Write the subject as the
  changelog line you want users to read.
- **CHANGELOG.md is auto-generated** by git-cliff via the package.json `version`
  hook (`scripts/update-changelog.sh`) — never hand-edit it. Config: `cliff.toml`.
- **Log everything, announce almost nothing.** Every version gets a CHANGELOG
  entry + a GitHub Release. Do NOT broadcast releases; reserve any announcement
  for a major or security release. This is a low-profile tool (see below).

**Posture (low-profile / account risk):** maxpool sits in a contested gray area of
Anthropic's terms (see README's account-risk section). Keep the public surface
low: **forward-only** on public GitHub Release bodies (don't backfill the old
ones), neutral/factual phrasing in anything release-surfaced (describe *what
changed for the user*, not rate/quota-evasion mechanics). Owned accounts only;
never add IP/fingerprint spoofing or MITM — PRs adding them are rejected.

## How to work here

- **Reproduce before asserting a root cause; verify before claiming done.** This
  is a live proxy — prefer running it / a failing test over reasoning from code.
- **You own engineering decisions** (architecture, patterns, trade-offs) — apply
  best practice and proceed; don't bounce them to the user. Surface only genuine
  product / irreversible / risk calls, and lead with a recommendation.
- **Tests must pass before "done":** `npm test` (Node's test runner, files run
  serially — reload tests are subprocess-heavy). `npm run lint` (eslint on src/).
- **User-facing text** (TUI labels, README, release notes): plain and concrete,
  sentence case, no filler. Say what the user gets.
- Skills in this repo are invoked `/name` and run inline in the thread (not
  subagents). `/maxpool-builder` owns the memory read/update ritual + wrap-up.

## Architecture map (orient here; read the file for detail)

- `src/index.js` — CLI entry, arg parsing, top-level wiring (~1850 lines).
- `src/server.js` — the proxy HTTP server: request routing, SSE streaming,
  failover on 429/overload, retry buffering (~2000 lines).
- `src/account-manager.js` — the account pool + scheduler: quota tracking,
  adaptive-least-loaded routing, weekly/session thresholds, session affinity
  (~2700 lines — the heart of the load balancer).
- `src/oauth.js` — OAuth token refresh/persistence for subscription accounts.
- `src/prober.js` — quota probes (de-bursted so weekly quota refreshes).
- `src/tui.js` — the interactive dashboard (quota bars, activity log, controls).
- `src/reload-protocol.js` + `src/restart-controller.js` — zero-downtime reload
  (drain in-flight streams before restart/quit).
- `src/config.js` — config load/validate (`config.example.json` is the schema).
- `src/secret-resolver.js` — resolves GCP Secret Manager names to API keys
  (cache-first via `~/.claude/.credentials-cache`, gcloud fallback sequential).
- `src/event-log.js`, `src/sleep-guard.js`, `src/updater.js` — logging,
  keep-awake, self-update.
- Config knobs: `proxy` (host/port/apiKey), `upstream`, `switchThreshold`,
  `scheduler.*` thresholds, `retry.*`. See `config.example.json`.

## Pointers (read on demand — do NOT inline these)

- `docs/CONTEXT.md` — living state + decision log (read first).
- `docs/open-issues.md` — the in-flight issue/roadmap tracker (one core issue at
  a time; newest status on top).
- `README.md` — user-facing overview + the account-risk notice.
- `.github/workflows/` — `ci.yml` (tests/lint), `publish.yml` (OIDC publish +
  GitHub Release).

> This repo is OUTSIDE the mokka-workspace; it does not inherit those skills or
> rules. Everything Claude needs here is committed in this repo. Task tracking
> for maxpool work lives in `mokka-workspace/work/tooling/` (Max works from that
> workspace). The key registry lives at
> `mokka-workspace/knowledge/technical/maxpool-api-key-registry.md`.
