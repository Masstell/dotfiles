#!/usr/bin/env bash
# pi coding bench (bench.ts): synthetic tasks run by pi, graded by hidden tests.
# Runs with the TypeScript loader inside pi; options are listed in bench.ts.
set -euo pipefail
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JITI="$(find "${HOME}/.local/share/pi-agent/current/lib/node_modules/jiti/lib" -name 'jiti-cli.mjs' 2>/dev/null | head -1 || true)"
[[ -n "$JITI" ]] || { echo "pi-bench: pi is not installed (jiti not found) — run install.sh" >&2; exit 2; }
exec node "$JITI" "${_HERE}/bench.ts" "$@"
