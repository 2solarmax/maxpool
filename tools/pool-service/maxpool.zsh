# maxpool — shell function for the background service (tools/pool-service).
# Source it from ~/.zshrc:  source ~/maxpool/tools/pool-service/maxpool.zsh
#
#   maxpool        show the dashboard (attaches to the running service; never starts one)
#   maxpool off    sessions go straight to Anthropic, then the pool stops and stays off
#   maxpool on     the pool starts again; sessions go back to it once it answers
#   maxpool ...    anything else runs the real binary unchanged
#
# launchd is the ONLY thing that starts the pool. A shell without this function
# (bash, scripts) runs the real binary.
maxpool() {
  local label="${MAXPOOL_SERVICE_LABEL:-com.maxpool.pool}"
  local dir="${MAXPOOL_DIR:-$HOME/.config/maxpool}"
  local port="${MAXPOOL_PORT:-3456}"
  local sock="$dir/tmux.sock" log="$dir/pane.log"
  local domain="gui/$(id -u)"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local i

  case "${1:-}" in
    "")
      if command tmux -S "$sock" has-session -t pool 2>/dev/null; then
        command env -u TMUX tmux -u -S "$sock" attach -t pool
        return
      fi
      if launchctl print-disabled "$domain" 2>/dev/null \
          | command grep -qF -e "\"$label\" => disabled" -e "\"$label\" => true"; then
        echo "Maxpool is off. Turn on: maxpool on"
        return 0
      fi
      echo "Maxpool is starting or restarting. Try again in a few seconds. Log: $log"
      return 1
      ;;
    off)
      command maxpool route direct
      launchctl disable "$domain/$label"
      launchctl bootout "$domain/$label" 2>/dev/null || true   # "not loaded" is fine
      for (( i = 0; i < ${MAXPOOL_OFF_WAIT_SECS:-20}; i++ )); do
        command nc -z 127.0.0.1 "$port" 2>/dev/null || break
        sleep 1
      done
      echo "Maxpool is off. Sessions go straight to Anthropic. Turn on: maxpool on"
      ;;
    on)
      launchctl enable "$domain/$label"
      launchctl bootstrap "$domain" "$plist" 2>/dev/null || true   # "already loaded" is fine
      for (( i = 0; i < ${MAXPOOL_ON_WAIT_SECS:-20}; i++ )); do
        if command maxpool status >/dev/null 2>&1; then
          command maxpool route pool
          echo "Maxpool is on."
          return 0
        fi
        sleep 1
      done
      # Leave the job ENABLED: the health monitor keeps alerting until it answers.
      echo "MAXPOOL DID NOT START. Sessions are going direct to Anthropic. See $log" >&2
      return 1
      ;;
    *)
      command maxpool "$@"
      ;;
  esac
}
