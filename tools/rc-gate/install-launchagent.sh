#!/bin/bash
# Install/refresh the rc-gate LaunchAgent.
#
# launchd is the gate's ONLY supervisor. A hand-rolled supervise.sh loop lived here
# briefly on 2026-09-06 and had to be deleted: it raced the cc wrapper's own
# auto-start, restart-stormed the gate, and bricked every live session. launchd has
# one owner, KeepAlive restart-on-crash, and a throttle. Do not reintroduce a
# userspace supervisor.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)/launchd/com.mokka.rc-gate.plist"
DEST="$HOME/Library/LaunchAgents/com.mokka.rc-gate.plist"
NODE_BIN="$(command -v node)"

# The plist pins an absolute node path (launchd has no PATH); rewrite it to whatever
# node this machine actually has, so the agent never silently fails to exec.
python3 - "$SRC" "$DEST" "$NODE_BIN" <<'PY'
import sys, re, pathlib
src, dest, node = sys.argv[1], sys.argv[2], sys.argv[3]
xml = pathlib.Path(src).read_text()
xml = re.sub(r'<string>[^<]*/bin/node</string>', f'<string>{node}</string>', xml, count=1)
pathlib.Path(dest).write_text(xml)
print(f'installed {dest} (node: {node})')
PY

launchctl unload "$DEST" 2>/dev/null || true
launchctl load "$DEST"
sleep 3
if lsof -ti :3457 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "rc-gate is listening on 127.0.0.1:3457 (pid $(lsof -ti :3457 -sTCP:LISTEN))"
else
  echo "ERROR: rc-gate did not come up — check tools/rc-gate/gate.log" >&2
  exit 1
fi
