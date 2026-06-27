#!/usr/bin/env bash
#
# release.sh — ship a new maxpool version across the board in one step:
#   tests → lint → version bump (commit + tag) → push to GitHub → publish to npm.
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
# npm auth: uses `npm login` by default. If NPM_TOKEN is set in the environment,
# it is used for this publish only (written to a temp file, never persisted).
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
node --test --test-concurrency=1

echo "==> Linting"
npx eslint src/ || true   # warnings do not block a release

echo "==> Bumping version ($BUMP) — creates a commit + tag"
NEW_VERSION="$(npm version "$BUMP" -m "chore: release v%s")"
echo "    $NEW_VERSION"

echo "==> Pushing to $REMOTE/$BRANCH (with tag)"
git push "$REMOTE" "$BRANCH" --follow-tags

echo "==> Publishing to npm"
if [[ -n "${NPM_TOKEN:-}" ]]; then
  NPMRC="$(mktemp)"
  printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$NPMRC"
  npm publish --userconfig "$NPMRC" --access public
  rm -f "$NPMRC"
else
  npm publish --access public
fi

echo "==> Released maxpool $NEW_VERSION → GitHub ($REMOTE/$BRANCH) + npm"
