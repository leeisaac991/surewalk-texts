#!/usr/bin/env bash
# Build the Excel panel: dist/ = panel.html + protocol.js + panel.js. Then commit + push, and ./snippet.sh <commit>.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; OUT="$HERE/dist"
mkdir -p "$OUT"
cp "$HERE/panel.html" "$HERE/panel.js" "$OUT/"
cp "$HERE/../protocol.js" "$OUT/"
node --check "$OUT/panel.js"
node --check "$OUT/protocol.js"
echo "built $OUT"
