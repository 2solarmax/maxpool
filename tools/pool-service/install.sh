#!/bin/bash
# Install (or refresh) Maxpool as a background service on macOS.
#
# launchd starts a private tmux server at login and restarts it if it ever stops;
# tmux runs pane.sh, which runs maxpool with the normal dashboard. Type `maxpool`
# (with tools/pool-service/maxpool.zsh sourced) to see the dashboard; closing the
# view or the Terminal tab no longer stops the pool.
#
#   install.sh [--label L] [--port N] [--dir D] [--no-load]
#
#   --label    launchd label (default com.maxpool.pool). Any other label is a
#              canary: it gets its own config in --dir with no accounts, no
#              providers and all update machinery off.
#   --port     port the pool serves on (default 3456)
#   --dir      service folder: tmux socket, tmux.conf, logs (default ~/.config/maxpool)
#   --no-load  write the plist and tmux.conf only; never call launchctl
#
# Env: MAXPOOL_NPM_ROOT overrides `npm root -g` (the folder holding maxpool/). When
# set, the service runs THAT package's entry point (e.g. an unpacked `npm pack`).
set -euo pipefail

MIN_VERSION="1.24.95"   # first release with service-mode q + the "already in use" hint
DEFAULT_LABEL="com.maxpool.pool"
LABEL="$DEFAULT_LABEL"
PORT=3456
DIR="$HOME/.config/maxpool"
LOAD=1
ORIG_ARGS="$*"

die() { echo "install.sh: $*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --label) LABEL="${2:?--label needs a value}"; shift 2 ;;
    --port) PORT="${2:?--port needs a value}"; shift 2 ;;
    --dir) DIR="${2:?--dir needs a value}"; shift 2 ;;
    --no-load) LOAD=0; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done
case "$PORT" in ''|*[!0-9]*) die "--port must be a number: $PORT" ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMUX_BIN=/opt/homebrew/bin/tmux
[ -x "$TMUX_BIN" ] || die "tmux not found at $TMUX_BIN (brew install tmux)"
[ -x "$HERE/pane.sh" ] || die "not executable: $HERE/pane.sh"
[ -x "$HERE/start.sh" ] || die "not executable: $HERE/start.sh"
# A unix socket path over ~104 bytes cannot be bound ("File name too long").
SOCK="$DIR/tmux.sock"
[ "${#SOCK}" -le 100 ] || die "socket path $SOCK is ${#SOCK} chars; tmux needs 100 or fewer. Use a shorter --dir"

# ── the installed maxpool must carry the service-mode changes ────────────────
if [ -n "${MAXPOOL_NPM_ROOT:-}" ]; then NPM_ROOT="$MAXPOOL_NPM_ROOT"; else NPM_ROOT="$(npm root -g)"; fi
PKG="$NPM_ROOT/maxpool"
[ -r "$PKG/package.json" ] || die "maxpool is not installed under $NPM_ROOT"
VERSION="$(/usr/bin/plutil -extract version raw -o - "$PKG/package.json")" || die "cannot read the version in $PKG/package.json"
if [ "$(printf '%s\n%s\n' "$MIN_VERSION" "$VERSION" | sort -V | head -1)" != "$MIN_VERSION" ]; then
  die "maxpool $VERSION is installed; the service needs $MIN_VERSION or newer. Update first: npm install -g maxpool@latest"
fi

NODE_PATH_BIN="$(command -v node || true)"
[ -n "$NODE_PATH_BIN" ] || die "node not found on PATH"
NODE_BIN="$(cd "$(dirname "$NODE_PATH_BIN")" && pwd)"

mkdir -p "$DIR"
chmod 700 "$DIR"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$PLIST")"

# ── config: the real one for the live label, a sealed canary otherwise ───────
if [ "$LABEL" = "$DEFAULT_LABEL" ]; then
  # Same resolution as src/config.js: maxpool.json, else the legacy teamclaude.json.
  CONFIG="$HOME/.config/maxpool.json"
  [ -e "$CONFIG" ] || [ ! -e "$HOME/.config/teamclaude.json" ] || CONFIG="$HOME/.config/teamclaude.json"
else
  CONFIG="$DIR/config.json"
  if [ ! -e "$CONFIG" ]; then
    KEY="mp-$(head -c 24 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=\n')"
    ( umask 077; cat > "$CONFIG" <<CONFIG_EOF
{
  "proxy": { "host": "127.0.0.1", "port": $PORT, "apiKey": "$KEY" },
  "upstream": "http://127.0.0.1:9",
  "accounts": [{ "name": "canary-dummy", "type": "apikey", "apiKey": "canary-not-a-real-key" }],
  "providers": [],
  "preventSleep": false,
  "updateCheck": false,
  "autoUpdate": false,
  "autoApply": false
}
CONFIG_EOF
    )
    echo "wrote canary config $CONFIG (port $PORT, one dummy account, upstream 127.0.0.1:9, updates off)"
  fi
fi

# ── tmux.conf: committed settings + the pool session (absolute pane.sh path) ─
{ cat "$HERE/tmux.conf"; echo "new-session -d -s pool $HERE/pane.sh"; } > "$DIR/tmux.conf"

CMD_ENV=""
if [ -n "${MAXPOOL_NPM_ROOT:-}" ]; then
  CMD_ENV="        <key>MAXPOOL_CMD</key>
        <string>$PKG/src/index.js</string>"
fi

# Written here, not committed: a plist needs absolute paths.
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>$HERE/start.sh</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>MAXPOOL_CONFIG</key>
        <string>$CONFIG</string>
        <key>MAXPOOL_PORT</key>
        <string>$PORT</string>
        <key>MAXPOOL_DIR</key>
        <string>$DIR</string>
        <key>MAXPOOL_SERVICE</key>
        <string>1</string>
        <key>MAXPOOL_TMUX_SOCK</key>
        <string>$SOCK</string>
        <key>MAXPOOL_NODE_BIN</key>
        <string>$NODE_BIN</string>
$CMD_ENV
        <key>PATH</key>
        <string>$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>LANG</key>
        <string>en_US.UTF-8</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>$DIR</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Interactive</string>
    <key>StandardOutPath</key>
    <string>$DIR/tmux.log</string>
    <key>StandardErrorPath</key>
    <string>$DIR/tmux.log</string>
</dict>
</plist>
PLIST_EOF
/usr/bin/plutil -lint "$PLIST" >/dev/null || die "generated plist is invalid: $PLIST"
echo "wrote $PLIST (maxpool $VERSION, node $NODE_BIN)"

UID_NUM="$(id -u)"
if [ "$LOAD" -eq 0 ]; then
  echo "--no-load: launchd untouched. Load it with:"
  echo "  launchctl enable gui/$UID_NUM/$LABEL && launchctl bootstrap gui/$UID_NUM $PLIST"
  exit 0
fi

# enable before bootstrap (a disabled job refuses to load); bootout first so a
# re-run picks up an edited plist. "Not loaded" / "already loaded" are fine.
launchctl enable "gui/$UID_NUM/$LABEL"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null \
  || echo "launchctl bootstrap reported an error (often: already loaded). Check: launchctl print gui/$UID_NUM/$LABEL"

echo
echo "Dashboard : env -u TMUX tmux -u -S $SOCK attach -t pool   (or: maxpool)"
echo "Logs      : $DIR/pane.log  $DIR/tmux.log"
echo "Remove    : launchctl bootout gui/$UID_NUM/$LABEL && rm $PLIST"
echo "Reinstall : $HERE/install.sh $ORIG_ARGS"
if [ "$LABEL" = "$DEFAULT_LABEL" ]; then
  cat <<STEPS

Switch over from the Terminal pool, while idle:
  1. maxpool route direct          (sessions go straight to Anthropic)
  2. In the Terminal tab running the pool: q, then y
  3. Wait until 'maxpool status' answers (the service takes the port within ~1s)
  4. maxpool route pool            (sessions go back to the pool)
STEPS
fi
