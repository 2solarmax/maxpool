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
cd "$(dirname "$0")/.."

# Fast, in-process tests (everything except the subprocess-spawning reload files).
fast=()
for f in test/*.test.js; do
  case "$f" in
    *reload-*) ;;            # handled per-file below
    *) fast+=("$f") ;;
  esac
done
echo "== fast tests (${#fast[@]} files, concurrent) =="
node --test "${fast[@]}"

# Subprocess-heavy reload tests: one fresh node process per file.
for f in test/reload-*.test.js; do
  echo "== $f (isolated process) =="
  node --test "$f"
done

echo "== all suites passed =="
