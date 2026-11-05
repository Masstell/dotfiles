#!/usr/bin/env bash
set -euo pipefail
# Offline tests for scheduling, routines and the routine runner, run with the
# jiti that ships inside pi (and pi's typebox). No model calls, no keys needed.
_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODS="${HOME}/.local/share/pi-agent/current/lib/node_modules"
JITI="$(find "$MODS/jiti/lib" -name 'jiti-cli.mjs' 2>/dev/null | head -1 || true)"
[[ -n "$JITI" ]] || { echo "routines-eval: pi not installed (jiti not found) — run install.sh" >&2; exit 2; }
NODE_PATH="$MODS" exec node "$JITI" "${_HERE}/routines-eval.ts" "$@"
