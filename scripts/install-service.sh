#!/bin/bash
# Install (or refresh) the launchd job that keeps `maxpool server` running.
#
# Run it once. It writes ~/Library/LaunchAgents/com.mokka.maxpool.plist, loads it, and
# reports what launchd thinks. Safe to re-run: it replaces the job in place.
#
# Installing while a terminal `maxpool server` is already up does NOT disturb it — the
# wrapper waits for :3456 to be free and takes over only when the terminal one exits.
set -euo pipefail

LABEL="com.mokka.maxpool"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WRAPPER="$HERE/maxpool-service.sh"
UID_NUM="$(id -u)"

[ -x "$WRAPPER" ] || { echo "not executable: $WRAPPER" >&2; exit 1; }

# Written from a heredoc rather than committed as a file because a plist needs absolute
# paths, and a committed one would carry whatever home directory it was authored on.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$WRAPPER</string>
    </array>
    <!-- Start at login, and start again whenever it stops: this is a service, and every
         Claude Code session depends on it answering on :3456. -->
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <!-- Ten seconds between restarts. Without it, a wrapper that exits instantly is
         retried in a tight loop; with it, the crash-loop detector has room to notice. -->
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <!-- Interactive, not Background: Background jobs get throttled disk and CPU priority,
         which on a proxy in the request path of every keystroke-to-token round trip shows
         up as latency. -->
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>/tmp/maxpool-service.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/maxpool-service-error.log</string>
</dict>
</plist>
PLIST_EOF

echo "wrote $PLIST"

# bootout first so a re-run picks up an edited plist instead of silently keeping the old one.
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl enable "gui/$UID_NUM/$LABEL" 2>/dev/null || true

sleep 2
echo
echo "launchd says:"
launchctl list | grep -F "$LABEL" || echo "  (not listed — check /tmp/maxpool-service-error.log)"
echo
echo "service log : ~/.config/maxpool-service/service.log"
echo "restart it  : launchctl kickstart -k gui/$UID_NUM/$LABEL"
echo "remove it   : launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST"
