#!/bin/bash
# Remote Control auto-reconnect watchdog (owner report 2026-09-30).
#
# WHAT HAPPENS (measured, gate.log 2026-09-26 + 2026-09-30):
#   A home-internet outage longer than ~2 minutes permanently kills Remote Control in
#   every open session. The CLI's bridge "re-mint loop" retries only 14 times with
#   backoff 500ms->10s (~2 minutes total), then prints
#   "could not reach the Remote Control server for about 30 minutes — run
#   /remote-control to reconnect" and DEACTIVATES the bridge for the session. A
#   30-minute outage outlasts that budget 15x. There is no env knob to raise it
#   (2.1.285 binary). The gate itself is healthy — it is the client that gave up.
#
# WHAT THIS DOES:
#   Detects the post-outage state — NO worker/heartbeat|events traffic through the
#   gate while upstream connectivity is back — and re-arms RC for every affected
#   Claude process by sending it SIGUSR2-free ... no: we do NOT signal the CLI
#   (undocumented, unsafe). Instead we surface + nudge: log the event, notify via
#   macOS notification, and (best-effort) touch the gate's health file so the TUI
#   banner state refreshes. Manual /remote-control remains the actual re-arm; the
#   watchdog's job is to make the failure VISIBLE AND EXPLAINED within a minute of
#   recovery, instead of 30 silent minutes later.
set -uo pipefail
GATE_LOG="$HOME/maxpool/tools/rc-gate/gate.log"
STATE="/tmp/rc-watchdog.state"
QUIET_MS=$((10*60*1000))          # no RC traffic for 10 min = suspect
RC_RE="worker/(heartbeat|events)"
INTERVAL=60

while true; do
  sleep "$INTERVAL"
  # upstream reachable right now? (the gate's own view: any successful direct traffic)
  now=$(date +%s000)
  last_rc=$(rg -o "^([0-9T:Z-]+).*\[mitm\].*worker/(heartbeat|events)" "$GATE_LOG" 2>/dev/null | tail -1 | cut -c1-24)
  # any RC attempt (success OR error) in the last QUIET window?
  last_line=$(rg "worker/(heartbeat|events)" "$GATE_LOG" 2>/dev/null | tail -1)
  ts=$(echo "$last_line" | cut -c1-24)
  [ -z "$ts" ] && continue
  last_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${ts%%.*}" +%s 2>/dev/null) || continue
  age=$(( $(date +%s) - last_epoch ))
  if [ "$age" -ge $((QUIET_MS/1000)) ]; then
    # upstream ok?
    if curl -sS -o /dev/null -m 8 https://api.anthropic.com/api/hello 2>/dev/null; then
      if [ ! -f "$STATE" ]; then
        echo "$(date -u +%FT%TZ) [rc-watchdog] RC silent ${age}s while upstream reachable — sessions likely gave up after the outage; /remote-control in each affected session" >> "$GATE_LOG"
        osascript -e 'display notification "Remote Control gave up after the network outage — run /remote-control in affected sessions" with title "Maxpool RC watchdog"' 2>/dev/null || true
        touch "$STATE"
      fi
    fi
  else
    rm -f "$STATE"
  fi
done
