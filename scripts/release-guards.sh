#!/usr/bin/env bash
# release-guards.sh — sourced by scripts/release.sh (and its bash test).
# Two guards that replace "trust this Mac's working copy and test run":
#   release_require_synced_with_remote   HEAD must equal or fast-forward remote main
#   release_require_ci_green             GitHub CI must have passed for this exact SHA
# Both print a clear error to stderr and return non-zero; release.sh runs under
# `set -e`, so a failing guard aborts before any version bump, tag or push.

# release_require_synced_with_remote REMOTE [BASE_BRANCH]
release_require_synced_with_remote() {
  local remote="$1" base="${2:-main}" head remote_sha
  if ! git fetch "$remote" "$base" >/dev/null 2>&1; then
    echo "✗ Could not fetch $remote/$base — cannot prove this copy is current. Release refused." >&2
    return 1
  fi
  head="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "refs/remotes/$remote/$base" 2>/dev/null || true)"
  if [[ -z "$remote_sha" ]]; then
    echo "✗ $remote/$base not found after fetch. Release refused." >&2
    return 1
  fi
  if [[ "$head" == "$remote_sha" ]] || git merge-base --is-ancestor "$remote_sha" "$head"; then
    return 0
  fi
  if git merge-base --is-ancestor "$head" "$remote_sha"; then
    echo "✗ Local HEAD ${head:0:9} is BEHIND $remote/$base ${remote_sha:0:9}. Pull first; a stale copy would publish without the newest merged work." >&2
  else
    echo "✗ Local HEAD ${head:0:9} has DIVERGED from $remote/$base ${remote_sha:0:9}. Rebase onto it first." >&2
  fi
  return 1
}

# release_require_ci_green GH_REPO SHA
# Waits (bounded) for the CI workflow (ci.yml) run for SHA to complete, then
# requires the run, the `ci-gate` job and every `test*` job to be success.
# Env: RELEASE_CI_CEILING (seconds, default 1800), RELEASE_CI_POLL (default 15).
release_require_ci_green() {
  local repo="$1" sha="$2"
  local ceiling="${RELEASE_CI_CEILING:-1800}" poll="${RELEASE_CI_POLL:-15}"
  local start=$SECONDS line run_id status conclusion jobs gate_ok test_n test_bad
  echo "==> Checking GitHub CI for ${sha:0:9} (ceiling ${ceiling}s)"
  while true; do
    line="$(gh run list --repo "$repo" --workflow ci.yml --commit "$sha" -L 10 \
      --json databaseId,status,conclusion,event \
      -q '[.[] | select(.event=="push")][0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"' 2>/dev/null || true)"
    if [[ -n "$line" ]]; then
      read -r run_id status conclusion <<<"$line"
      if [[ "$status" == "completed" ]]; then
        if [[ "$conclusion" != "success" ]]; then
          echo "✗ CI run $run_id for ${sha:0:9} concluded '$conclusion'. Release refused. See: gh run view $run_id --repo $repo --log-failed" >&2
          return 1
        fi
        jobs="$(gh run view "$run_id" --repo "$repo" --json jobs \
          -q '.jobs[] | "\(.name)\t\(.conclusion)"' 2>/dev/null || true)"
        gate_ok="$(awk -F'\t' '$1=="ci-gate" && $2=="success"{n++} END{print n+0}' <<<"$jobs")"
        test_n="$(awk -F'\t' '$1 ~ /^test/{n++} END{print n+0}' <<<"$jobs")"
        test_bad="$(awk -F'\t' '$1 ~ /^test/ && $2!="success"{n++} END{print n+0}' <<<"$jobs")"
        if [[ "$gate_ok" -ge 1 && "$test_n" -ge 1 && "$test_bad" -eq 0 ]]; then
          echo "    CI green for ${sha:0:9}: run $run_id, ci-gate ok, $test_n test job(s) ok."
          return 0
        fi
        echo "✗ CI run $run_id succeeded overall but ci-gate/test jobs are not all green (ci-gate ok=$gate_ok, test jobs=$test_n, not-success=$test_bad). Release refused." >&2
        return 1
      fi
      echo "    CI run $run_id is $status; waiting..."
    else
      echo "    No CI run for ${sha:0:9} yet (is it pushed to the remote?); waiting..."
    fi
    if (( SECONDS - start >= ceiling )); then
      echo "✗ No finished CI result for ${sha:0:9} within ${ceiling}s (RELEASE_CI_CEILING). Release refused; push the commit and let CI finish." >&2
      return 1
    fi
    sleep "$poll"
  done
}
