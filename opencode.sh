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
OPENCODE_MODEL="${OPENCODE_MODEL:-Qwen3.5-122B-A10B-Uncensored-HauhauCS-Aggressive-Q6_K_P}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[0;90m'
BOLD='\033[1m'
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
USE_PICKER=false
MODELS_JSON=""

inference_curl() {
    local method="$1"
    local path="$2"
    shift 2
    curl -sf -X "$method" "${OPENCODE_LLM_URL%/}${path}" \
        -H "Authorization: Bearer ${OPENCODE_ARBITER_KEY}" \
        "$@"
}

load_models_json() {
    MODELS_JSON=$(inference_curl GET /v1/models) || {
        echo -e "${RED}Failed to fetch models from ${OPENCODE_LLM_URL}${NC}"
        echo -e "${DIM}Check OPENCODE_ARBITER_KEY in ${_ENV_FILE}.${NC}"
        exit 1
    }
}

get_loaded_model() {
    printf '%s' "$MODELS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    if m.get('status', {}).get('value') == 'loaded':
        print(m['id'])
        break
" 2>/dev/null
}

pick_model() {
    local -a MODEL_IDS
    mapfile -t MODEL_IDS < <(printf '%s' "$MODELS_JSON" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    print(m['id'])
" 2>/dev/null)

    if [[ ${#MODEL_IDS[@]} -eq 0 ]]; then
        echo -e "${RED}No models available from ${OPENCODE_LLM_URL}${NC}"
        exit 1
    fi

    local loaded
    loaded=$(get_loaded_model)

    echo ""
    echo -e "${BOLD}Available models:${NC}"
    echo ""

    local loaded_idx="" default_idx=""
    for i in "${!MODEL_IDS[@]}"; do
        local num=$((i + 1))
        local name="${MODEL_IDS[$i]}"
        local markers=""
        if [[ "$name" == "$loaded" ]]; then
            markers+=" [LOADED]"
            loaded_idx=$num
        fi
        if [[ "$name" == "$OPENCODE_MODEL" ]]; then
            markers+=" [DEFAULT]"
            default_idx=$num
        fi
        if [[ -n "$markers" ]]; then
            echo -e "  ${GREEN}${num}) ${name}${markers}${NC}"
        else
            echo -e "  ${DIM}${num}) ${name}${NC}"
        fi
    done

    local prompt_default="${loaded_idx:-$default_idx}"
    local prompt_hint=""
    if [[ -n "$prompt_default" ]]; then
        prompt_hint=" [${prompt_default}]"
    fi

    echo ""
    echo -e "${DIM}Note: this wrapper does not load or reserve models; selecting an unloaded model may fail.${NC}"
    read -r -p "$(echo -e "${CYAN}Select model${prompt_hint}: ${NC}")" choice

    if [[ -z "$choice" && -n "$prompt_default" ]]; then
        choice=$prompt_default
    fi

    if ! [[ "$choice" =~ ^[0-9]+$ ]] || (( choice < 1 || choice > ${#MODEL_IDS[@]} )); then
        echo -e "${RED}Invalid selection${NC}"
        exit 1
    fi

    SELECTED_MODEL="${MODEL_IDS[$((choice - 1))]}"
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
        --model-picker)
            USE_PICKER=true
            shift
            ;;
        --model)
            SELECTED_MODEL="$2"
            shift 2
            ;;
        --help|-h)
            echo "Usage: $0 [--model-picker] [--model MODEL_NAME] [opencode args...]"
            echo ""
            echo "  By default, uses whatever model the OpenAI-compatible endpoint reports as loaded."
            echo "  Does not register sessions, reserve the GPU, or request model changes."
            echo ""
            echo "  --model-picker    Show an interactive model picker. Does not load models."
            echo "  --model NAME      Use a specific model by name. Does not load models."
            echo ""
            echo "Environment:"
            echo "  OPENCODE_LLM_URL      OpenAI-compatible endpoint (default: https://ai.mswensen.com)"
            echo "  OPENCODE_ARBITER_KEY  Per-instance arbiter inference key"
            echo "  OPENCODE_MODEL        Default model highlighted in picker"
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

load_models_json

if [[ -n "$SELECTED_MODEL" ]]; then
    :
elif [[ "$USE_PICKER" == "true" ]]; then
    pick_model
else
    SELECTED_MODEL=$(get_loaded_model)
    if [[ -z "$SELECTED_MODEL" ]]; then
        echo -e "${RED}No model is currently loaded according to ${OPENCODE_LLM_URL}/v1/models.${NC}"
        echo -e "${DIM}Load a model elsewhere, or use --model to force a model name.${NC}"
        exit 1
    fi
    echo -e "${DIM}Using loaded model: ${SELECTED_MODEL}${NC}"
fi

patch_opencode_config

echo ""
echo -e "${GREEN}Ready — launching opencode${NC}"
echo ""

"$OPENCODE_BIN" "${OPENCODE_ARGS[@]+"${OPENCODE_ARGS[@]}"}"
