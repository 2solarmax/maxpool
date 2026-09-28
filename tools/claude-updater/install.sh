#!/bin/bash
# Install the single machine updater and stop the per-session updaters racing it.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.mokka.claude-update-daily.plist"

cp "$HERE/com.mokka.claude-update-daily.plist" "$PLIST"
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "loaded com.mokka.claude-update-daily"

# Per-session auto-updater OFF: `claude update` (used by the agent above) keeps working.
python3 - "$HOME/.claude/settings.json" <<'PY'
import json, sys
p = sys.argv[1]
s = json.load(open(p))
env = s.setdefault("env", {})
if env.get("DISABLE_AUTOUPDATER") != "1":
    env["DISABLE_AUTOUPDATER"] = "1"
    json.dump(s, open(p, "w"), indent=2)
    print("settings.json: DISABLE_AUTOUPDATER=1 (sessions no longer race the installer)")
else:
    print("settings.json: already set")
PY
echo "done — new sessions stop self-updating; the daily agent owns updates."
