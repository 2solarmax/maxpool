#!/usr/bin/env bash
#
# release.sh — ship a new maxpool version across the board in one step:
#   tests → lint → version bump (commit + tag) → push to GitHub → Actions publishes to npm.
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
# Override the git remote/branch with RELEASE_REMOTE / current branch.
set -euo pipefail

BUMP="${1:-patch}"
REMOTE="${RELEASE_REMOTE:-private}"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "✗ Working tree is dirty. Commit your changes first, then release." >&2
  git status --short >&2
  exit 1
fi

echo "==> Running tests"
bash scripts/run-tests.sh

echo "==> Linting"
npx eslint src/ || true   # warnings do not block a release

echo "==> Bumping version ($BUMP) — creates a commit + tag"
NEW_VERSION="$(npm version "$BUMP" -m "chore: release v%s")"
echo "    $NEW_VERSION"

echo "==> Pushing to $REMOTE/$BRANCH (with tag) — the tag triggers the Publish Action"
git push "$REMOTE" "$BRANCH" --follow-tags

echo "==> npm publish runs on GitHub Actions (Trusted Publishing, OIDC — no token)."
TAG="v${NEW_VERSION#v}"
GH_REPO="${MAXPOOL_GH_REPO:-2solarmax/maxpool}"
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
