#!/bin/bash
# Checks the Wi-Fi exclusion logic with synthetic names only (no radio, no join).
# Usage: ./test_wifi_exclusions.sh [path-to-WiFiExclusions.swift]   (a mutated copy can be passed)
set -euo pipefail
cd "$(dirname "$0")"
SRC="${1:-WiFiExclusions.swift}"
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
cp "$SRC" "$OUT/WiFiExclusions.swift"
cp test_wifi_exclusions_main.swift "$OUT/main.swift"
swiftc -swift-version 6 -o "$OUT/t" "$OUT/WiFiExclusions.swift" "$OUT/main.swift"
"$OUT/t"
