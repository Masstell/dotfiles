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
# Prints "<model-id><TAB><n_ctx>". n_ctx is the context llama-server ACTUALLY
# allocated for this model (meta.n_ctx), which --fit may have sized below the
# model's training context — so it is read, never assumed.
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
        ctx = (m.get('meta') or {}).get('n_ctx') or ''
        print(m['id'] + '\t' + str(ctx))
        break
" 2>/dev/null
}

IFS=$'\t' read -r MODEL MODEL_CTX < <(get_loaded_model)
if [[ -z "${MODEL:-}" ]]; then
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

# Pin the subagent model explicitly rather than leaning on the arbiter's quiet
# rewrite: the rewrite is a backstop, not a contract, and an explicit pin is one
# fewer thing to reason about when a subagent misbehaves.
export CLAUDE_CODE_SUBAGENT_MODEL="$MODEL"

# Keep a local-only session local.
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
export DISABLE_TELEMETRY=1
export DISABLE_ERROR_REPORTING=1

# Claude Code prepends an attribution string
# ("x-anthropic-billing-header: cc_version=...; cc_entrypoint=...;") to the
# SYSTEM PROMPT itself, not just to headers. On a 27B that is pure noise in
# every request's context, so drop it.
export CLAUDE_CODE_ATTRIBUTION_HEADER=0

# Pre-release beta body fields (context_management, output_config, ...) are
# aimed at Anthropic's own backend; llama.cpp has no reason to understand them
# and each one is a chance for a 400. Fewer moving parts against a local server.
export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1

# Local inference queues behind a single-slot gate and a cold model load can
# take minutes, so the client must not give up before the arbiter does (its own
# ceilings are a 600s VRAM wait and a 120s gate timeout).
export API_TIMEOUT_MS="${API_TIMEOUT_MS:-3000000}"

# Tell Claude Code the window llama-server actually allocated, so auto-compact
# fires against the real ceiling instead of a default that may be far larger.
# Only when the arbiter reported one — a guess here is worse than no value.
if [[ -n "${MODEL_CTX:-}" ]]; then
    export CLAUDE_CODE_MAX_CONTEXT_TOKENS="$MODEL_CTX"
fi

# Agent lockdown (post 2026-08-23 incident): local-model agents never hold the
# human's SSH agent socket — no path to PersonalKey signatures exists in this
# process. Supervised cross-box work uses `claude-trusted` instead.
unset SSH_AUTH_SOCK

# Agent git identity: where the box has an agent-github key (registered on
# GitHub as auth + signing), git traffic and commit signatures use it — a
# socketless session can still push and sign, as the agent, not the human.
if [[ -f "$HOME/.ssh/agent-github" ]]; then
    export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/agent-github -o IdentitiesOnly=yes"
    export GIT_CONFIG_COUNT=1
    export GIT_CONFIG_KEY_0=user.signingkey
    export GIT_CONFIG_VALUE_0="$HOME/.ssh/agent-github"
fi

echo "claude-local: ${MODEL} via ${CLAUDE_LOCAL_URL} (ctx ${MODEL_CTX:-unknown})" >&2
exec claude "$@"
