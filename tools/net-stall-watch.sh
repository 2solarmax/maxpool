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
    # A SINGLE "CLIENT closed before response completed" is almost always the user
    # pressing Esc or a subagent being cancelled — normal, and paging on it would
    # make this watcher noise (first one seen 2026-09-07 was exactly that: 9.2KB in
    # 7.5s at load 4). A BURST is different: 3+ inside 60s means clients are losing
    # responses they wanted. Everything is still written to gate.log for forensics;
    # this only governs what interrupts.
    case "$line" in
      # A SUB-SECOND event-loop stall is ordinary CPU contention on a busy laptop, not a
      # signal — measured 2026-09-11: 5 of them inside 15 minutes at load 9 while maxpool
      # served 200s throughout, each reported individually and each a non-event. The class
      # worth waking someone for is a LONG block (>2s, the starvation signature) or a
      # BURST of shorter ones. Sleep is already excluded upstream by the gate's own
      # classifier, so anything reaching here is genuine CPU, just usually harmless.
      *"[loop-stall]"*)
        _ms=$(printf '%s' "$line" | sed -n 's/.*blocked ~\([0-9]*\)ms.*/\1/p')
        if [ -n "$_ms" ] && [ "$_ms" -lt 2000 ]; then
          _snow=$(date +%s)
          # Reset the window first, so a new window always starts from a clean count.
          [ $(( _snow - ${_swin:-0} )) -gt 300 ] && { _swin=$_snow; _scnt=0; _sfired=0; }
          _scnt=$(( ${_scnt:-0} + 1 ))
          # Page ONCE per window when the burst threshold is crossed. Without the
          # _sfired latch every later stall in the same window also pages, which turns
          # one burst into a flood — observed 2026-09-11 immediately after shipping the
          # threshold: the 6th stall correctly alerted, then the 7th did too.
          if [ "$_scnt" -lt 5 ] || [ "${_sfired:-0}" = "1" ]; then continue; fi
          _sfired=1
          line="$line  [burst: ${_scnt} sub-2s stalls in 5min — sustained CPU pressure]"
        fi
        ;;
      *"CLIENT closed before response completed"*)
        _now=$(date +%s)
        _cnt=$(( ${_cnt:-0} + 1 ))
        [ $(( _now - ${_win:-0} )) -gt 60 ] && { _win=$_now; _cnt=1; }
        [ "$_cnt" -lt 3 ] && continue
        ;;
    esac
    echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) | ${line:0:200}"
  done
