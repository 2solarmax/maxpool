#!/bin/bash
# Install/refresh the rc-gate LaunchAgent.
#
# launchd is the gate's ONLY supervisor. A hand-rolled supervise.sh loop lived here
# briefly on 2026-09-06 and had to be deleted: it raced the cc wrapper's own
# auto-start, restart-stormed the gate, and bricked every live session. launchd has
# one owner, KeepAlive restart-on-crash, and a throttle. Do not reintroduce a
# userspace supervisor.
# ProcessType / ExitTimeOut land ONLY through this script (unload/load); `launchctl kickstart -k`
# restarts the job but keeps its old spawn type and ExitTimeOut.
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

# Verify what launchd itself says about the job. `launchctl print` reports ProcessType as
# `spawn type = <daemon|interactive|background> (N)`; anything but interactive means the plist's
# ProcessType did not apply (e.g. a stale copy or an old agent still loaded). The gate stays up,
# but the install is reported as FAILED (exit 2) so the operator notices.
# shellcheck source=launchd-spawn-type.sh
. "$(cd "$(dirname "$0")" && pwd)/launchd-spawn-type.sh"
JOB="gui/$(id -u)/com.mokka.rc-gate"
if PRINT="$(launchctl print "$JOB" 2>&1)"; then
  echo "launchd job $JOB: $(printf '%s\n' "$PRINT" | grep -m1 -E '^[[:space:]]*state = ' | sed 's/^[[:space:]]*//' || true)"
  SPAWN="$(printf '%s\n' "$PRINT" | rc_gate_spawn_type)"
  echo "launchd spawn type: ${SPAWN:-<not printed>}"
  if [ "$SPAWN" != "interactive" ]; then
    echo "WARN: rc-gate is not running as an Interactive job (spawn type = ${SPAWN:-unknown}) — ProcessType did not apply" >&2
    exit 2
  fi
else
  echo "WARN: 'launchctl print $JOB' failed, cannot verify ProcessType: $(printf '%s' "$PRINT" | head -1)" >&2
  exit 2
fi
