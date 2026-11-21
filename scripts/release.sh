#!/usr/bin/env bash
#
# release.sh — ship a new maxpool version across the board in one step:
#   remote-sync check → CI-verified check → re-sync → version bump (commit + tag) → atomic push to GitHub → Actions publishes to npm.
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
# Tests are NOT run on this machine: HEAD must equal remote main, and the GitHub CI
# workflow (ci.yml: jobs `test` and `ci-gate`) must have passed for that exact commit
# (guards live in scripts/release-guards.sh). Lint runs in CI only. A manual tag push or
# publish.yml workflow_dispatch skips these checks, as it always did.
#
# Note: the CI proof is for the commit BEFORE the bump — `npm version` + the changelog
# hook add ONLY package.json and CHANGELOG.md (no runtime code), so the parent's green
# CI run is the proof that carries. ci.yml runs AGAIN on the pushed tag itself; publish
# waits for neither, exactly as before.
#
# Override the git remote with RELEASE_REMOTE. The base branch is NOT overridable: it is
# always `main` (the checked-out branch must BE main, and the CI proof must be the run on
# main) — an env override would let a side branch at main's tip pass both guards.
# RELEASE_WATCH_TIMEOUT (default 1800s) bounds the post-push wait for the Publish workflow.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/release-guards.sh"
# The version is read from ./package.json after the bump; run from the repo root so a
# call from a subdirectory cannot bump and tag, then fail the read.
cd "$(git rev-parse --show-toplevel)"


# ── Stage watchdog (2026-10-27, owner-approved) ────────────────────────────────
# v1.24.31's release stalled SILENTLY (then in the local test stage): no tag, no error,
# nothing for minutes — the operator only noticed because nothing happened. A
# frozen stage must FAIL LOUDLY, not hang. The stages run through here (version bump,
# push) go under `timeout` with a per-stage ceiling; the guards bound their own waits
# (RELEASE_FETCH_TIMEOUT, RELEASE_CI_CEILING). A timeout names the stage, prints where
# it stopped, and exits non-zero so no later stage (tag, push, publish-watch) can run
# on a half-finished release.
run_stage() {  # $1=name  $2=ceiling_seconds  rest=command — fails LOUD. Banner and stage
  # output go to STDERR so a captured stage still yields only the command's own stdout.
  # On failure, the function named by $RELEASE_STAGE_RECOVERY_FN (set per call site) prints
  # the exact undo steps, computed at failure time — otherwise the next run's "AHEAD"
  # message would tell the operator to push the untested bump to main.
  local name="$1" ceiling="$2"; shift 2
  local rc=0
  echo "==> $name (ceiling ${ceiling}s)" >&2
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ceiling" "$@" || rc=$?
  else
    "$@" || rc=$?
  fi
  if [ "$rc" -ne 0 ]; then
    echo "✗ STAGE FAILED: $name (rc=$rc${rc:+, }ceiling ${ceiling}s — frozen or errored; release aborted before any later stage)" >&2
    if [[ -n "${RELEASE_STAGE_RECOVERY_FN:-}" ]]; then
      echo "    To undo this attempt:" >&2
      "$RELEASE_STAGE_RECOVERY_FN" 2>&1 | sed 's/^/      /' >&2
    fi
    exit "$rc"
  fi
}
BUMP="${1:-patch}"
# Clones name the GitHub remote differently ('private' on some, 'origin' on others):
# prefer 'private' when it exists, else 'origin'. Checked before anything else so a
# missing remote fails in seconds, not after a CI wait and a local version bump.
if git remote get-url private >/dev/null 2>&1; then DEFAULT_REMOTE=private; else DEFAULT_REMOTE=origin; fi
REMOTE="${RELEASE_REMOTE:-$DEFAULT_REMOTE}"
# Fixed, never read from the environment: guards and the CI lookup both key on it.
BASE_BRANCH=main
BRANCH="$BASE_BRANCH"   # the on-base-branch guard below proves HEAD IS refs/heads/main
if ! git remote get-url "$REMOTE" >/dev/null 2>&1; then
  echo "✗ Git remote '$REMOTE' does not exist in this clone (remotes: $(git remote | tr '\n' ' ')). Set RELEASE_REMOTE." >&2
  exit 1
fi

# The CI proof must come from the repository that receives the push. The GitHub repo is
# DERIVED from the remote's PUSH url (github.com URLs only) — an unparseable or non-GitHub
# remote is refused outright; MAXPOOL_GH_REPO may only confirm it, never supply or
# override it (a wrong-repo CI proof is worse than no release).
PUSH_URL="$(git remote get-url --push "$REMOTE")"
REMOTE_GH_REPO="$(release_github_repo_from_url "$PUSH_URL" || true)"
if [[ -z "$REMOTE_GH_REPO" ]]; then
  echo "✗ Cannot derive a GitHub owner/repo from remote '$REMOTE' ($PUSH_URL) — it must be a github.com URL. Release refused." >&2
  exit 1
fi
GH_REPO="$REMOTE_GH_REPO"
if [[ -n "${MAXPOOL_GH_REPO:-}" ]] && \
   [[ "$(printf '%s' "$MAXPOOL_GH_REPO" | tr 'A-Z' 'a-z')" != "$(printf '%s' "$REMOTE_GH_REPO" | tr 'A-Z' 'a-z')" ]]; then
  echo "✗ MAXPOOL_GH_REPO ($MAXPOOL_GH_REPO) differs from remote '$REMOTE' ($REMOTE_GH_REPO): the CI proof would come from a different repository than the one receiving the push. Release refused." >&2
  exit 1
fi

# Stale-copy guard first, before any other work (fetches, then refuses unless HEAD
# equals remote main). Runs before the dirty-tree check on purpose: it only reads refs.
release_require_on_base_branch "$BASE_BRANCH"
release_require_synced_with_remote "$REMOTE" "$BASE_BRANCH"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is dirty. Commit your changes first, then release." >&2
  git status --short >&2
  exit 1
fi

# 2026-11-21: local test + lint stages removed. Release proceeds only from a copy that
# equals remote main — a stale copy once published v1.24.120 without PR 14 — and only
# when CI passed for this exact commit. RELEASE_CI_CEILING (default 1800s) bounds the
# wait for a still-running CI.
CI_SHA="$(git rev-parse HEAD)"
release_require_ci_green "$GH_REPO" "$CI_SHA" "$BASE_BRANCH"

# main can move during the CI wait; re-prove the copy is still current (and unchanged)
# right before the bump so no stray bump commit/tag is created on an old base.
release_require_synced_with_remote "$REMOTE" "$BASE_BRANCH"
if [[ "$(git rev-parse HEAD)" != "$CI_SHA" ]]; then
  echo "✗ HEAD changed while waiting for CI (was ${CI_SHA:0:9}, now $(git rev-parse --short=9 HEAD)). Release refused." >&2
  exit 1
fi

echo "==> Bumping version ($BUMP) — creates a commit + tag"
# Recovery after a failed bump/push, printed by run_stage on failure so the operator never
# follows the next run's "AHEAD" hint and pushes an untested bump. Tags to delete are the
# ones THIS attempt created: the v* tag list is snapshotted before the bump and diffed at
# failure time (never "all unmerged tags" — this clone carries dozens of those, and main's
# tip usually already carries the previous release's own tag).
OLD_SHA="$(git rev-parse HEAD)"
TAGS_BEFORE="$(git tag -l 'v*')"
recovery_bump() { release_recovery_bump "$OLD_SHA" "$TAGS_BEFORE"; }
recovery_push() { release_recovery_push "$REMOTE" "$NEW_VERSION" "$BASE_BRANCH"; }
RELEASE_STAGE_RECOVERY_FN=recovery_bump
run_stage "Version bump" 120 npm version "$BUMP" -m "chore: release v%s"
# Read the version from package.json, not from npm's stdout: the `version` hook
# (update-changelog.sh) prints to the same stdout and polluted the captured value.
NEW_VERSION="$(release_package_version)" || {
  echo "✗ Could not read the new version from package.json after the bump." >&2
  echo "    To undo this attempt:" >&2
  recovery_bump | sed 's/^/      /' >&2
  exit 1
}
echo "    v$NEW_VERSION"

echo "==> Pushing to $REMOTE/$BRANCH (with tag) — the tag triggers the Publish Action"
RELEASE_STAGE_RECOVERY_FN=recovery_push
# Push the branch by its full ref so a tag also named "main" cannot make the source ambiguous.
run_stage "Push to $REMOTE/$BRANCH" 120 git push --atomic "$REMOTE" "refs/heads/$BRANCH" --follow-tags
RELEASE_STAGE_RECOVERY_FN=

echo "==> npm publish runs on GitHub Actions (Trusted Publishing, OIDC — no token)."
TAG="v$NEW_VERSION"
if command -v gh >/dev/null 2>&1; then
  echo "    Watching the Publish workflow for $TAG ..."
  sleep 6  # let GitHub register the tag-triggered run
  RUN_ID="$(release_gh run list --repo "$GH_REPO" --workflow publish.yml -L 5 \
    --json databaseId,headBranch -q "[.[] | select(.headBranch==\"$TAG\")][0].databaseId" 2>/dev/null || true)"
  if [[ -n "$RUN_ID" ]]; then
    # Own ceiling (RELEASE_WATCH_TIMEOUT, default 1800s): the Publish workflow takes minutes,
    # far past the 60s that bounds the short list/view calls.
    watch_rc=0
    release_gh_watch run watch "$RUN_ID" --repo "$GH_REPO" --exit-status || watch_rc=$?
    if [[ "$watch_rc" -eq 0 ]]; then
      echo "==> Published maxpool v$NEW_VERSION to npm via Trusted Publishing."
    else
      echo "✗ Publish workflow watch ended rc=$watch_rc (124 = exceeded RELEASE_WATCH_TIMEOUT). The tag $TAG IS pushed — do NOT undo it. See: gh run view $RUN_ID --repo $GH_REPO --log-failed" >&2
      exit 1
    fi
  else
    echo "    (Could not locate the run yet — check: gh run list --repo $GH_REPO --workflow publish.yml)"
  fi
fi

echo "==> Released maxpool v$NEW_VERSION → GitHub ($REMOTE/$BRANCH); npm via Actions."
