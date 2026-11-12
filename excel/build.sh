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
cp "$HERE/panel.html" "$HERE/panel.js" "$ROOT/protocol.js" "$DOCS/"
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
  <style>body { margin: 0; font: 14px "Segoe UI", system-ui, sans-serif; }</style>
</head>
<body>
<div id="loading" style="padding:24px;color:#6e6e73">Loading SURE Walk Texts…</div>
<script>
  // The SURE Walk Texts add-in side panel: every file is fetched fresh (never a stale browser copy),
  // so a reopen or restart always gets the newest panel.
  (async () => {
    const get = async f => { const r = await fetch(f, { cache: 'no-cache' }); if (!r.ok) throw new Error(f + ' (' + r.status + ')'); return r.text(); };
    try {
      if (!window.__SWT_SRC) {
        const [html, protocol, panel] = await Promise.all([get('panel.html'), get('protocol.js'), get('panel.js')]);
        window.__SWT_SRC = { html, protocol, panel };
      }
      document.body.innerHTML = window.__SWT_SRC.html;
      const s1 = document.createElement('script'); s1.textContent = window.__SWT_SRC.protocol; document.body.appendChild(s1);
      const s2 = document.createElement('script'); s2.textContent = window.__SWT_SRC.panel; document.body.appendChild(s2);
    } catch (e) {
      document.getElementById('loading').innerHTML = '<span style="color:#c62828">Could not load the panel: ' + e.message + '. Check the internet connection and reopen it.</span>';
    }
  })();
</script>
</body>
</html>
HTML

echo "built $OUT and $DOCS"
