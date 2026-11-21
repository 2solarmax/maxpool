#!/usr/bin/env bash
# release-guards.sh — sourced by scripts/release.sh (and its bash test).
# Guards that replace "trust this Mac's working copy and test run":
#   release_github_repo_from_url         derive owner/repo from a git remote URL
#   release_require_synced_with_remote   HEAD must EQUAL remote main (a commit already pushed to main)
#   release_require_ci_green             GitHub CI must have passed for this exact SHA
# Why "equal", not "equal or ahead": ci.yml runs only on pushes to main and v* tags, so a
# HEAD that is not already on remote main can never have a CI run that counts; accepting it
# would just wait out the whole CI ceiling and refuse. Refuse at once with the real reason.
# Each guard prints a clear error to stderr and returns non-zero; release.sh runs under
# `set -e`, so a failing guard aborts before any version bump, tag or push.
# Note: a manual tag push or a publish.yml workflow_dispatch skips all of this, as it always did.

# release_github_repo_from_url URL  -> prints "owner/repo" (no .git); rc 1 when unparseable.
# Handles https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r(.git).
release_github_repo_from_url() {
  local url="${1%/}" owner repo
  local re='^(https?://|ssh://|git://)?([^@/]+@)?[^/:]+[:/]+([^/]+)/([^/]+)$'
  [[ "$url" =~ $re ]] || return 1
  owner="${BASH_REMATCH[3]}"
  repo="${BASH_REMATCH[4]%.git}"
  [[ -n "$owner" && -n "$repo" ]] || return 1
  printf '%s/%s\n' "$owner" "$repo"
}

# release_require_synced_with_remote REMOTE [BASE_BRANCH]
release_require_synced_with_remote() {
  local remote="$1" base="${2:-main}" head remote_sha fetch_ok=0
  local fetch_timeout="${RELEASE_FETCH_TIMEOUT:-60}"
  # Explicit destination refspec: a plain `git fetch REMOTE BASE` only writes FETCH_HEAD when
  # the remote's configured fetch refspec does not cover BASE (single-branch clone, custom
  # refspec), and we would then compare against a stale remote-tracking ref — the exact
  # staleness this guard exists to catch.
  local refspec="+refs/heads/$base:refs/remotes/$remote/$base"
  # A stalled network must fail loudly, not hang (timeout is absent on stock macOS; then
  # the plain fetch runs and release.sh's own stage watchdog is the only bound).
  if command -v timeout >/dev/null 2>&1; then
    if timeout "$fetch_timeout" git fetch -q "$remote" "$refspec" >/dev/null 2>&1; then fetch_ok=1; fi
  else
    if git fetch -q "$remote" "$refspec" >/dev/null 2>&1; then fetch_ok=1; fi
  fi
  if [[ "$fetch_ok" -ne 1 ]]; then
    echo "✗ Could not fetch $remote/$base (failed or exceeded ${fetch_timeout}s) — cannot prove this copy is current. Release refused." >&2
    return 1
  fi
  head="$(git rev-parse HEAD)"
  remote_sha="$(git rev-parse "refs/remotes/$remote/$base" 2>/dev/null || true)"
  if [[ -z "$remote_sha" ]]; then
    echo "✗ $remote/$base not found after fetch. Release refused." >&2
    return 1
  fi
  if [[ "$head" == "$remote_sha" ]]; then
    return 0
  fi
  if git merge-base --is-ancestor "$remote_sha" "$head"; then
    echo "✗ Local HEAD ${head:0:9} is AHEAD of $remote/$base ${remote_sha:0:9}. CI only runs for commits pushed to $base, so this commit has no CI result that counts. Merge/push it to $base and let CI pass first. Release refused." >&2
  elif git merge-base --is-ancestor "$head" "$remote_sha"; then
    echo "✗ Local HEAD ${head:0:9} is BEHIND $remote/$base ${remote_sha:0:9}. Pull first; a stale copy would publish without the newest merged work." >&2
  else
    echo "✗ Local HEAD ${head:0:9} has DIVERGED from $remote/$base ${remote_sha:0:9}. Rebase onto it first." >&2
  fi
  return 1
}

# release_require_gh_ready — gh must exist and be logged in, checked ONCE up front so a
# broken gh stops with its real cause instead of looking like "no CI run yet".
release_require_gh_ready() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "✗ GitHub CLI 'gh' not found — releases now require it to check CI. Install it (https://cli.github.com). Release refused." >&2
    return 1
  fi
  if ! gh auth status >/dev/null 2>&1; then
    echo "✗ 'gh auth status' failed (not logged in, or GitHub unreachable) — cannot check CI. Run: gh auth login. Release refused." >&2
    return 1
  fi
}

# release_require_ci_green GH_REPO SHA
# Waits (bounded) for the CI workflow (ci.yml) push run for SHA to complete, then
# requires the run, the `ci-gate` job and every matrix `test` job to be success.
# Env: RELEASE_CI_CEILING (seconds, default 1800), RELEASE_CI_POLL (default 15).
# A non-zero exit from gh itself is an immediate refusal (never "no run yet").
release_require_ci_green() {
  local repo="$1" sha="$2"
  local ceiling="${RELEASE_CI_CEILING:-1800}" poll="${RELEASE_CI_POLL:-15}"
  local start=$SECONDS line run_id status conclusion job_rows gate_ok test_n test_bad
  release_require_gh_ready || return 1
  echo "==> Checking GitHub CI for ${sha:0:9} (ceiling ${ceiling}s)"
  while true; do
    if ! line="$(gh run list --repo "$repo" --workflow ci.yml --commit "$sha" -L 10 \
      --json databaseId,status,conclusion,event \
      -q '[.[] | select(.event=="push")][0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"')"; then
      echo "✗ 'gh run list' failed (gh's message is above) — cannot determine CI state for ${sha:0:9}. Release refused." >&2
      return 1
    fi
    if [[ -n "$line" ]]; then
      read -r run_id status conclusion <<<"$line"
      if [[ "$status" == "completed" ]]; then
        if [[ "$conclusion" != "success" ]]; then
          echo "✗ CI run $run_id for ${sha:0:9} concluded '$conclusion'. Release refused. See: gh run view $run_id --repo $repo --log-failed" >&2
          return 1
        fi
        if ! job_rows="$(gh run view "$run_id" --repo "$repo" --json jobs \
          -q '.jobs[] | "\(.name)\t\(.conclusion)"')"; then
          echo "✗ 'gh run view $run_id' failed (gh's message is above) — cannot read CI jobs. Release refused." >&2
          return 1
        fi
        gate_ok="$(awk -F'\t' '$1=="ci-gate" && $2=="success"{n++} END{print n+0}' <<<"$job_rows")"
        test_n="$(awk -F'\t' '$1 ~ /^test( \(|$)/{n++} END{print n+0}' <<<"$job_rows")"
        test_bad="$(awk -F'\t' '$1 ~ /^test( \(|$)/ && $2!="success"{n++} END{print n+0}' <<<"$job_rows")"
        if [[ "$gate_ok" -ge 1 && "$test_n" -ge 1 && "$test_bad" -eq 0 ]]; then
          echo "    CI green for ${sha:0:9}: run $run_id, ci-gate ok, $test_n test job(s) ok."
          return 0
        fi
        echo "✗ CI run $run_id succeeded overall but ci-gate/test jobs are not all green (ci-gate ok=$gate_ok, test jobs=$test_n, not-success=$test_bad). Release refused." >&2
        return 1
      fi
      echo "    CI run $run_id is $status; waiting..."
    else
      echo "    No CI push run for ${sha:0:9} yet (is it pushed to the remote?); waiting..."
    fi
    if (( SECONDS - start >= ceiling )); then
      echo "✗ No finished CI result for ${sha:0:9} within ${ceiling}s (RELEASE_CI_CEILING). Release refused; push the commit and let CI finish." >&2
      return 1
    fi
    sleep "$poll"
  done
}
