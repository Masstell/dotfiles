#!/usr/bin/env bash
set -euo pipefail

# Run Claude Code against the local model, via the arbiter's Anthropic
# Messages proxy (atlas issue #116). Mirrors opencode.sh.
#
# Everything is exported into THIS PROCESS ONLY, so plain `claude` keeps using
# the saved Anthropic login — `ANTHROPIC_AUTH_TOKEN` takes precedence only for
# the session it is set in (docs: code.claude.com/docs/en/llm-gateway-connect).
#
#   claude-local            # interactive
#   claude-local -p "hi"    # one-shot

_ENV_FILE="${HOME}/.dotfiles/.env"
if [[ -f "$_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$_ENV_FILE"
    set +a
fi

CLAUDE_LOCAL_URL="${CLAUDE_LOCAL_URL:-${LLAMA_URL:-https://ai.mswensen.com}}"

# The key lives in ~/.dotfiles/.env as CLAUDE_CODE_ARBITER_KEY, alongside
# OPENCODE_ARBITER_KEY. This script knows nothing about any particular
# checkout — the arbiter is reached over HTTP like any other service.
if [[ -z "${CLAUDE_CODE_ARBITER_KEY:-}" ]]; then
    echo "claude-local: no arbiter client key. Set CLAUDE_CODE_ARBITER_KEY in ${_ENV_FILE}." >&2
    exit 1
fi

# Discover the resident model the same way opencode.sh does — the arbiter
# re-stamps the router's status with its own belief, so `loaded` is the
# arbiter's answer, not the router's.
get_loaded_model() {
    curl -sf "${CLAUDE_LOCAL_URL%/}/v1/models" \
        -H "Authorization: Bearer ${CLAUDE_CODE_ARBITER_KEY}" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
except Exception:
    # Arbiter unreachable, key rejected, or llama-server down: print nothing and
    # let the caller emit the actionable message rather than a traceback.
    raise SystemExit(0)
for m in data.get('data', []):
    if m.get('status', {}).get('value') == 'loaded':
        print(m['id'])
        break
" 2>/dev/null
}

MODEL="$(get_loaded_model || true)"
if [[ -z "$MODEL" ]]; then
    echo "claude-local: no model is loaded on ${CLAUDE_LOCAL_URL} (or the key was rejected)." >&2
    exit 1
fi

# All three model vars point at the SAME id so llama-server never swaps
# weights: ANTHROPIC_MODEL is the main loop, ANTHROPIC_DEFAULT_SONNET_MODEL is
# what the auto-permission-mode classifier resolves on a non-Anthropic
# upstream, and ANTHROPIC_DEFAULT_HAIKU_MODEL covers background/haiku-alias
# work. Any model variable NOT set here (ANTHROPIC_DEFAULT_OPUS_MODEL,
# ANTHROPIC_DEFAULT_FABLE_MODEL, CLAUDE_CODE_SUBAGENT_MODEL, …) resolves to a
# `claude-*` id, which the arbiter's quiet rewrite coerces to the resident
# model — so an unpinned alias degrades to the right model rather than 404ing.
export ANTHROPIC_BASE_URL="$CLAUDE_LOCAL_URL"
export ANTHROPIC_AUTH_TOKEN="$CLAUDE_CODE_ARBITER_KEY"
export ANTHROPIC_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"

# Keep a local-only session local.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1

echo "claude-local: ${MODEL} via ${CLAUDE_LOCAL_URL}" >&2
exec claude "$@"
