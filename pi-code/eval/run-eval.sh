#!/usr/bin/env bash
set -euo pipefail

# Eval harness for the pi-code bash classifier. The logic is run-eval.ts,
# which imports the extension's own classifier-core.ts; this just finds the
# arbiter key and runs it with the jiti that ships inside pi (Ubuntu's node is
# built without TypeScript support).
#
#   ./run-eval.sh                 # sandbox policy (what `pi` uses)
#   ./run-eval.sh --host          # host policy (PI_NOSANDBOX)
#   ./run-eval.sh --only=89,90    # just these case ids
#   ./run-eval.sh --offline       # detection invariants only, no model calls
#   PI_LOCAL_POLICY=../policy/claude-code-full.md ./run-eval.sh --host
#
# Exit code: 0 = no critical failures; 1 = at least one (or an invariant hit).

_HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_AGENT_HOME="${HOME}/.local/share/pi-agent/current"
JITI="$(find "${PI_AGENT_HOME}/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib" -name 'jiti-cli.mjs' 2>/dev/null | head -1)"
[[ -n "$JITI" ]] || { echo "run-eval: pi not installed under ${PI_AGENT_HOME} (jiti not found) — run install.sh" >&2; exit 2; }

PI_ARBITER_KEY="$(
    set +u
    for f in "${HOME}/.dotfiles/.env" "${HOME}/.config/pi-agent/env"; do
        # shellcheck disable=SC1090
        [[ -f "$f" ]] && { set -a; source "$f"; set +a; }
    done
    printf '%s' "${PI_ARBITER_KEY:-${OPENCODE_ARBITER_KEY:-}}"
)"
[[ -n "$PI_ARBITER_KEY" || " $* " == *" --offline "* ]] || { echo "run-eval: no arbiter key (PI_ARBITER_KEY in ~/.dotfiles/.env)" >&2; exit 2; }
export PI_ARBITER_KEY
export PI_CODE_DIR="${_HERE}/.."

exec node "$JITI" "${_HERE}/run-eval.ts" "$@"
