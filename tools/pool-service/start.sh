#!/bin/bash
# launchd's program for the background service (see install.sh).
#
# Starts the private tmux server, then connects to it once: a `tmux -D -f conf`
# server does not run its config (which creates the pool session) until the first
# client connects, and under launchd nothing else connects — the pool would never
# start after a crash or a reboot until someone attached. Then it waits on tmux,
# so launchd sees tmux's exit (pane.sh's kill-server) and KeepAlive restarts us.
set -uo pipefail

DIR="${MAXPOOL_DIR:?MAXPOOL_DIR is not set}"
SOCK="${MAXPOOL_TMUX_SOCK:-$DIR/tmux.sock}"
TMUX_BIN="${MAXPOOL_TMUX_BIN:-/opt/homebrew/bin/tmux}"
WAIT_SECS="${MAXPOOL_START_WAIT_SECS:-30}"
LOG="$DIR/pane.log"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

"$TMUX_BIN" -D -S "$SOCK" -f "$DIR/tmux.conf" &
TMUX_PID=$!
# launchd stops the job with SIGTERM to this script: hand it to tmux, as before.
trap 'kill -TERM "$TMUX_PID" 2>/dev/null' TERM INT

up=0
for (( i = 0; i < WAIT_SECS; i++ )); do
  "$TMUX_BIN" -S "$SOCK" has-session -t pool >/dev/null 2>&1 && { up=1; break; }
  sleep 1
done
[ "$up" -eq 1 ] || log "start.sh: tmux server never created the pool session within ${WAIT_SECS}s"

wait "$TMUX_PID"
code=$?
while kill -0 "$TMUX_PID" 2>/dev/null; do   # a trapped signal interrupted the wait
  wait "$TMUX_PID"
  code=$?
done
exit "$code"
