#!/usr/bin/env bash
set -euo pipefail

# Wrapper that patches opencode's config to use the currently loaded
# arbiter-backed OpenAI-compatible model, runs opencode in the foreground,
# then restores the config on exit.
#
# For remote access, set OPENCODE_LLM_URL to an OpenAI-compatible arbiter endpoint:
#   OPENCODE_LLM_URL=https://ai.mswensen.com opencode.sh

_ENV_FILE="${HOME}/.dotfiles/.env"
if [[ -f "$_ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$_ENV_FILE"
    set +a
fi

OPENCODE_LLM_URL="${OPENCODE_LLM_URL:-${LLAMA_URL:-https://ai.mswensen.com}}"
OPENCODE_ARBITER_KEY="${OPENCODE_ARBITER_KEY:-${LLAMA_API_KEY:-}}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
DIM='\033[0;90m'
NC='\033[0m'

OPENCODE_BIN="${HOME}/.opencode/bin/opencode"
if [[ ! -x "$OPENCODE_BIN" ]]; then
    echo -e "${RED}opencode not found at ${OPENCODE_BIN}${NC}"
    echo -e "${DIM}Install with: curl -fsSL https://opencode.ai/install | bash${NC}"
    exit 1
fi

OPENCODE_CONFIG="${HOME}/.config/opencode/opencode.json"
OPENCODE_CONFIG_BAK=""
SELECTED_MODEL=""

get_loaded_model() {
    curl -sf "${OPENCODE_LLM_URL%/}/v1/models" \
        -H "Authorization: Bearer ${OPENCODE_ARBITER_KEY}" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    if m.get('status', {}).get('value') == 'loaded':
        print(m['id'])
        break
" 2>/dev/null || {
        echo -e "${RED}Failed to fetch models from ${OPENCODE_LLM_URL}${NC}" >&2
        echo -e "${DIM}Check OPENCODE_ARBITER_KEY in ${_ENV_FILE}.${NC}" >&2
        exit 1
    }
}

patch_opencode_config() {
    if [[ ! -f "$OPENCODE_CONFIG" ]]; then
        echo -e "${YELLOW}No opencode config at ${OPENCODE_CONFIG} — skipping config patch${NC}"
        return
    fi

    OPENCODE_CONFIG_BAK="${OPENCODE_CONFIG}.bak"
    cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG_BAK"

    python3 -c "
import json, sys
cfg_path, model, llm_url, api_key = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(cfg_path) as f:
    cfg = json.load(f)
cfg['model'] = f'llamacpp/{model}'
cfg.setdefault('provider', {}).setdefault('llamacpp', {})
provider = cfg['provider']['llamacpp']
provider.setdefault('options', {})
provider['options']['baseURL'] = f'{llm_url.rstrip(\"/\")}/v1'
provider['options']['apiKey'] = api_key
provider.setdefault('models', {})
if model not in provider['models']:
    provider['models'][model] = {'name': model}
with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\\n')
" "$OPENCODE_CONFIG" "$SELECTED_MODEL" "$OPENCODE_LLM_URL" "$OPENCODE_ARBITER_KEY"
    echo -e "${DIM}Updated opencode config -> ${SELECTED_MODEL} @ ${OPENCODE_LLM_URL}${NC}"
}

restore_opencode_config() {
    if [[ -n "${OPENCODE_CONFIG_BAK:-}" && -f "${OPENCODE_CONFIG_BAK}" ]]; then
        mv "$OPENCODE_CONFIG_BAK" "$OPENCODE_CONFIG"
    fi
}

cleanup() {
    restore_opencode_config
}
trap cleanup EXIT

OPENCODE_ARGS=()
while [[ $# -gt 0 ]]; do
    case "$1" in
        --help|-h)
            echo "Usage: $0 [opencode args...]"
            echo ""
            echo "  Uses whatever model the arbiter reports as loaded."
            echo ""
            echo "Environment:"
            echo "  OPENCODE_LLM_URL      OpenAI-compatible endpoint (default: https://ai.mswensen.com)"
            echo "  OPENCODE_ARBITER_KEY  Per-instance arbiter inference key"
            exit 0
            ;;
        *)
            OPENCODE_ARGS+=("$1")
            shift
            ;;
    esac
done

if [[ -z "$OPENCODE_ARBITER_KEY" ]]; then
    echo -e "${RED}OPENCODE_ARBITER_KEY is required for inference via ${OPENCODE_LLM_URL}${NC}"
    echo -e "${DIM}Create a per-instance arbiter key and store it in ${_ENV_FILE}.${NC}"
    exit 1
fi

SELECTED_MODEL=$(get_loaded_model)
if [[ -z "$SELECTED_MODEL" ]]; then
    echo -e "${RED}No model is currently loaded according to ${OPENCODE_LLM_URL}/v1/models.${NC}"
    exit 1
fi
echo -e "${DIM}Using loaded model: ${SELECTED_MODEL}${NC}"

patch_opencode_config

echo ""
echo -e "${GREEN}Ready — launching opencode${NC}"
echo ""

"$OPENCODE_BIN" "${OPENCODE_ARGS[@]+"${OPENCODE_ARGS[@]}"}"
