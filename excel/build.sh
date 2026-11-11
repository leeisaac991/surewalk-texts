#!/usr/bin/env bash
# Build the Excel panel and add-in:
#   dist/ = Script Lab snippet bundle
#   docs/ = GitHub Pages site for the Excel add-in (taskpane.html + manifest.xml + assets)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"; OUT="$HERE/dist"; DOCS="$ROOT/docs"
mkdir -p "$OUT" "$DOCS" "$DOCS/assets"

# 1. dist/ for Script Lab
cp "$HERE/panel.html" "$HERE/panel.js" "$OUT/"
cp "$ROOT/protocol.js" "$OUT/"
node --check "$OUT/panel.js"
node --check "$OUT/protocol.js"

# 2. docs/ for the Office Taskpane Add-in
cp "$HERE/panel.js" "$ROOT/protocol.js" "$DOCS/"
cp "$ROOT/manifest.xml" "$DOCS/"
cp "$HERE/assets/"*.png "$DOCS/assets/"
touch "$DOCS/.nojekyll"

# Assemble taskpane.html
cat > "$DOCS/taskpane.html" <<HTML
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>SURE Walk Texts</title>
  <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
  <script src="protocol.js"></script>
</head>
<body>
$(cat "$HERE/panel.html")
<script src="panel.js"></script>
</body>
</html>
HTML

echo "built $OUT and $DOCS"
