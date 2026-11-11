#!/usr/bin/env bash
# End-to-end test: fake GroupMe + fake Excel + the real panel, server and texting code (SUREWALK_GS or ../texting/apps-script).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
export TMPDIR_E2E="$(mktemp -d)"; trap 'rm -rf "$TMPDIR_E2E"' EXIT
node "$HERE/e2e.mjs"
