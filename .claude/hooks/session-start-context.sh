#!/usr/bin/env bash
#
# session-start-context.sh — SessionStart hook.
#
# Injects the project-memory HEAD into a fresh session so it picks up where the
# last one left off, without the model having to remember to open the files.
# stdout from a SessionStart hook is added to the session context.
#
# Deliberately bounded (Current focus + a few unreleased commits) — the full log
# is docs/CONTEXT.md, which CLAUDE.md instructs the model to read. Never dump the
# whole memory here; that would spend context every session.
set -euo pipefail

ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" 2>/dev/null || exit 0

echo "## Maxpool project memory (auto-injected at session start)"
echo
echo "Before non-trivial work, read \`CLAUDE.md\` (facts + hard invariants) and \`docs/CONTEXT.md\` (full living log). After any decision or shipped change, append a dated entry to \`docs/CONTEXT.md\`."
echo

if [ -f docs/CONTEXT.md ]; then
  echo "### Current focus (from docs/CONTEXT.md)"
  # Lines between "## Current focus" and the next "---" or "## " heading.
  awk '
    /^## Current focus/ { f=1; next }
    f && (/^---[[:space:]]*$/ || /^## /) { exit }
    f { print }
  ' docs/CONTEXT.md | sed '/^[[:space:]]*$/d' | head -25 || true
  echo
fi

LAST_TAG="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -n "${LAST_TAG}" ]; then
  UNREL="$(git log "${LAST_TAG}..HEAD" --no-merges --pretty=format:'- %s' 2>/dev/null | head -15 || true)"
  if [ -n "${UNREL}" ]; then
    echo "### Commits since ${LAST_TAG} (unreleased)"
    echo "${UNREL}"
    echo
  fi
fi

exit 0
