#!/usr/bin/env bash
set -euo pipefail

# Wrapper that lets you pick a model, loads it via the arbiter, registers
# a session (SESSION guard prevents swaps), patches opencode's config to
# point at the selected model, runs opencode in the foreground, then
# restores the config and deregisters on exit (Ctrl-C / crash safe).
#
# For remote access, set INFERENCE_HOST to the server's LAN IP:
#   INFERENCE_HOST=192.168.1.4 ./scripts/opencode.sh

INFERENCE_HOST="${INFERENCE_HOST:-192.168.1.4}"
ARBITER_URL="${ARBITER_URL:-http://${INFERENCE_HOST}:8100}"
LLAMA_URL="${LLAMA_URL:-http://${INFERENCE_HOST}:8084}"
ARBITER_API_KEY="${ARBITER_API_KEY:-}"

# Default model — used when --model is passed or as the preselected
# choice in the interactive picker
OPENCODE_MODEL="${OPENCODE_MODEL:-Qwen3.5-122B-A10B-Uncensored-HauhauCS-Aggressive-Q6_K_P}"

# Session TTL — heartbeats sent every half-TTL
SESSION_TTL="${SESSION_TTL:-3600}"
HEARTBEAT_INTERVAL=$(( SESSION_TTL / 2 ))

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

SESSION_ID=""
HEARTBEAT_PID=""
OPENCODE_CONFIG="${HOME}/.config/opencode/opencode.json"
OPENCODE_CONFIG_BAK=""
SELECTED_MODEL=""
# Default: use whatever model the arbiter has loaded.
# Pass --model-picker to show the interactive model picker instead.
USE_PICKER=false

# ── Arbiter HTTP helpers ─────────────────────────────────

arbiter_curl() {
    local method="$1"
    local path="$2"
    shift 2
    local auth_header=()
    if [[ -n "$ARBITER_API_KEY" ]]; then
        auth_header=(-H "Authorization: Bearer ${ARBITER_API_KEY}")
    fi
    curl -sf -X "$method" "${ARBITER_URL}${path}" \
        -H "Content-Type: application/json" \
        "${auth_header[@]}" \
        "$@"
}

get_loaded_model() {
    arbiter_curl GET /models | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    if m.get('status', {}).get('value') == 'loaded':
        print(m['id'])
        break
" 2>/dev/null
}

# ── Interactive model picker ─────────────────────────────

pick_model() {
    local models_json
    models_json=$(arbiter_curl GET /models) || {
        echo -e "${RED}Failed to fetch models from arbiter${NC}"
        exit 1
    }

    local -a MODEL_IDS
    mapfile -t MODEL_IDS < <(echo "$models_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
for m in data.get('data', []):
    print(m['id'])
" 2>/dev/null)

    if [[ ${#MODEL_IDS[@]} -eq 0 ]]; then
        echo -e "${RED}No models available${NC}"
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

    # Prefer the configured default, fall back to whatever is loaded
    local prompt_default="${default_idx:-$loaded_idx}"
    local prompt_hint=""
    if [[ -n "$prompt_default" ]]; then
        prompt_hint=" [${prompt_default}]"
    fi

    echo ""
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

# ── Patch opencode config to use the selected model ──────

patch_opencode_config() {
    if [[ ! -f "$OPENCODE_CONFIG" ]]; then
        echo -e "${YELLOW}No opencode config at ${OPENCODE_CONFIG} — skipping config patch${NC}"
        return
    fi

    OPENCODE_CONFIG_BAK="${OPENCODE_CONFIG}.bak"
    cp "$OPENCODE_CONFIG" "$OPENCODE_CONFIG_BAK"

    python3 -c "
import json, sys
cfg_path, model, llama_url = sys.argv[1], sys.argv[2], sys.argv[3]
with open(cfg_path) as f:
    cfg = json.load(f)
cfg['model'] = f'llamacpp/{model}'
cfg.setdefault('provider', {}).setdefault('llamacpp', {})
provider = cfg['provider']['llamacpp']
provider.setdefault('options', {})
provider['options']['baseURL'] = f'{llama_url}/v1'
provider.setdefault('models', {})
if model not in provider['models']:
    provider['models'][model] = {'name': model}
with open(cfg_path, 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" "$OPENCODE_CONFIG" "$SELECTED_MODEL" "$LLAMA_URL"
    echo -e "${DIM}Updated opencode config → ${SELECTED_MODEL} @ ${LLAMA_URL}${NC}"
}

restore_opencode_config() {
    if [[ -n "${OPENCODE_CONFIG_BAK:-}" && -f "${OPENCODE_CONFIG_BAK}" ]]; then
        mv "$OPENCODE_CONFIG_BAK" "$OPENCODE_CONFIG"
    fi
}

# ── Register session with arbiter ────────────────────────

register_session() {
    echo -e "${CYAN}Registering session with arbiter (model=${SELECTED_MODEL})...${NC}"

    local holder payload response
    holder="opencode@$(whoami)"
    payload=$(python3 -c 'import json,sys; print(json.dumps({"holder": sys.argv[1], "model": sys.argv[2], "ttl": int(sys.argv[3]), "timeout": 300}))' \
        "$holder" "$SELECTED_MODEL" "$SESSION_TTL")

    response=$(arbiter_curl POST /sessions/register \
        -d "$payload" \
        --max-time 310) || {
        echo -e "${RED}Failed to register session with arbiter${NC}"
        echo -e "${YELLOW}Is the arbiter running at ${ARBITER_URL}?${NC}"
        exit 1
    }

    SESSION_ID=$(echo "$response" | python3 -c "import sys,json; print(json.load(sys.stdin)['session']['id'])" 2>/dev/null) || {
        echo -e "${RED}Failed to parse session response: ${response}${NC}"
        exit 1
    }

    echo -e "${GREEN}✓ Session registered: ${SESSION_ID}${NC}"
    echo -e "${GREEN}  Guard: SESSION (model is protected from swaps)${NC}"
}

# ── Deregister session ───────────────────────────────────

deregister_session() {
    if [[ -z "$SESSION_ID" ]]; then
        return
    fi
    echo ""
    echo -e "${CYAN}Deregistering session ${SESSION_ID}...${NC}"
    arbiter_curl POST /sessions/deregister \
        -d "$(python3 -c 'import json,sys; print(json.dumps({"session_id": sys.argv[1]}))' "$SESSION_ID")" \
        --max-time 10 2>/dev/null || {
        echo -e "${YELLOW}Deregister failed (session may already be expired)${NC}"
        return
    }
    echo -e "${GREEN}✓ Session deregistered — default model will be restored${NC}"
    SESSION_ID=""
}

# ── Heartbeat loop ───────────────────────────────────────

start_heartbeat() {
    (
        while true; do
            sleep "$HEARTBEAT_INTERVAL"
            local http_code
            http_code=$(curl -sf -o /dev/null -w "%{http_code}" \
                -X POST "${ARBITER_URL}/sessions/renew" \
                -H "Content-Type: application/json" \
                ${ARBITER_API_KEY:+-H "Authorization: Bearer ${ARBITER_API_KEY}"} \
                -d "{\"session_id\": \"${SESSION_ID}\"}" \
                --max-time 10 2>/dev/null) || http_code="000"

            if [[ "$http_code" == "404" ]]; then
                # Session terminated externally — signal process group
                kill -- -$$ 2>/dev/null || true
                break
            elif [[ "$http_code" != "200" ]]; then
                echo "[$(date)] Heartbeat warning: HTTP ${http_code}" >> /tmp/opencode-heartbeat.log
            fi
        done
    ) &
    HEARTBEAT_PID=$!
}

stop_heartbeat() {
    if [[ -n "$HEARTBEAT_PID" ]]; then
        kill "$HEARTBEAT_PID" 2>/dev/null || true
        wait "$HEARTBEAT_PID" 2>/dev/null || true
        HEARTBEAT_PID=""
    fi
}

# ── Cleanup on exit ──────────────────────────────────────

cleanup() {
    stop_heartbeat
    restore_opencode_config
    deregister_session
}

trap cleanup EXIT

# ── Parse arguments ──────────────────────────────────────

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
            echo "  By default, uses whatever model the arbiter currently has loaded."
            echo "  Registers a SESSION guard (prevents VRAM swaps) and launches opencode."
            echo ""
            echo "  --model-picker    Show an interactive model picker instead of using"
            echo "                    the currently loaded model."
            echo "  --model NAME      Use a specific model by name (skips picker)."
            echo ""
            echo "Environment:"
            echo "  ARBITER_URL       Arbiter endpoint (default: http://\${INFERENCE_HOST}:8100)"
            echo "  LLAMA_URL         llama-server endpoint (default: http://\${INFERENCE_HOST}:8084)"
            echo "  ARBITER_API_KEY   API key for arbiter auth"
            echo "  OPENCODE_MODEL    Default model highlighted in picker (default: Qwen3.5-122B...)"
            echo "  SESSION_TTL       Session TTL in seconds (default: 3600)"
            exit 0
            ;;
        *)
            OPENCODE_ARGS+=("$1")
            shift
            ;;
    esac
done

# ── Check arbiter ────────────────────────────────────────

arbiter_curl GET /health >/dev/null || {
    echo -e "${RED}Arbiter not reachable at ${ARBITER_URL}${NC}"
    echo -e "${DIM}Set ARBITER_URL if it's running elsewhere${NC}"
    exit 1
}

# ── Select model ─────────────────────────────────────────

if [[ -n "$SELECTED_MODEL" ]]; then
    : # explicit --model NAME, use as-is
elif [[ "$USE_PICKER" == "true" ]]; then
    pick_model
else
    # Default: use whatever is currently loaded
    SELECTED_MODEL=$(get_loaded_model)
    if [[ -z "$SELECTED_MODEL" ]]; then
        echo -e "${RED}No model currently loaded in the arbiter.${NC}"
        echo -e "${DIM}Load a model first, or use --model-picker to select and load one.${NC}"
        exit 1
    fi
    echo -e "${DIM}Using loaded model: ${SELECTED_MODEL}${NC}"
fi

# ── Patch opencode config, register session, start heartbeat ──

patch_opencode_config
register_session
start_heartbeat

echo ""
echo -e "${GREEN}✓ Ready — launching opencode${NC}"
echo ""

# Run opencode in the FOREGROUND so it has proper terminal control.
# TUI apps need to be the foreground process to handle mouse events,
# key sequences, and terminal resize signals correctly.
"${HOME}/.opencode/bin/opencode" "${OPENCODE_ARGS[@]+"${OPENCODE_ARGS[@]}"}"
