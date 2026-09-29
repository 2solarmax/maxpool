#!/bin/bash
# One updater for the whole machine.
#
# WHY: every Claude Code session runs its OWN auto-updater (startup + every 30
# min). With ~30 parallel sessions they race the same install dir; losers write
# outcome:"failed" into ~/.claude/.last-update-result.json, which is MACHINE-WIDE
# and never cleared on a later success. Every session started afterwards then
# shows "Auto-update failed - Run claude doctor" even though the machine is fully
# up to date. Measured 2026-09-26: 2.1.283 installed 00:50, a failed attempt at
# 07:54 left that file failed, and the banner persisted for days.
#
# FIX: sessions set DISABLE_AUTOUPDATER=1 (turns off the per-session updater,
# leaves `claude update` working); this script is the single updater.
set -uo pipefail
export PATH="$HOME/.local/bin:$PATH"   # launchd's PATH lacks it; `claude update` warns without it

LOG="$HOME/Library/Logs/claude-update-daily.log"
RESULT="$HOME/.claude/.last-update-result.json"
CLAUDE="$HOME/.local/bin/claude"
say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"; }

before=$("$CLAUDE" --version 2>/dev/null | awk '{print $1}')
out=$(DISABLE_AUTOUPDATER= "$CLAUDE" update 2>&1)
rc=$?
after=$("$CLAUDE" --version 2>/dev/null | awk '{print $1}')
say "rc=$rc before=$before after=$after :: $(echo "$out" | tr '\n' ' ')"

# The banner reads this file. A stale failure from a losing race keeps every new
# session red, so clear it whenever the machine is actually current.
# Success is: rc=0 AND (the updater's own success words OR the version actually
# moved). 2026-09-29: "Successfully updated from 2.1.283 to version 2.1.284"
# matched NEITHER of the original phrases (the grep looked for "Updated to"),
# so a real successful update exited 1 and the fleet sweep flagged the job red.
# OR (not a semicolon list): `{ grep; [ a ] && [ b ]; }` returns the status of
# the LAST element — a version-unchanged "up to date" run made the [ ] chain
# short-circuit to 1 and swallowed the grep's success (found live 2026-09-29).
if [ "$rc" -eq 0 ] && { echo "$out" | grep -qiE "up to date|installed successfully|updated to|successfully updated" || { [ "$before" != "$after" ] && [ -n "$after" ]; }; }; then
  if [ -f "$RESULT" ] && grep -q '"outcome":"failed"' "$RESULT" 2>/dev/null; then
    python3 - "$RESULT" "$after" <<'PY'
import json, sys, datetime
p, ver = sys.argv[1], sys.argv[2]
json.dump({"timestamp": datetime.datetime.now(datetime.timezone.utc)
           .strftime("%Y-%m-%dT%H:%M:%S.000Z"),
           "path": "native", "outcome": "success", "status": "success",
           "version_from": ver, "version_to": ver, "error_code": None},
          open(p, "w"))
PY
    say "cleared stale failed update-result (machine is current at $after)"
  fi
  exit 0
fi

say "UPDATE FAILED rc=$rc — leaving the result file alone for diagnosis"
exit 1
