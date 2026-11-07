#!/bin/bash
# Build Maxbar.app — menu-bar sleep toggle + hotspot auto-join + lid lock +
# Claude routing Pool/Direct toggle. Works on any arm64 Mac with Xcode CLT.
# Output: ./Maxbar.app next to this script (NOT auto-installed — run the
# "Install to /Applications" step below yourself; a build script that silently
# kills and replaces a running app is rude on shared machines).
set -euo pipefail
cd "$(dirname "$0")"

[ "$(uname -s)" = Darwin ] || { echo "Maxbar builds on macOS only"; exit 1; }
command -v swiftc >/dev/null || { echo "swiftc not found — run: xcode-select --install"; exit 1; }

APP="Maxbar.app"
CONTENTS="$APP/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

rm -rf "$APP"
mkdir -p "$MACOS" "$RESOURCES"

swiftc -O -parse-as-library -swift-version 6 -target arm64-apple-macos13.0 \
  -o "$MACOS/Maxbar" Maxbar.swift \
  -framework SwiftUI -framework AppKit

cp Info.plist "$CONTENTS/Info.plist"

codesign --force --sign - "$APP"

cat <<'EOF'
Built: ./Maxbar.app (ad-hoc signed)

Next steps — one-time setup per machine:

 1. Install the app (copy it OUT of the repo, or macOS may quarantine/replace it
    on the next git pull):
      cp -R Maxbar.app /Applications/ && open /Applications/Maxbar.app
    In the menu: enable "Launch at Login".

 2. ONE-TIME ADMIN STEP — passwordless sudo for the sleep toggle (an admin
    password, once; the app never asks for a password again). Without it the
    sleep toggle shows "sudo: a password is required":
      sed "s/YOURNAME/$(whoami)/" sudoers-example | sudo tee /etc/sudoers.d/sleep-control >/dev/null
      sudo chown root:wheel /etc/sudoers.d/sleep-control && sudo chmod 0440 /etc/sudoers.d/sleep-control
      sudo visudo -cf /etc/sudoers.d/sleep-control   # must print: parsed OK
    (Run from this folder. The template grants exactly two commands:
     pmset -a disablesleep 0 and 1.)

 3. Menu: "Set hotspot name…" — type your iPhone's hotspot name once.
    (Or launch with:  open -a Maxbar --args --hotspot-ssid "Your iPhone")

 4. "Claude routing" only works after the pool proxy (rc-gate) is set up on
    that machine — see tools/rc-gate/ in this repo. On machines without it,
    leave routing on Direct. After switching, restart the Claude app.
EOF
