#!/bin/bash
# Keep the maxpool proxy running, without a terminal window.
#
# Why this exists: every `cc` session points ANTHROPIC_BASE_URL at the proxy on
# 127.0.0.1:3456. Until now the proxy only ever ran because a human had a terminal open
# with `maxpool server` in it — nothing started it at login, and nothing brought it back
# after a reboot. That is invisible while the window happens to be open, and total when it
# isn't: every session fails on its first token with a connection error, and the failure
# looks like Claude being down rather than a local proxy being absent. It matters most in
# exactly the situation you least want to debug — restoring a pile of panes after a crash,
# where each one starts, connects to nothing, and dies.
#
# launchd runs this at login and restarts it if it exits. Everything below is about the two
# ways that can go wrong: fighting an instance that is already there, and dying so fast that
# nobody notices.
set -uo pipefail

PORT="${MAXPOOL_PORT:-3456}"
STATE="$HOME/.config/maxpool-service"
LOG="$STATE/service.log"
mkdir -p "$STATE"

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG"; }

# Keep the log from growing without bound; nothing else ever trims it.
if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt 2000000 ]; then
  tail -n 2000 "$LOG" > "$LOG.tmp" 2>/dev/null && mv "$LOG.tmp" "$LOG"
fi

# ── find node ─────────────────────────────────────────────────────────────────────────
# launchd starts us with almost no PATH — not the one from .zshrc — so node has to be
# located explicitly. Resolving it through the nvm *default alias* rather than hardcoding
# a version means a `nvm install` later doesn't silently strand this service on a version
# that has been uninstalled.
find_node_bin() {
  local alias_file="$HOME/.nvm/alias/default" want d newest
  if [ -r "$alias_file" ]; then
    want="$(cat "$alias_file" 2>/dev/null)"
    for d in "$HOME/.nvm/versions/node/v$want".*; do
      [ -x "$d/bin/node" ] && { echo "$d/bin"; return 0; }
    done
    [ -x "$HOME/.nvm/versions/node/$want/bin/node" ] && { echo "$HOME/.nvm/versions/node/$want/bin"; return 0; }
  fi
  # Fall back to the newest installed version, then to a system node.
  newest="$(ls -d "$HOME"/.nvm/versions/node/v* 2>/dev/null | sort -V | tail -1)"
  [ -n "$newest" ] && [ -x "$newest/bin/node" ] && { echo "$newest/bin"; return 0; }
  for d in /opt/homebrew/bin /usr/local/bin /usr/bin; do
    [ -x "$d/node" ] && { echo "$d"; return 0; }
  done
  return 1
}

NODE_BIN="$(find_node_bin || true)"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN/maxpool" ]; then
  log "FATAL: no node/maxpool found (looked under ~/.nvm, homebrew, /usr) — not starting"
  # Exit 78 (EX_CONFIG) so launchd's KeepAlive doesn't spin on something a restart can't fix.
  sleep 30
  exit 78
fi
export PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin"

# ── don't fight an instance that is already there ─────────────────────────────────────
# Installing this while a `maxpool server` TUI is open in a terminal must not disturb it:
# that one instance may be carrying dozens of live agent sessions. Two processes cannot
# both hold :3456, so rather than racing for the port (and crash-looping against the
# winner), wait until it is genuinely free. Sleeping costs nothing and hands over cleanly
# the moment the terminal one goes away.
port_is_open() {
  # Pure-bash TCP probe: no curl, no nc, nothing spawned per check. The subshell exits
  # immediately, which closes the descriptor with it.
  (exec 3<>"/dev/tcp/127.0.0.1/$PORT") >/dev/null 2>&1
}
waited=0
while port_is_open; do
  if [ "$waited" -eq 0 ]; then
    log "port $PORT already served (a terminal maxpool is running) — standing by"
  fi
  sleep 10
  waited=$(( waited + 10 ))
done
[ "$waited" -gt 0 ] && log "port $PORT free after ${waited}s — taking over"

# ── notice a crash loop instead of restarting forever in silence ──────────────────────
# launchd will restart this indefinitely. If maxpool is failing on startup (a bad config, a
# dead token store, a port held by something that is not maxpool) that becomes an infinite
# quiet loop, and the first you'd hear of it is every session erroring. Count recent starts
# and say something out loud once it stops looking like a one-off.
STAMPS="$STATE/starts"
now="$(date +%s)"
printf '%s\n' "$now" >> "$STAMPS"
tail -n 20 "$STAMPS" > "$STAMPS.tmp" 2>/dev/null && mv "$STAMPS.tmp" "$STAMPS"
recent=0
while read -r t; do
  [ -n "$t" ] && [ "$(( now - t ))" -lt 180 ] && recent=$(( recent + 1 ))
done < "$STAMPS"

if [ "$recent" -ge 4 ]; then
  log "WARN: $recent starts in the last 3 minutes — maxpool is not staying up"
  # Alerting is left to the machine rather than baked in here: drop an executable at
  # ~/.config/maxpool-service/on-crashloop and it gets called with the restart count. Keeps
  # this file free of any one workplace's Slack channel, and means the alert can be a
  # notification, a page, or nothing at all depending on whose laptop this is.
  HOOK="$STATE/on-crashloop"
  [ -x "$HOOK" ] && "$HOOK" "$recent" >>"$LOG" 2>&1 &
fi

log "starting maxpool server"
# exec, so launchd supervises maxpool itself rather than this wrapper: the pid it watches is
# the real process, and a crash is seen as a crash.
exec maxpool server
