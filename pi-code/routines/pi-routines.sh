#!/usr/bin/env bash
# Starts the routine runner (runner.ts) with the TypeScript loader that ships
# inside pi (Ubuntu's node can't run .ts). The pi-routines systemd service
# (Ansible vm_base, pi_agent) runs this as the owner.
set -euo pipefail
_src="${BASH_SOURCE[0]}"
while [[ -L "$_src" ]]; do
    _dir="$(cd -P "$(dirname "$_src")" && pwd)"
    _src="$(readlink "$_src")"
    [[ "$_src" != /* ]] && _src="$_dir/$_src"
done
HERE="$(cd -P "$(dirname "$_src")" && pwd)"
JITI="$(find "${HOME}/.local/share/pi-agent/current/lib/node_modules/jiti/lib" -name 'jiti-cli.mjs' 2>/dev/null | head -1 || true)"
[[ -n "$JITI" ]] || { echo "pi-routines: pi is not installed (jiti not found) — run ~/.dotfiles/install.sh" >&2; exit 1; }
export PI_ROUTINES_RUNNER_MAIN=1
exec /usr/bin/node "$JITI" "$HERE/runner.ts"
