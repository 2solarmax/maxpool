#!/usr/bin/env bash
#
# update-changelog.sh — regenerate CHANGELOG.md from the Conventional-Commit
# history via git-cliff, then stage it.
#
# Called by the package.json "version" lifecycle hook during `npm version`
# (which scripts/release.sh runs). npm runs this AFTER bumping package.json and
# BEFORE creating the release commit, so the refreshed CHANGELOG.md folds into
# that commit + its vX.Y.Z tag — one source of truth, no separate changelog PR.
#
# Uses the PINNED local git-cliff binary (never `npx @latest`), so a changelog
# tool can never pull the network into the release path or break a release.
# The node pass collapses git-cliff's inter-section blank runs to a single blank
# line (Keep a Changelog spacing) and trims to exactly one trailing newline —
# node, not perl/sed, so the release path stays within the one runtime this repo
# already requires. Run it standalone any time to refresh the file:
#   bash scripts/update-changelog.sh
set -euo pipefail
cd "$(dirname "$0")/.."

BIN="./node_modules/.bin/git-cliff"
if [[ ! -x "$BIN" ]]; then
  echo "✗ git-cliff not installed. Run: npm install" >&2
  exit 1
fi

# The version being cut = whatever is now in package.json (npm already bumped it
# by the time the version hook runs). Read it from the FILE, not
# \$npm_package_version, which is unreliable inside the version lifecycle.
VERSION="v$(node -p "require('./package.json').version")"

# Collapse blank-line runs to one + exactly one trailing newline (Keep a Changelog).
"$BIN" --config cliff.toml --tag "$VERSION" \
  | node -e 'const s=require("fs").readFileSync(0,"utf8");process.stdout.write(s.replace(/\n{3,}/g,"\n\n").replace(/\s*$/,"\n"))' \
  > CHANGELOG.md
git add CHANGELOG.md
echo "==> CHANGELOG.md regenerated for $VERSION and staged."
