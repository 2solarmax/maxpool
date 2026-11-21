#!/usr/bin/env bash
# Bash test for scripts/release-guards.sh. Stubs `gh` and `sleep` on PATH; the `gh`
# stub emits RAW --json fixtures and runs the REAL jq with the `-q` program the guard
# passes, so the push-event / newest-run / job-row filters are exercised for real
# (needs `jq`, present on GitHub runners). The sync guard uses real throwaway git
# repos in a temp dir (no network).
# Run: bash scripts/tests/release-guards.test.sh   (exit 0 = all pass)
# CI: .github/workflows/ci.yml runs it in the `test` job.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../release-guards.sh"

command -v jq >/dev/null 2>&1 || { echo "FAIL - jq is required by this test" >&2; exit 1; }

T="$(mktemp -d "${TMPDIR:-/tmp}/release-guards-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
expect_rc() {  # name expected_rc actual_rc
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want rc=$2 got rc=$3)"; fi
}
expect_eq() {  # name expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$2' got '$3')"; fi
}

# ── stubs ──────────────────────────────────────────────────────────────────────
mkdir -p "$T/bin" "$T/fx" "$T/empty"
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
# gh auth status   -> rc 1 when $GH_AUTH_FAIL is set (mirrors real gh: exits 1 when the
#                     checked account has auth issues)
# gh run list ...  -> Nth call prints the Nth file of $GH_LIST_FILES (last one repeats),
#                     filtered through real jq with the guard's own -q program
# gh run view ...  -> prints $GH_VIEW_FILE filtered the same way
# $GH_LIST_FAIL / $GH_VIEW_FAIL make that call exit 1 with a message on stderr.
echo "gh $*" >>"$GH_CALLS"
q=""; prev=""
for a in "$@"; do [[ "$prev" == "-q" ]] && q="$a"; prev="$a"; done
case "$1 $2" in
  "auth status")
    if [[ -n "${GH_AUTH_FAIL:-}" ]]; then echo "You are not logged into any GitHub hosts" >&2; exit 1; fi
    exit 0 ;;
  "run list")
    if [[ -n "${GH_LIST_FAIL:-}" ]]; then echo "gh: HTTP 403 rate limit exceeded" >&2; exit 1; fi
    n="$(cat "$GH_COUNTER" 2>/dev/null || echo 0)"; n=$((n+1)); echo "$n" >"$GH_COUNTER"
    read -ra files <<<"$GH_LIST_FILES"
    idx=$((n-1)); (( idx >= ${#files[@]} )) && idx=$((${#files[@]}-1))
    jq -r "$q" "${files[$idx]}"
    exit $? ;;
  "run view")
    if [[ -n "${GH_VIEW_FAIL:-}" ]]; then echo "gh: HTTP 502" >&2; exit 1; fi
    jq -r "$q" "$GH_VIEW_FILE"
    exit $? ;;
esac
exit 1
STUB
cat >"$T/bin/sleep" <<'STUB'
#!/usr/bin/env bash
echo "sleep $*" >>"$GH_CALLS"
exit 0
STUB
chmod +x "$T/bin/gh" "$T/bin/sleep"
export GH_CALLS="$T/calls.log" GH_COUNTER="$T/counter"
PATH="$T/bin:$PATH"

# ── fixtures: raw `gh ... --json` shapes ───────────────────────────────────────
FX="$T/fx"
echo '[]' >"$FX/none.json"
echo '[{"databaseId":4242,"status":"completed","conclusion":"success","event":"push"}]' >"$FX/ok.json"
echo '[{"databaseId":4242,"status":"completed","conclusion":"failure","event":"push"}]' >"$FX/fail.json"
echo '[{"databaseId":4242,"status":"in_progress","conclusion":"","event":"push"}]' >"$FX/inprog.json"
echo '[{"databaseId":4242,"status":"queued","conclusion":"","event":"push"}]' >"$FX/queued.json"
# Only a pull_request run, even a green one, must never count.
echo '[{"databaseId":777,"status":"completed","conclusion":"success","event":"pull_request"}]' >"$FX/pr-only.json"
# Newest-first: a green pull_request run on top of a FAILED push run -> the push run decides.
echo '[{"databaseId":777,"status":"completed","conclusion":"success","event":"pull_request"},{"databaseId":4242,"status":"completed","conclusion":"failure","event":"push"}]' >"$FX/pr-over-push-fail.json"
# Two push runs (a re-run): the newest (first) one decides.
echo '[{"databaseId":9000,"status":"completed","conclusion":"success","event":"push"},{"databaseId":4242,"status":"completed","conclusion":"failure","event":"push"}]' >"$FX/push-newest-ok.json"

jobs_json() {  # jobs_json name:conclusion ... -> raw `gh run view --json jobs` shape
  local out='{"jobs":[' first=1 kv
  for kv in "$@"; do
    [[ "$first" -eq 1 ]] || out+=','
    first=0
    out+="{\"name\":\"${kv%%:*}\",\"conclusion\":\"${kv#*:}\"}"
  done
  printf '%s]}\n' "$out"
}
jobs_json "test (18):success" "test (20):success" "test (22):success" "ci-gate:success" >"$FX/jobs-green.json"
jobs_json "test (18):success" "test (20):failure" "ci-gate:success" >"$FX/jobs-test-fail.json"
jobs_json "test (18):success" "ci-gate:skipped" >"$FX/jobs-gate-skipped.json"
jobs_json "ci-gate:success" >"$FX/jobs-no-test.json"
# A job merely PREFIXED "test" (not the matrix `test` job) is not required.
jobs_json "test (18):success" "testbed:failure" "test-docs:cancelled" "ci-gate:success" >"$FX/jobs-prefix-only.json"
jobs_json "test:success" "ci-gate:success" >"$FX/jobs-bare-test.json"

# ── CI guard ───────────────────────────────────────────────────────────────────
SHA=0123456789abcdef0123456789abcdef01234567

run_ci() {  # run_ci "<list fixtures, space separated>" <jobs fixture> [ceiling] ; prints rc
  : >"$GH_CALLS"; rm -f "$GH_COUNTER"
  ( export GH_LIST_FILES="$1" GH_VIEW_FILE="$2"; RELEASE_CI_CEILING="${3:-0}" RELEASE_CI_POLL=1 \
    release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err"
  echo $?
}
count_calls() { grep -c -- "$1" "$GH_CALLS" || true; }

rc="$(run_ci "$FX/ok.json" "$FX/jobs-green.json")"
expect_rc "ci success for exact SHA passes" 0 "$rc"
grep -q -- "--commit $SHA" "$GH_CALLS" && ok "gh queried with --commit <exact sha>" || bad "gh not queried with --commit sha"

rc="$(run_ci "$FX/fail.json" "$FX/jobs-green.json")"
expect_rc "ci run concluded failure is refused" 1 "$rc"
grep -q "concluded 'failure'" "$T/err" && ok "failure message is clear" || bad "failure message missing"

rc="$(run_ci "$FX/none.json" "$FX/jobs-green.json")"
expect_rc "no CI run for SHA is refused after ceiling" 1 "$rc"
grep -q "within 0s" "$T/err" && ok "missing-run message names the ceiling" || bad "missing-run message missing"

rc="$(run_ci "$FX/inprog.json" "$FX/jobs-green.json")"
expect_rc "still-running CI at ceiling is refused" 1 "$rc"

# push-event / newest-run selection through the REAL jq filters
rc="$(run_ci "$FX/pr-only.json" "$FX/jobs-green.json")"
expect_rc "a pull_request-only run is NOT accepted as CI proof" 1 "$rc"
grep -q "No CI push run" "$T/out" && ok "pull_request-only is reported as no push run" || bad "pull_request-only not reported as no push run"

rc="$(run_ci "$FX/pr-over-push-fail.json" "$FX/jobs-green.json")"
expect_rc "green pull_request run does not mask a failed push run" 1 "$rc"
grep -q "run 4242\|CI run 4242" "$T/err" && ok "the push run (4242) was the one judged" || bad "push run was not the one judged"

rc="$(run_ci "$FX/push-newest-ok.json" "$FX/jobs-green.json")"
expect_rc "newest push run decides (older failed re-run ignored)" 0 "$rc"
grep -q "run 9000" "$T/out" && ok "newest push run id (9000) selected" || bad "newest push run not selected"

# job-row filter + matching
rc="$(run_ci "$FX/ok.json" "$FX/jobs-test-fail.json")"
expect_rc "a failed test job refuses even if run says success" 1 "$rc"

rc="$(run_ci "$FX/ok.json" "$FX/jobs-gate-skipped.json")"
expect_rc "ci-gate not success is refused" 1 "$rc"

rc="$(run_ci "$FX/ok.json" "$FX/jobs-no-test.json")"
expect_rc "no test job present is refused" 1 "$rc"

rc="$(run_ci "$FX/ok.json" "$FX/jobs-prefix-only.json")"
expect_rc "jobs only PREFIXED test (testbed, test-docs) are not required" 0 "$rc"

rc="$(run_ci "$FX/ok.json" "$FX/jobs-bare-test.json")"
expect_rc "a bare 'test' job (no matrix) counts as the test job" 0 "$rc"

# poll / retry path (ceiling > 0; the sleep stub does not advance time, so only
# scenarios that END within the loop are used here)
rc="$(run_ci "$FX/queued.json $FX/inprog.json $FX/ok.json" "$FX/jobs-green.json" 100)"
expect_rc "queued, then in progress, then success passes" 0 "$rc"
expect_eq "  polled gh run list 3 times" 3 "$(count_calls 'gh run list')"
expect_eq "  slept twice between polls" 2 "$(count_calls '^sleep')"

rc="$(run_ci "$FX/none.json $FX/ok.json" "$FX/jobs-green.json" 100)"
expect_rc "no run yet, then run found, passes" 0 "$rc"
expect_eq "  polled gh run list twice" 2 "$(count_calls 'gh run list')"
expect_eq "  slept once" 1 "$(count_calls '^sleep')"

rc="$(run_ci "$FX/inprog.json $FX/fail.json" "$FX/jobs-green.json" 100)"
expect_rc "in progress, then failure, is refused" 1 "$rc"
expect_eq "  slept once before the failure showed up" 1 "$(count_calls '^sleep')"

# gh failures stop at once with the real cause (never "no run yet", never a 30-min wait)
: >"$GH_CALLS"; rm -f "$GH_COUNTER"
rc="$( ( export GH_LIST_FILES="$FX/ok.json" GH_VIEW_FILE="$FX/jobs-green.json" GH_LIST_FAIL=1; \
  RELEASE_CI_CEILING=100 RELEASE_CI_POLL=1 release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err"; echo $? )"
expect_rc "gh run list exiting non-zero refuses immediately" 1 "$rc"
grep -q "'gh run list' failed" "$T/err" && ok "  names the failing gh call" || bad "  failing gh call not named"
grep -q "rate limit" "$T/err" && ok "  gh's own message reaches the operator" || bad "  gh's own message hidden"
expect_eq "  did not sleep/poll" 0 "$(count_calls '^sleep')"

: >"$GH_CALLS"; rm -f "$GH_COUNTER"
rc="$( ( export GH_LIST_FILES="$FX/ok.json" GH_VIEW_FILE="$FX/jobs-green.json" GH_VIEW_FAIL=1; \
  RELEASE_CI_CEILING=0 RELEASE_CI_POLL=1 release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err"; echo $? )"
expect_rc "gh run view exiting non-zero refuses with its own cause" 1 "$rc"
grep -q "'gh run view" "$T/err" && ok "  names gh run view, not 'jobs not all green'" || bad "  gh run view failure misreported"

: >"$GH_CALLS"; rm -f "$GH_COUNTER"
rc="$( ( export GH_LIST_FILES="$FX/ok.json" GH_VIEW_FILE="$FX/jobs-green.json" GH_AUTH_FAIL=1; \
  RELEASE_CI_CEILING=100 RELEASE_CI_POLL=1 release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err"; echo $? )"
expect_rc "gh not logged in refuses up front" 1 "$rc"
grep -q "gh auth status" "$T/err" && ok "  names gh auth" || bad "  gh auth failure not named"
expect_eq "  never queried runs" 0 "$(count_calls 'gh run list')"
# --active: a stale SECOND logged-in account failing its auth check must not block the
# release; only the active account is checked (round-2 advisory).
grep -q -- "--active" "$GH_CALLS" && ok "  auth check uses --active (active account only)" || bad "  auth check not scoped to the active account"

rc="$( ( PATH="$T/empty"; release_require_gh_ready ) >"$T/out" 2>"$T/err"; echo $? )"
expect_rc "gh missing refuses up front" 1 "$rc"
grep -q "not found" "$T/err" && ok "  names the missing gh" || bad "  missing gh not named"

# release_gh bounds every gh call with `timeout` when available (round-2 advisory): a
# stubbed `timeout` records that gh ran THROUGH it, with the default ceiling.
cat >"$T/bin/timeout" <<'STUB'
#!/usr/bin/env bash
echo "timeout $*" >>"$GH_CALLS"
shift   # drop the duration, run the wrapped command
exec "$@"
STUB
chmod +x "$T/bin/timeout"
: >"$GH_CALLS"
( export GH_LIST_FILES="$FX/ok.json" GH_VIEW_FILE="$FX/jobs-green.json"; \
  RELEASE_CI_CEILING=0 RELEASE_CI_POLL=1 release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err" || true
expect_eq "gh run list went through timeout" 1 "$(grep -c 'timeout .* gh run list' "$GH_CALLS" || true)"
expect_eq "gh run view went through timeout" 1 "$(grep -c 'timeout .* gh run view' "$GH_CALLS" || true)"
grep -q 'timeout 60 gh run list' "$GH_CALLS" && ok "default RELEASE_GH_TIMEOUT is 60s" || bad "default gh ceiling not 60s"
RELEASE_GH_TIMEOUT=9 release_gh run list >/dev/null 2>&1 || true
grep -q 'timeout 9 ' "$GH_CALLS" && ok "RELEASE_GH_TIMEOUT overrides the ceiling" || bad "RELEASE_GH_TIMEOUT ignored"
rm -f "$T/bin/timeout"
# bash cached the stub's path when it ran; without this, every later `timeout ...` (the
# real one on CI runners, used by the sync guard's fetch) fails 127 "No such file".
hash -r

# ── repo derivation from a remote URL ──────────────────────────────────────────
expect_eq "https url -> owner/repo" "2solarmax/maxpool" "$(release_github_repo_from_url https://github.com/2solarmax/maxpool.git)"
expect_eq "https url without .git" "2solarmax/maxpool" "$(release_github_repo_from_url https://github.com/2solarmax/maxpool)"
expect_eq "scp-style ssh url" "2solarmax/maxpool" "$(release_github_repo_from_url git@github.com:2solarmax/maxpool.git)"
expect_eq "ssh:// url" "2solarmax/maxpool" "$(release_github_repo_from_url ssh://git@github.com/2solarmax/maxpool.git)"
expect_eq "fork remote resolves to ITS repo, not the default" "dragosdobro/maxpool" "$(release_github_repo_from_url https://github.com/dragosdobro/maxpool.git)"
release_github_repo_from_url "not-a-url" >/dev/null 2>&1; expect_rc "unparseable url returns non-zero" 1 "$?"
# Non-GitHub hosts parse as URLs but must be REFUSED: the derived repo feeds `gh` (and
# OIDC publish) — a gitlab.com or LAN-mirror remote would point the CI proof elsewhere.
release_github_repo_from_url "https://gitlab.com/o/r.git" >/dev/null 2>&1; expect_rc "gitlab.com url is refused" 1 "$?"
release_github_repo_from_url "git@gitlab.com:o/r.git" >/dev/null 2>&1; expect_rc "gitlab.com scp url is refused" 1 "$?"
release_github_repo_from_url "https://ghe.corp.local/o/r.git" >/dev/null 2>&1; expect_rc "a GitHub Enterprise host is refused" 1 "$?"
release_github_repo_from_url "ssh://git@github.com/o/r" >/dev/null 2>&1; expect_rc "ssh:// github url still parses" 0 "$?"
expect_eq "uppercase host is still github" "o/r" "$(release_github_repo_from_url 'https://GitHub.com/o/r.git')"

# ── branch guard (real throwaway repo; round-2 must-fix) ───────────────────────
# A local branch pinned at main's tip passes the sync guard, `npm version` bumps on it,
# and the atomic push sends that branch + the v* tag → publish.yml publishes from the
# tag → npm gets a version not on main and main's next release wedges on the tag.
G="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false"
git init -q -b main "$T/branchwork"
( cd "$T/branchwork" && echo a >f && git add f && $G commit -qm one )
run_branch() { ( cd "$T/branchwork" && release_require_on_base_branch main ) >"$T/out" 2>"$T/err"; echo $?; }

rc="$(run_branch)"; expect_rc "on main passes" 0 "$rc"

( cd "$T/branchwork" && git checkout -q -b release/1.2.3 )
rc="$(run_branch)"; expect_rc "a branch AT main's tip is refused (must-fix)" 1 "$rc"
grep -q "not 'main'" "$T/err" && ok "wrong-branch message names the branch and fix" || bad "wrong-branch message missing"
grep -q "git checkout main" "$T/err" && ok "wrong-branch message gives the checkout command" || bad "no checkout command in message"

( cd "$T/branchwork" && git checkout -q --detach HEAD )
rc="$(run_branch)"; expect_rc "detached HEAD is refused" 1 "$rc"
grep -q "Detached HEAD" "$T/err" && ok "detached-HEAD message is clear" || bad "detached-HEAD message missing"

( cd "$T/branchwork" && git checkout -q main )
rc="$(run_branch)"; expect_rc "back on main passes again" 0 "$rc"

# ── sync guard (real throwaway repos) ──────────────────────────────────────────
git init -q --bare -b main "$T/remote.git"
git init -q -b main "$T/work"
( cd "$T/work" && git remote add origin "$T/remote.git" \
  && echo a >f && git add f && $G commit -qm one && git push -q origin main )

run_sync() { ( cd "$T/work" && release_require_synced_with_remote origin main ) >"$T/out" 2>"$T/err"; echo $?; }

rc="$(run_sync)"; expect_rc "HEAD equal to remote main passes" 0 "$rc"

( cd "$T/work" && echo b >f && $G commit -qam two )
rc="$(run_sync)"; expect_rc "HEAD ahead of remote main is refused (no CI can exist for it)" 1 "$rc"
grep -q "AHEAD" "$T/err" && ok "ahead message is clear" || bad "ahead message missing"

( cd "$T/work" && git push -q origin main )
rc="$(run_sync)"; expect_rc "HEAD equal again after push passes" 0 "$rc"

# A remote whose fetch refspec does NOT cover main: a plain `git fetch origin main` would
# only write FETCH_HEAD and leave a stale remote-tracking ref (== HEAD here) to be trusted.
( cd "$T/work" && git config remote.origin.fetch "+refs/heads/other:refs/remotes/origin/other" )
git clone -q -b main "$T/remote.git" "$T/other"
( cd "$T/other" && echo c >f && $G commit -qam three && git push -q origin main )
rc="$(run_sync)"; expect_rc "HEAD behind remote main is refused (even when the refspec excludes main)" 1 "$rc"
grep -q "BEHIND" "$T/err" && ok "behind message is clear" || bad "behind message missing"

( cd "$T/work" && echo d >f && $G commit -qam local-only )
rc="$(run_sync)"; expect_rc "diverged HEAD is refused" 1 "$rc"
grep -q "DIVERGED" "$T/err" && ok "diverged message is clear" || bad "diverged message missing"

( cd "$T/work" && git remote set-url origin "$T/nonexistent.git" )
rc="$(run_sync)"; expect_rc "unreachable remote is refused (cannot prove currency)" 1 "$rc"

echo "---- $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
