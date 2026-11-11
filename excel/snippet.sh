#!/usr/bin/env bash
# Write the Script Lab snippet: a small loader that fetches excel/dist from GitHub (through jsDelivr) at one exact
# commit, so an open panel never changes mid-shift.     ./snippet.sh <commit-sha>  ->  scriptlab/SURE-Walk-Texts.yaml
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
SHA="${1:?usage: ./snippet.sh <commit sha that contains excel/dist>}"
REPO="${REPO:-leeisaac991/surewalk-texts}"
mkdir -p "$HERE/scriptlab"
cat > "$HERE/scriptlab/SURE-Walk-Texts.yaml" <<YAML
name: SURE Walk Texts
description: SURE Walk texting / calling panel for the rides workbook (mark called, cancel, duplicate, places, GroupMe sync). Build ${SHA:0:7}.
host: EXCEL
api_set: {}
script:
  content: |
    // @ts-nocheck
    // Loads the panel from github.com/${REPO} (folder excel/dist, commit ${SHA:0:7}). Nothing to edit here.
    const BASE = "https://cdn.jsdelivr.net/gh/${REPO}@${SHA}/excel/dist/";
    document.body.innerHTML = '<div style="font:14px Segoe UI,system-ui,sans-serif;padding:24px;color:#6e6e73">Loading SURE Walk Texts…</div>';
    Promise.all(["panel.html", "protocol.js", "panel.js"].map(f =>
      fetch(BASE + f).then(r => { if (!r.ok) throw new Error(f + " (" + r.status + ")"); return r.text(); })))
      .then(([html, protocol, panel]) => { document.body.innerHTML = html; (0, eval)(protocol); (0, eval)(panel); })
      .catch(e => { document.body.innerHTML = '<p style="font:14px Segoe UI,system-ui,sans-serif;padding:24px;color:#c62828">Could not load the panel: ' + e.message + '. Check the internet connection and press Run again.</p>'; });
  language: typescript
template:
  content: |
    <div></div>
  language: html
style:
  content: |
    body { margin: 0; }
  language: css
libraries: |
  https://appsforoffice.microsoft.com/lib/1/hosted/office.js
  @types/office-js
YAML
echo "wrote $HERE/scriptlab/SURE-Walk-Texts.yaml (commit ${SHA:0:7})"
