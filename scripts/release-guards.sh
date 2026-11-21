#!/usr/bin/env bash
# release-guards.sh — sourced by scripts/release.sh (and its bash test).
# Guards that replace "trust this Mac's working copy and test run":
#   release_github_repo_from_url         derive owner/repo from a git remote URL
#   release_require_synced_with_remote   HEAD must EQUAL remote main (a commit already pushed to main)
#   release_require_ci_green             GitHub CI must have passed for this exact SHA, on main
#   release_gh / release_gh_watch        gh under a ceiling (60s per call / 1800s for the publish watch)
#   release_package_version              the version `npm version` just wrote, read from package.json
#   release_new_tags_since / release_recovery_*   precise undo hints for a failed bump / push
# Why "equal", not "equal or ahead": ci.yml runs only on pushes to main and v* tags, so a
# HEAD that is not already on remote main can never have a CI run that counts; accepting it
# would just wait out the whole CI ceiling and refuse. Refuse at once with the real reason.
# Each guard prints a clear error to stderr and returns non-zero; release.sh runs under
# `set -e`, so a failing guard aborts before any version bump, tag or push.
# Note: a manual tag push or a publish.yml workflow_dispatch skips all of this, as it always did.

# release_github_repo_from_url URL  -> prints "owner/repo" (no .git); rc 1 when unparseable.
# Handles https://github.com/o/r(.git), git@github.com:o/r(.git), ssh://git@github.com/o/r(.git).
# GitHub-hosted only: the repo feeds `gh` calls (and OIDC publish), so a URL pointing at
# another host (gitlab.com, a LAN mirror) parses but is refused — MAXPOOL_GH_REPO may not
# override it into a different repository.
release_github_repo_from_url() {
  local url="${1%/}" owner repo
  local re='^(https?://|ssh://|git://)?([^@/]+@)?([^/:]+)[:/]+([^/]+)/([^/]+)$'
  [[ "$url" =~ $re ]] || return 1
  local host
  host="$(printf '%s' "${BASH_REMATCH[3]}" | tr 'A-Z' 'a-z')"   # no ${,,}: stock macOS bash is 3.2
  [[ "$host" == "github.com" ]] || return 1
  owner="${BASH_REMATCH[4]}"
  repo="${BASH_REMATCH[5]%.git}"
  [[ -n "$owner" && -n "$repo" ]] || return 1
  printf '%s/%s\n' "$owner" "$repo"
}

# release_require_on_base_branch [BASE_BRANCH]
# The checked-out branch must BE the base branch. A local branch pinned at main's tip
# passes the sync guard, `npm version` bumps on it, and the atomic push would send that
# branch + its v* tag — publish.yml then publishes from the tag, putting on npm a
# version that is not on main and wedging main's next release on the existing tag.
# A detached HEAD has no branch to push; refuse it too.
release_require_on_base_branch() {
  local base="${1:-main}" ref branch
  # symbolic-ref, not `rev-parse --abbrev-ref`: the latter prints "heads/main" when a tag
  # named like the branch exists, which would wrongly refuse a correct checkout.
  ref="$(git symbolic-ref -q HEAD || true)"
  if [[ -z "$ref" ]]; then
    echo "✗ Detached HEAD — release needs a checked-out '$base' branch to bump and push. Run: git checkout $base. Release refused." >&2
    return 1
  fi
  if [[ "$ref" != "refs/heads/$base" ]]; then
    branch="${ref#refs/heads/}"
    echo "✗ On branch '$branch', not '$base'. A bump here would publish a version that is not on $base. Run: git checkout $base. Release refused." >&2
    return 1
  fi
  return 0
}

# release_require_synced_with_remote REMOTE [BASE_BRANCH]
release_require_synced_with_remote() {
  local remote="$1" base="${2:-main}" head remote_sha fetch_ok=0
  local fetch_timeout="${RELEASE_FETCH_TIMEOUT:-60}"
  # Explicit destination refspec: a plain `git fetch REMOTE BASE` only writes FETCH_HEAD when
  # the remote's configured fetch refspec does not cover BASE (single-branch clone, custom
  # refspec), and we would then compare against a stale remote-tracking ref — the exact
  # staleness this guard exists to catch. `--` ends the option list so a remote or branch
  # name can never be read as a flag (so `--` goes BEFORE the remote, not between it and the refspec).
  local refspec="+refs/heads/$base:refs/remotes/$remote/$base"
  # A stalled network must fail loudly, not hang (timeout is absent on stock macOS; then
  # the plain fetch runs and release.sh's own stage watchdog is the only bound).
  if command -v timeout >/dev/null 2>&1; then
    if timeout "$fetch_timeout" git fetch -q -- "$remote" "$refspec" >/dev/null 2>&1; then fetch_ok=1; fi
  else
    if git fetch -q -- "$remote" "$refspec" >/dev/null 2>&1; then fetch_ok=1; fi
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
# broken gh stops with its real cause instead of looking like "no CI run yet". Prefers
# `--active` so a stale SECOND logged-in account failing its auth check cannot block the
# release; only the active account's health matters. A gh too old for `--active` falls
# back to the plain check. gh's own message is shown on failure.
release_require_gh_ready() {
  local out
  if ! command -v timeout >/dev/null 2>&1; then
    echo "    (no 'timeout' on this machine — gh calls are unbounded; install coreutils for per-call ceilings)" >&2
  fi
  if ! command -v gh >/dev/null 2>&1; then
    echo "✗ GitHub CLI 'gh' not found — releases now require it to check CI. Install it (https://cli.github.com). Release refused." >&2
    return 1
  fi
  if out="$(gh auth status --active 2>&1)"; then
    return 0
  fi
  if printf '%s' "$out" | grep -qi 'unknown flag'; then
    if out="$(gh auth status 2>&1)"; then
      return 0
    fi
  fi
  echo "✗ 'gh auth status' failed (not logged in, or GitHub unreachable) — cannot check CI. Run: gh auth login. Release refused. gh said:" >&2
  printf '%s\n' "$out" | sed 's/^/    /' >&2
  return 1
}

# release_gh_ceiling SECONDS ARG... — run gh under `timeout SECONDS` when it exists (macOS
# lacks it stock; there the release.sh stage watchdog is the only bound and we said so once
# above in release_require_gh_ready).
release_gh_ceiling() {
  local ceiling="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$ceiling" gh "$@"
  else
    gh "$@"
  fi
}

# release_gh ARG... — a short gh call (list/view): RELEASE_GH_TIMEOUT, default 60s.
release_gh() { release_gh_ceiling "${RELEASE_GH_TIMEOUT:-60}" "$@"; }

# release_gh_watch ARG... — `gh run watch` of the Publish workflow, which legitimately runs
# for minutes (checkout, npm publish, GitHub release) and would die at the 60s call ceiling
# AFTER the tag was pushed. Own ceiling: RELEASE_WATCH_TIMEOUT, default 1800s.
release_gh_watch() { release_gh_ceiling "${RELEASE_WATCH_TIMEOUT:-1800}" "$@"; }

# release_require_ci_green GH_REPO SHA [BASE_BRANCH=main]
# Waits (bounded) for the CI workflow (ci.yml) push run for SHA ON BASE_BRANCH to complete
# (the run's headBranch must equal the base: a side branch pinned at main's tip shares the
# SHA but is not main), then requires the run, the `ci-gate` job and every matrix `test`
# job to be success.
# Env: RELEASE_CI_CEILING (seconds, default 1800), RELEASE_CI_POLL (default 15).
# A non-zero exit from gh itself is an immediate refusal (never "no run yet").
release_require_ci_green() {
  local repo="$1" sha="$2" base="${3:-main}"
  local ceiling="${RELEASE_CI_CEILING:-1800}" poll="${RELEASE_CI_POLL:-15}"
  local start=$SECONDS line run_id status conclusion job_rows gate_ok test_n test_bad
  if [[ ! "$base" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "✗ Unsafe base branch name '$base'. Release refused." >&2
    return 1
  fi
  # The base is interpolated into the jq program (gh -q takes no variables); the check
  # above restricts it to characters that cannot close the string literal.
  local q='[.[] | select(.event=="push" and .headBranch=="'"$base"'")][0] | select(. != null) | "\(.databaseId) \(.status) \(.conclusion)"'
  release_require_gh_ready || return 1
  echo "==> Checking GitHub CI for ${sha:0:9} (ceiling ${ceiling}s)"
  while true; do
    if ! line="$(release_gh run list --repo "$repo" --workflow ci.yml --commit "$sha" -L 10 \
      --json databaseId,status,conclusion,event,headBranch -q "$q")"; then
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
        if ! job_rows="$(release_gh run view "$run_id" --repo "$repo" --json jobs \
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
      echo "    No CI push run on $base for ${sha:0:9} yet (is it pushed to the remote?); waiting..."
    fi
    if (( SECONDS - start >= ceiling )); then
      echo "✗ No finished CI result on $base for ${sha:0:9} within ${ceiling}s (RELEASE_CI_CEILING). Release refused; push the commit and let CI finish." >&2
      return 1
    fi
    sleep "$poll"
  done
}

# release_package_version [FILE=package.json] -> prints the version in package.json.
# Read AFTER `npm version`, never captured from its stdout: the `version` lifecycle hook
# (update-changelog.sh) writes to the same stdout, which polluted the captured value.
# Uses node (always present where `npm version` runs); rc 1 unless a semver comes back.
release_package_version() {
  local file="${1:-package.json}" ver
  ver="$(RELEASE_PKG_FILE="$file" node -p 'JSON.parse(require("fs").readFileSync(process.env.RELEASE_PKG_FILE,"utf8")).version')" || return 1
  local re='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$'
  [[ "$ver" =~ $re ]] || return 1
  printf '%s\n' "$ver"
}

# release_new_tags_since SNAPSHOT -> prints the local v* tags that exist now but were not in
# SNAPSHOT (the newline-separated `git tag -l 'v*'` taken before the bump) — i.e. only the
# tags THIS attempt created. Never "all unmerged tags": a clone commonly carries dozens.
release_new_tags_since() {
  comm -13 <(printf '%s\n' "$1" | sort) <(git tag -l 'v*' | sort) | grep -v '^$' || true
}

# release_recovery_bump OLD_SHA TAGS_BEFORE — undo hints for a failed/frozen version bump.
release_recovery_bump() {
  local old="$1" new
  new="$(release_new_tags_since "$2" | while IFS= read -r t; do printf '%q ' "$t"; done)"
  if [[ -n "$new" ]]; then
    echo "git tag -d ${new% } && git reset --hard $old"
  else
    echo "git reset --hard $old   (no new tag was created by this attempt)"
  fi
}

# release_recovery_push REMOTE VERSION BASE — hint for a failed/killed push. A killed
# `git push` may already have landed: the tag then publishes on its own and must NOT be undone.
release_recovery_push() {
  local remote="$1" ver="${2#v}" base="$3"
  echo "FIRST check whether the push landed anyway:  git ls-remote --tags $remote v$ver"
  echo "    - if it prints a ref, the tag is on $remote and publishing: the release HAPPENED — do NOT undo anything (watch: gh run list --workflow publish.yml)."
  echo "    - if it fails (network error), you cannot tell yet: retry the check before touching anything."
  echo "    - only if it exits 0 and prints nothing: git tag -d v$ver && git reset --hard $remote/$base"
}
