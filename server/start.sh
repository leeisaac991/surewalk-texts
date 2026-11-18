#!/usr/bin/env bash
# DEPRECATED (Linux backup only; Windows is the main program: windows/START-TEXTING.cmd).
# Start the texting server (as the systemd user service if it's installed) and open the dashboard in the browser.
set -euo pipefail
echo "⚠ DEPRECATED: Linux is a backup only. SURE Walk Texts runs on the Windows laptop now (START-TEXTING.cmd)." >&2
HERE="$(cd "$(dirname "$0")" && pwd)"; URL="http://127.0.0.1:${PORT:-8787}/"
if systemctl --user cat surewalk-texts >/dev/null 2>&1; then
  systemctl --user start surewalk-texts
  for _ in $(seq 20); do curl -fs -o /dev/null "$URL" && break; sleep 0.3; done
  xdg-open "$URL" >/dev/null 2>&1 &
else
  exec node "$HERE/server.mjs" --open
fi
