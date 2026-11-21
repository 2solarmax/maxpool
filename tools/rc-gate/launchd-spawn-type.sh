#!/bin/bash
# Sourced by install-launchagent.sh (and by test/rc-gate-install.test.js with canned text).
# `launchctl print gui/<uid>/<label>` reports a job's ProcessType as
#   spawn type = <daemon|interactive|background> (N)
# (macOS prints "daemon (3)" for a job with no ProcessType, "interactive (4)" for Interactive).
# Reads `launchctl print` text on stdin; prints the lowercase word, or nothing if absent.
rc_gate_spawn_type() {
  sed -n 's/^[[:space:]]*spawn type = \([A-Za-z]*\).*/\1/p' | head -n 1 | tr '[:upper:]' '[:lower:]'
}
