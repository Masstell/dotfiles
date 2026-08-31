#!/usr/bin/env bash
set -euo pipefail

# Run the pi coding agent (https://pi.dev) against the local model, via the
# arbiter's OpenAI-compatible proxy. Sibling to claude-local.sh / opencode.sh.
#
# Unlike claude-local (where Anthropic's binary ships its own bash-safety
# classifier and we only point the endpoint), pi ships NO permission system by
# design. So this launcher loads two dotfiles-managed extensions:
#
#   extensions/arbiter-provider.ts   registers the resident model as a provider
#   extensions/bash-classifier.ts    gates every bash call through the local
#                                    model (fail-closed) — our own classifier
#
# Everything is exported into THIS PROCESS ONLY.
#
#   pi-local              # interactive TUI
#   pi-local -p "hi"      # one-shot / print mode
#   pi-local --help       # pi's own help

_ENV_FILE="${HOME}/.dotfiles/.env"
if [[ -f "$_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$_ENV_FILE"
    set +a
fi

# Directory of this script — the extensions and policy file resolve from here,
# so the whole thing is portable: clone the dotfiles anywhere and it still works.
# Resolve symlinks: pi-local is invoked via ~/.local/bin/pi-local, a symlink to
# this file, so dirname of $BASH_SOURCE alone would point at ~/.local/bin.
_src="${BASH_SOURCE[0]}"
while [[ -L "$_src" ]]; do
    _dir="$(cd -P "$(dirname "$_src")" && pwd)"
    _src="$(readlink "$_src")"
    [[ "$_src" != /* ]] && _src="$_dir/$_src"
done
PI_CODE_DIR="$(cd -P "$(dirname "$_src")" && pwd)"
export PI_CODE_DIR

# Reach the arbiter over HTTP like any other service. Fall back to the keys
# opencode.sh already uses (same OpenAI route) so this runs with no new .env.
PI_ARBITER_URL="${PI_ARBITER_URL:-${OPENCODE_LLM_URL:-${LLAMA_URL:-https://ai.mswensen.com}}}"
PI_ARBITER_KEY="${PI_ARBITER_KEY:-${OPENCODE_ARBITER_KEY:-${LLAMA_API_KEY:-}}}"
export PI_ARBITER_URL PI_ARBITER_KEY

if ! command -v pi >/dev/null 2>&1; then
    echo "pi-local: pi not found on PATH." >&2
    echo "          Install with: curl -fsSL https://pi.dev/install.sh | sh" >&2
    exit 1
fi

if [[ -z "$PI_ARBITER_KEY" ]]; then
    echo "pi-local: no arbiter client key. Set PI_ARBITER_KEY (or reuse" >&2
    echo "          OPENCODE_ARBITER_KEY) in ${_ENV_FILE}." >&2
    exit 1
fi

# Discover the resident model exactly like claude-local.sh / opencode.sh do:
# the arbiter re-stamps status with its own belief, so `loaded` is the arbiter's
# answer. Prints "<model-id><TAB><n_ctx>" (n_ctx is what llama-server ACTUALLY
# allocated — read, never assumed).
get_loaded_model() {
    curl -sf "${PI_ARBITER_URL%/}/v1/models" \
        -H "Authorization: Bearer ${PI_ARBITER_KEY}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)
for m in data.get('data', []):
    if m.get('status', {}).get('value') == 'loaded':
        ctx = (m.get('meta') or {}).get('n_ctx') or ''
        print(m['id'] + '\t' + str(ctx))
        break
" 2>/dev/null
}

IFS=$'\t' read -r MODEL MODEL_CTX < <(get_loaded_model)
if [[ -z "${MODEL:-}" ]]; then
    echo "pi-local: no model is loaded on ${PI_ARBITER_URL} (or the key was rejected)." >&2
    exit 1
fi

# Handed to the extensions via env (the provider builds its model entry from
# these; the classifier pins the same resident model for its verdicts).
export PI_ARBITER_MODEL="$MODEL"
export PI_ARBITER_CTX="${MODEL_CTX:-}"

echo "pi-local: ${MODEL} via ${PI_ARBITER_URL} (ctx ${MODEL_CTX:-unknown})" >&2
if [[ "${PI_LOCAL_READONLY:-}" =~ ^(1|true|yes|on)$ ]]; then
    echo "pi-local: READ-ONLY / plan mode is ON (bash writes & edits blocked)." >&2
fi

exec pi \
    -e "${PI_CODE_DIR}/extensions/arbiter-provider.ts" \
    -e "${PI_CODE_DIR}/extensions/bash-classifier.ts" \
    --model "arbiter/${MODEL}" \
    "$@"
