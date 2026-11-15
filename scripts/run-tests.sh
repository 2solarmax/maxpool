#!/usr/bin/env bash
#
# run-tests.sh — the full maxpool test suite, contention-safe.
#
# The fast in-process tests run concurrently. The reload INTEGRATION tests each
# spawn detached supervisor+worker subprocesses and cycle many ephemeral ports;
# running them all in ONE `node --test` process accumulates OS resource pressure
# (ports stuck in TIME_WAIT, file descriptors) that wedges later tests. So each
# subprocess-heavy reload file runs in its OWN node process — process exit frees
# those resources between files.
set -euo pipefail
shopt -s nullglob
cd "$(dirname "$0")/.."

# Tests spawn real supervisor+worker subprocesses; on macOS the sleep-guard would
# spawn `caffeinate` children (harmless — they die with their worker via -w — but
# noisy and would keep the dev box awake during the run). Disable it for the suite.
# Suite-wide isolation pin (red-team 2026-10-31): per-file opt-in let any NEW test
# that touches a disk-persisting path resolve the REAL ~/.config config and mutate
# the live pool (the 3f927d7 incident). Tests needing a specific config still
# override per-file/per-child — those wins over the ambient default.
_MAXPOOL_TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/maxpool-tests.XXXXXX")"
export MAXPOOL_CONFIG="$_MAXPOOL_TEST_DIR/config.json"
export MAXPOOL_DISABLE_SLEEP_GUARD=1
# Quota probing is on by default in real installs, but a startup probe would fire a
# token refresh / hit stubs and race the reload+refresh rotation-count assertions.
# Disable it fleet-wide for spawned servers; quota-probe.test.js drives Prober directly.
export MAXPOOL_DISABLE_QUOTA_PROBE=1
# The rc-gate tests speak TLS to a locally-minted api.anthropic.com cert, so Node must
# trust the mkcert root — it is read at process START, so a test cannot set it itself.
# Without it those 12 tests fail here while passing when run by hand, which is exactly
# how they were added on 2026-09-08. Absent mkcert, leave it unset and let them report.
_mkcert_root="$HOME/Library/Application Support/mkcert/rootCA.pem"
if [ -f "$_mkcert_root" ]; then export NODE_EXTRA_CA_CERTS="$_mkcert_root"; fi

# Fast, in-process tests (everything except the subprocess-spawning reload files).
fast=()
for f in test/*.test.js test/*.test.mjs; do
  case "$f" in
    *reload-*) ;;            # handled per-file below
    *) fast+=("$f") ;;
  esac
done
# Concurrency scales DOWN with machine load (2026-11-06): the v1.24.68 release failed
# 5x on a different network-timing test each time with the Mac at load 35-95 (calls +
# many sessions) — 16 concurrent files starved the timing tests; never a code failure.
# MAXPOOL_TEST_CONCURRENCY overrides.
_cpus=$(sysctl -n hw.ncpu 2>/dev/null || nproc 2>/dev/null || echo 4)
_load=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print int($2)}' || awk '{print int($1)}' /proc/loadavg 2>/dev/null || echo 0)
_conc="${MAXPOOL_TEST_CONCURRENCY:-}"
if [ -z "$_conc" ]; then
  _conc=$(( _cpus - _load / 4 )); [ "$_conc" -lt 2 ] && _conc=2; [ "$_conc" -gt "$_cpus" ] && _conc=$_cpus
fi
echo "== fast tests (${#fast[@]} files, concurrency $_conc; load $_load on $_cpus cpus) =="
# One retry of the FAILED files only: a timing flake under load passes on re-run, a real
# defect fails twice. Both attempts print, and a file that fails twice fails the suite.
_fast_log="$(mktemp "${TMPDIR:-/tmp}/maxpool-fast.XXXXXX")"
if node --test --test-concurrency="$_conc" "${fast[@]}" 2>&1 | tee "$_fast_log"; then :; else
  _failed=$(grep -E '^not ok [0-9]+ - ' "$_fast_log" >/dev/null && grep -oE "location: '[^:']+" "$_fast_log" | sed "s/location: '//" | sed "s|^$(pwd)/||" | sort -u)
  if [ -z "$_failed" ]; then echo "== fast tests failed with no attributable file — not retrying ==" >&2; exit 1; fi
  echo "== retrying failed file(s) once, serially: $(echo $_failed | tr '\n' ' ') =="
  node --test --test-concurrency=1 $_failed || { echo "== failed twice — real failure ==" >&2; exit 1; }
  echo "== retry passed (timing flake under load) =="
fi
rm -f "$_fast_log"

# Subprocess-heavy reload tests: one fresh node process per file, with the same
# one-retry policy as the fast tests above. These are the most timing-sensitive files
# (real child processes, ptys, cutover deadlines); on 2026-11-14 three releases at load
# 100-300 each failed on a different one, every one passing when re-run alone.
for f in test/reload-*.test.js; do
  echo "== $f (isolated process) =="
  if node --test "$f"; then :; else
    echo "== retrying $f once =="
    node --test "$f" || { echo "== $f failed twice — real failure ==" >&2; exit 1; }
    echo "== retry passed (timing flake under load) =="
  fi
done

echo "== all suites passed =="
