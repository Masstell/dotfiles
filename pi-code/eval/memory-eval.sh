#!/usr/bin/env bash
set -euo pipefail
# Offline tests for the project-memory logic (extensions/memory-core.ts), run
# with the jiti that ships inside pi. No model calls, no keys needed.
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JITI="$(find "${HOME}/.local/share/pi-agent/current/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib" -name 'jiti-cli.mjs' 2>/dev/null | head -1)"
[[ -n "$JITI" ]] || { echo "memory-eval: pi not installed (jiti not found) — run install.sh" >&2; exit 2; }
exec node "$JITI" "${_HERE}/memory-eval.ts" "$@"
