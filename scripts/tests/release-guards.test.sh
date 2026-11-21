#!/usr/bin/env bash
# Bash test for scripts/release-guards.sh. Stubs `gh` and `sleep` on PATH; the
# sync guard uses real throwaway git repos in a temp dir (no network).
# Run: bash scripts/tests/release-guards.test.sh   (exit 0 = all pass)
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../release-guards.sh"

T="$(mktemp -d "${TMPDIR:-/tmp}/release-guards-test.XXXXXX")"
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok   - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
expect_rc() {  # name expected_rc actual_rc
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want rc=$2 got rc=$3)"; fi
}

# ── stubs ──────────────────────────────────────────────────────────────────────
mkdir -p "$T/bin"
cat >"$T/bin/gh" <<'STUB'
#!/usr/bin/env bash
# `gh run list ...`  -> prints $GH_LIST_OUT (already in "<id> <status> <conclusion>" shape)
# `gh run view ...`  -> prints $GH_JOBS_OUT (tab-separated "<job>\t<conclusion>" lines)
echo "gh $*" >>"$GH_CALLS"
case "$1 $2" in
  "run list") [[ -n "${GH_LIST_OUT:-}" ]] && printf '%s\n' "$GH_LIST_OUT"; exit 0 ;;
  "run view") printf '%b\n' "${GH_JOBS_OUT:-}"; exit 0 ;;
esac
exit 1
STUB
cat >"$T/bin/sleep" <<'STUB'
#!/usr/bin/env bash
echo "sleep $*" >>"$GH_CALLS"
exit 0
STUB
chmod +x "$T/bin/gh" "$T/bin/sleep"
export GH_CALLS="$T/calls.log"
PATH="$T/bin:$PATH"

# ── CI guard ───────────────────────────────────────────────────────────────────
SHA=0123456789abcdef0123456789abcdef01234567
GREEN_JOBS='test (18)\tsuccess\ntest (20)\tsuccess\ntest (22)\tsuccess\nci-gate\tsuccess'

run_ci() {  # run_ci <gh run list line> <gh jobs lines> [ceiling]; prints rc
  : >"$GH_CALLS"
  ( export GH_LIST_OUT="$1" GH_JOBS_OUT="$2"; RELEASE_CI_CEILING="${3:-0}" RELEASE_CI_POLL=1 \
    release_require_ci_green o/r "$SHA" ) >"$T/out" 2>"$T/err"
  echo $?
}

rc="$(run_ci "4242 completed success" "$GREEN_JOBS")"
expect_rc "ci success for exact SHA passes" 0 "$rc"
grep -q -- "--commit $SHA" "$GH_CALLS" && ok "gh queried with --commit <exact sha>" || bad "gh not queried with --commit sha"

rc="$(run_ci "4242 completed failure" "$GREEN_JOBS")"
expect_rc "ci run concluded failure is refused" 1 "$rc"
grep -q "concluded 'failure'" "$T/err" && ok "failure message is clear" || bad "failure message missing"

rc="$(run_ci "" "")"
expect_rc "no CI run for SHA is refused after ceiling" 1 "$rc"
grep -q "within 0s" "$T/err" && ok "missing-run message names the ceiling" || bad "missing-run message missing"

rc="$(run_ci "4242 in_progress " "")"
expect_rc "still-running CI at ceiling is refused" 1 "$rc"

rc="$(run_ci "4242 completed success" 'test (18)\tsuccess\ntest (20)\tfailure\nci-gate\tsuccess')"
expect_rc "a failed test job refuses even if run says success" 1 "$rc"

rc="$(run_ci "4242 completed success" 'test (18)\tsuccess\nci-gate\tskipped')"
expect_rc "ci-gate not success is refused" 1 "$rc"

rc="$(run_ci "4242 completed success" 'ci-gate\tsuccess')"
expect_rc "no test job present is refused" 1 "$rc"

# ── sync guard (real throwaway repos) ──────────────────────────────────────────
G="git -c user.email=t@t -c user.name=t -c commit.gpgsign=false"
git init -q --bare "$T/remote.git"
git init -q -b main "$T/work"
( cd "$T/work" && git remote add origin "$T/remote.git" \
  && echo a >f && git add f && $G commit -qm one && git push -q origin main )

run_sync() { ( cd "$T/work" && release_require_synced_with_remote origin main ) >"$T/out" 2>"$T/err"; echo $?; }

rc="$(run_sync)"; expect_rc "HEAD equal to remote main passes" 0 "$rc"

( cd "$T/work" && echo b >f && $G commit -qam two )
rc="$(run_sync)"; expect_rc "HEAD ahead (fast-forward of remote main) passes" 0 "$rc"

( cd "$T/work" && git push -q origin main )
git clone -q "$T/remote.git" "$T/other"
( cd "$T/other" && echo c >f && $G commit -qam three && git push -q origin main )
rc="$(run_sync)"; expect_rc "HEAD behind remote main is refused" 1 "$rc"
grep -q "BEHIND" "$T/err" && ok "behind message is clear" || bad "behind message missing"

( cd "$T/work" && echo d >f && $G commit -qam local-only )
rc="$(run_sync)"; expect_rc "diverged HEAD is refused" 1 "$rc"
grep -q "DIVERGED" "$T/err" && ok "diverged message is clear" || bad "diverged message missing"

( cd "$T/work" && git remote set-url origin "$T/nonexistent.git" )
rc="$(run_sync)"; expect_rc "unreachable remote is refused (cannot prove currency)" 1 "$rc"

echo "---- $PASS passed, $FAIL failed"
[[ "$FAIL" -eq 0 ]]
