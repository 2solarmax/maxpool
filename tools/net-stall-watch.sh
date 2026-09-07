#!/bin/bash
# Emits one line per network-stall-relevant event across BOTH hops, so the next
# "will retry in Nm · check your network" can be attributed instead of guessed:
#   maxpool  -> upstream network errors, all-routes-failed, queue holds, 429/503
#   rc-gate  -> forward errors on the inference path
# Timestamped in UTC because these are read back hours later.
# -n 0: emit only lines written AFTER this watcher starts. Plain `tail -F` replays
# the last 10 lines of every file on each restart, which re-alerted hours-old
# failures as if they were live (2026-09-07) — an instrument that cries wolf.
tail -n 0 -F ~/.config/teamclaude.log ~/maxpool/tools/rc-gate/gate.log /tmp/hop-probe.log 2>/dev/null \
| grep --line-buffered -E "fetch failed|all routes failed|No route for request|connection_unavailable|Network soak budget|queueing request|^[0-9-]{10}T[0-9:]{8}Z (FAIL|SLOW|DNSFAIL|DNSSLOW)|rc_gate_upstream_error|direct-error.*v1/messages|loop-stall|resp-break" \
| while IFS= read -r line; do
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | ${line:0:200}"
  done
