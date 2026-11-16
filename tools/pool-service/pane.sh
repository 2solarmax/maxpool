#!/bin/bash
# The one command inside the background service's tmux pane (see install.sh).
#
# launchd starts tmux; tmux runs this. It finds node, waits until the pool port is
# free, runs maxpool in the foreground (so the dashboard and seamless reload work
# exactly as in a Terminal tab), and when maxpool exits it kills its own tmux
# server, so launchd sees the job end and restarts it.
#
# Every setting comes from the plist install.sh writes: MAXPOOL_DIR, MAXPOOL_PORT,
# MAXPOOL_TMUX_SOCK, MAXPOOL_NODE_BIN (node pinned at install), optional
# MAXPOOL_CMD (an explicit maxpool entry point, used by the canary). The pane's
# own output is the dashboard and is never redirected; this script's own lines go
# to <dir>/pane.log.
set -uo pipefail

DIR="${MAXPOOL_DIR:?MAXPOOL_DIR is not set}"
PORT="${MAXPOOL_PORT:-3456}"
SOCK="${MAXPOOL_TMUX_SOCK:-$DIR/tmux.sock}"
LOG="$DIR/pane.log"
mkdir -p "$DIR"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# July's resolver (e422944): the nvm default alias, then the newest installed nvm
# node, then a system node. Used only when the node pinned at install is gone.
find_node_bin() {
  local alias_file="$HOME/.nvm/alias/default" want d newest
  if [ -r "$alias_file" ]; then
    want="$(cat "$alias_file" 2>/dev/null)"
    for d in "$HOME/.nvm/versions/node/v$want".*; do
      [ -x "$d/bin/node" ] && { echo "$d/bin"; return 0; }
    done
    [ -x "$HOME/.nvm/versions/node/$want/bin/node" ] && { echo "$HOME/.nvm/versions/node/$want/bin"; return 0; }
  fi
  newest="$(ls -d "$HOME"/.nvm/versions/node/v* 2>/dev/null | sort -V | tail -1)"
  [ -n "$newest" ] && [ -x "$newest/bin/node" ] && { echo "$newest/bin"; return 0; }
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin; do
    [ -x "$d/node" ] && { echo "$d"; return 0; }
  done
  return 1
}

log "start pid=$$ port=$PORT"

NODE_BIN="${MAXPOOL_NODE_BIN:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN/node" ]; then
  NODE_BIN="$(find_node_bin || true)"
  log "FALLBACK node=${NODE_BIN:-none} (pinned ${MAXPOOL_NODE_BIN:-unset} is missing)"
fi
# launchd's PATH is nearly empty: without this, auto-update (npm) and provider keys
# (gcloud) quietly fail under the service.
export PATH="${NODE_BIN:+$NODE_BIN:}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export LANG=en_US.UTF-8
export MAXPOOL_SERVICE=1
log "node=$(command -v node || echo MISSING) npm=$(command -v npm || echo MISSING) gcloud=$(command -v gcloud || echo MISSING) LANG=$LANG"

# Never fight an instance already serving the port (a Terminal pool during the
# cutover, or an old pane still draining): wait, checking every second.
port_is_open() { (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1; }
waited=0
while port_is_open; do
  [ "$waited" -eq 0 ] && log "waiting for port $PORT (already served)"
  sleep 1
  waited=$((waited + 1))
done
[ "$waited" -gt 0 ] && log "port $PORT free after ${waited}s"

log "starting maxpool"
started=$(date +%s)
"${MAXPOOL_CMD:-maxpool}"
code=$?
ran=$(( $(date +%s) - started ))
log "maxpool exited code=$code after ${ran}s"
[ "$ran" -lt 30 ] && log "FAST EXIT code $code"

# tmux -D keeps an empty server alive, and launchd would think the pool is healthy.
tmux -S "$SOCK" kill-server >/dev/null 2>&1
exit "$code"
