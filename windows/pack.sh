#!/usr/bin/env bash
# Builds SURE-Walk-Texts-Windows.zip: copy it to the laptop, extract, double-click START-TEXTING.cmd.
#   windows/pack.sh [out dir]      (default: dist/ in this repo, which git ignores)
# Env: VERSION     = release number written to VERSION (default: today, e.g. 2026.11.18)
# Env: SUREWALK_GS = the .gs folder (default ~/Documents/surewalk/texting/apps-script)
#      NODE_ZIP    = a node-v*-win-x64.zip to include (default: download the current LTS and check its SHA-256)
# The zip holds code only - no settings, keys, message logs or GroupMe token.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(dirname "$HERE")"
GS="${SUREWALK_GS:-$HOME/Documents/surewalk/texting/apps-script}"
OUT="${1:-$ROOT/dist}"; NAME=SURE-Walk-Texts-Windows
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
D="$W/$NAME"; mkdir -p "$D/app/texts-panel/server" "$D/app/apps-script" "$D/app/windows/test"

cp "$HERE"/*.cmd "$HERE/README.txt" "$D/"
cp "$HERE"/{bridge,install,update}.ps1 "$D/app/windows/"
echo "${VERSION:-$(date +%Y.%m.%d)}" > "$D/VERSION"; cp "$HERE"/test/*.mjs "$D/app/windows/test/"
cp "$ROOT/protocol.js" "$D/app/texts-panel/"
cp "$ROOT"/server/{server.mjs,gas.js,shim.js,setup.html} "$D/app/texts-panel/server/"
for f in Build.gs Places.gs Rides.gs Texts.gs Bridge.gs Code.gs Dashboard.html; do
  [ -f "$GS/$f" ] && cp "$GS/$f" "$D/app/apps-script/"
done
[ -f "$D/app/apps-script/Code.gs" ] || { echo "No Code.gs in $GS (set SUREWALK_GS)"; exit 1; }
# The old Google web-app address in the dashboard: the local server serves it at / anyway; keep it out of copies.
sed -i -E 's#https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec#/#g' "$D/app/apps-script/Dashboard.html"
# Every .gs file and every <script> in the pages must parse: one stray quote stops the whole dashboard from loading
# (2026.11.19.2/.3 shipped with an unescaped "it's" and the page never started).
for f in "$D"/app/apps-script/*.gs; do node --check --input-type=commonjs < "$f" 2>/dev/null || node -e 'new Function(require("fs").readFileSync(process.argv[1], "utf8"))' "$f" || { echo "Syntax error in $f"; exit 1; }; done
for f in "$D"/app/apps-script/*.html; do
  node -e '
    const t = require("fs").readFileSync(process.argv[1], "utf8"), re = /<script>([\s\S]*?)<\/script>/g; let m, i = 0;
    while ((m = re.exec(t))) { i++; try { new Function(m[1]); } catch (e) { console.error(`Syntax error in ${process.argv[1]}, <script> #${i}: ${e.message}`); process.exit(1); } }' "$f" || exit 1
done

if [ -n "${NODE_ZIP:-}" ]; then cp "$NODE_ZIP" "$D/"
else
  V=$(curl -fsS https://nodejs.org/dist/index.json | python3 -c "import json,sys; print(next(r['version'] for r in json.load(sys.stdin) if r['lts'] and 'win-x64-zip' in r['files']))")
  F="node-$V-win-x64.zip"
  curl -fsS -o "$D/$F" "https://nodejs.org/dist/$V/$F"
  (cd "$D" && curl -fsS "https://nodejs.org/dist/$V/SHASUMS256.txt" | grep " $F\$" | sha256sum -c - >/dev/null) || { echo "Node.js checksum mismatch"; exit 1; }
fi
find "$D" -name '*.cmd' -o -name '*.txt' | while read -r f; do sed -i 's/\r*$/\r/' "$f"; done

mkdir -p "$OUT"; rm -f "$OUT/$NAME.zip"
(cd "$W" && zip -qr -X "$OUT/$NAME.zip" "$NAME")
(cd "$OUT" && sha256sum "$NAME.zip" > "$NAME.zip.sha256")
echo "Built $OUT/$NAME.zip ($(du -h "$OUT/$NAME.zip" | cut -f1)), version $(cat "$D/VERSION")"
