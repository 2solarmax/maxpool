#!/usr/bin/env bash
#
# release.sh — ship a new maxpool version across the board in one step:
#   remote-sync check → CI-verified check → version bump (commit + tag) → push to GitHub → Actions publishes to npm.
#
# Usage:
#   scripts/release.sh                # patch release (default)
#   scripts/release.sh minor          # minor release
#   scripts/release.sh major          # major release
#   scripts/release.sh 2.0.0          # explicit version
#
# Preconditions: your feature changes are already committed. `npm version`
# requires a clean working tree, which keeps releases reproducible.
#
# npm publish: done by the GitHub Actions "Publish" workflow via Trusted
# Publishing (OIDC — no token, no 2FA). Pushing the vX.Y.Z tag below triggers it.
# One-time npm-side setup lives in .github/workflows/publish.yml. There is NO
# local npm auth or NPM_TOKEN anymore — the old bypass-2FA token path is dead.
#
# Tests are NOT run on this machine: the GitHub CI workflow (ci.yml: jobs `test`
# and `ci-gate`) must have passed for the exact HEAD commit (guards live in
# scripts/release-guards.sh). Lint runs in CI only.
#
# Override the git remote/branch with RELEASE_REMOTE / current branch.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-guards.sh"


# ── Stage watchdog (2026-10-27, owner-approved) ────────────────────────────────
# v1.24.31's release stalled SILENTLY after "Running tests": no tag, no error,
# nothing for minutes — the operator only noticed because nothing happened. A
# frozen stage must FAIL LOUDLY, not hang. Every stage below runs under `timeout`
# with a generous per-stage ceiling (tests can legitimately take ~8 min locally);
# a timeout names the stage, prints where it stopped, and exits non-zero so no
# later stage (tag, push, publish-watch) can run on a half-finished release.
run_stage() {  # $1=name  $2=ceiling_seconds  rest=command — prints output, fails LOUD
  local name="$1" ceiling="$2"; shift 2
  local rc=0
  echo "==> $name (ceiling ${ceiling}s)"
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ceiling" "$@" || rc=$?
  else
    "$@" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "✗ STAGE FAILED: $name (rc=$rc${rc:+, }ceiling ${ceiling}s — frozen or errored; release aborted before any later stage)" >&2
    exit "$rc"
  fi
}
BUMP="${1:-patch}"
# Clones name the GitHub remote differently ('private' on some, 'origin' on others):
# prefer 'private' when it exists, else 'origin'. Checked BEFORE the test stage so a
# missing remote fails in seconds, not after the suite and a local version bump.
if git remote get-url private >/dev/null 2>&1; then DEFAULT_REMOTE=private; else DEFAULT_REMOTE=origin; fi
REMOTE="${RELEASE_REMOTE:-$DEFAULT_REMOTE}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "✗ Git remote '$REMOTE' does not exist in this clone (remotes: $(git remote | tr '\n' ' ')). Set RELEASE_REMOTE." >&2
  exit 1
fi

# Stale-copy guard first, before any other work (fetches, then refuses unless HEAD
# equals or fast-forwards remote main).
release_require_synced_with_remote "$REMOTE" "${RELEASE_BASE_BRANCH:-main}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is dirty. Commit your changes first, then release." >&2
  git status --short >&2
  exit 1
fi

# 2026-11-21: local test + lint stages removed. Release proceeds only from a copy that
# equals (or fast-forwards) remote main — a stale copy once published v1.24.120
# without PR 14 — and only when CI passed for this exact commit. RELEASE_CI_CEILING
# (default 1800s) bounds the wait for a still-running CI.
GH_REPO="${MAXPOOL_GH_REPO:-2solarmax/maxpool}"
release_require_ci_green "$GH_REPO" "$(git rev-parse HEAD)"

echo "==> Bumping version ($BUMP) — creates a commit + tag"
NEW_VERSION="$(run_stage "Version bump" 120 npm version "$BUMP" -m "chore: release v%s")"
echo "    $NEW_VERSION"

echo "==> Pushing to $REMOTE/$BRANCH (with tag) — the tag triggers the Publish Action"
run_stage "Push to $REMOTE/$BRANCH" 120 git push "$REMOTE" "$BRANCH" --follow-tags

echo "==> npm publish runs on GitHub Actions (Trusted Publishing, OIDC — no token)."
TAG="v${NEW_VERSION#v}"
if command -v gh >/dev/null 2>&1; then
  echo "    Watching the Publish workflow for $TAG ..."
  sleep 6  # let GitHub register the tag-triggered run
  RUN_ID="$(gh run list --repo "$GH_REPO" --workflow publish.yml -L 5 \
    --json databaseId,headBranch -q "[.[] | select(.headBranch==\"$TAG\")][0].databaseId" 2>/dev/null || true)"
  if [[ -n "$RUN_ID" ]]; then
    gh run watch "$RUN_ID" --repo "$GH_REPO" --exit-status && \
      echo "==> Published maxpool $NEW_VERSION to npm via Trusted Publishing." || \
      { echo "✗ Publish workflow failed — see: gh run view $RUN_ID --repo $GH_REPO --log-failed" >&2; exit 1; }
  else
    echo "    (Could not locate the run yet — check: gh run list --repo $GH_REPO --workflow publish.yml)"
  fi
fi

echo "==> Released maxpool $NEW_VERSION → GitHub ($REMOTE/$BRANCH); npm via Actions."
