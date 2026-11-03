#!/usr/bin/env bash
set -euo pipefail

# `pi` — the pi coding agent (https://pi.dev) on the local GPU, inside a
# bubblewrap sandbox. install.sh links this to ~/.local/bin/pi, so it is the
# only `pi` on PATH; the real binary lives under ~/.local/share/pi-agent.
#
# What the sandbox enforces (kernel, not the model):
#   - writable: the project (git toplevel of $PWD, else $PWD), ~/.pi/agent
#     sessions, tool caches, a private /tmp. Everything else is read-only,
#     including all of /mnt/raid.
#   - hidden: ~/.ssh, ~/.gnupg, ~/.aws, ~/.docker, gh/op/Claude/Codex/Gemini
#     credentials, .env key files, shell history, the SSH agent, the user's
#     runtime sockets. The environment is rebuilt from an allowlist.
#   - pi's agent dir is a throwaway overlay apart from sessions, so the agent
#     can't plant settings, trust, or extensions that switch its classifier
#     off next time. (In-session /settings, /trust and /login changes don't
#     persist either: make those with PI_NOSANDBOX=1 or edit the files.)
#   - no privilege gain (no sudo/setuid); own PID namespace.
# What it deliberately does NOT do: Docker (the socket is reachable — full
# docker, judged by the classifier) and the network (shared with the host).
#
#   pi                       interactive, sandboxed
#   pi -p "list the files"   print mode
#   PI_RW=/mnt/raid/Foundry pi    extra writable paths (colon-separated)
#   PI_LOCAL_READONLY=1 pi   plan mode: edits and non-read-only bash blocked
#   PI_NOSANDBOX=1 pi        no sandbox (loud warning; classifier switches to
#                            the stricter host policy)

PI_BIN="${HOME}/.local/share/pi-agent/current/bin/pi"
AGENT_DIR="${PI_CODING_AGENT_DIR:-${HOME}/.pi/agent}"

# Resolve symlinks (~/.local/bin/pi -> this file) to find the extensions.
_src="${BASH_SOURCE[0]}"
while [[ -L "$_src" ]]; do
    _dir="$(cd -P "$(dirname "$_src")" && pwd)"
    _src="$(readlink "$_src")"
    [[ "$_src" != /* ]] && _src="$_dir/$_src"
done
PI_CODE_DIR="$(cd -P "$(dirname "$_src")" && pwd)"

if [[ ! -x "$PI_BIN" ]]; then
    echo "pi: not installed at ${PI_BIN} — run ~/.dotfiles/install.sh" >&2
    exit 1
fi

# Already inside the sandbox (pi started from pi's own shell): just run it.
if [[ "${PI_SANDBOX:-}" == 1 ]]; then
    exec "$PI_BIN" "$@"
fi

# --- Keys --------------------------------------------------------------------
# Read in a subshell so nothing else from the env files leaks into this
# process. They reach pi on fd 3 (secrets.ts reads and closes it), never via
# the environment that every bash command would inherit.
read_keys() {
    (
        set +u
        for f in "${HOME}/.dotfiles/.env" "${HOME}/.config/pi-agent/env"; do
            # shellcheck disable=SC1090
            [[ -f "$f" ]] && { set -a; source "$f"; set +a; }
        done
        printf 'PI_ARBITER_KEY=%s\nBRAVE_API_KEY=%s\n' \
            "${PI_ARBITER_KEY:-${OPENCODE_ARBITER_KEY:-}}" "${BRAVE_API_KEY:-}"
    )
}
KEYS="$(read_keys)"
if [[ -z "$(sed -n 's/^PI_ARBITER_KEY=//p' <<<"$KEYS")" ]]; then
    echo "pi: no arbiter key. Set PI_ARBITER_KEY in ~/.dotfiles/.env (or ~/.config/pi-agent/env)." >&2
    exit 1
fi

if [[ "${PI_NOSANDBOX:-}" == 1 ]]; then
    echo "pi: ⚠️  PI_NOSANDBOX=1 — running WITHOUT the sandbox; the classifier is the only guard." >&2
    PI_SECRETS_FD=3 PI_CODE_DIR="$PI_CODE_DIR" PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 \
        exec "$PI_BIN" "$@" 3<<<"$KEYS"
fi

if ! command -v bwrap >/dev/null 2>&1; then
    echo "pi: bubblewrap (bwrap) is not installed — it comes from the Ansible vm_base role (pi_agent)." >&2
    echo "    PI_NOSANDBOX=1 runs without it." >&2
    exit 1
fi

# --- Project -------------------------------------------------------------------
PROJECT="$(git -C "$PWD" rev-parse --show-toplevel 2>/dev/null || pwd -P)"
case "$PROJECT" in
    / | "$HOME" | /home | /root)
        echo "pi: refusing to make ${PROJECT} writable — cd into a project first." >&2
        exit 1 ;;
esac
if [[ "$HOME/" == "$PROJECT/"* ]]; then
    echo "pi: ${PROJECT} contains your home directory — cd into a project first." >&2
    exit 1
fi

args=(
    --ro-bind / /
    --dev /dev
    --proc /proc
    --tmpfs /tmp
    --tmpfs /var/tmp
    --unshare-pid --unshare-ipc --unshare-cgroup-try
    --die-with-parent
)
# The kernel lets a sandboxed process inject keystrokes into the parent
# terminal (TIOCSTI) unless that is disabled; only then is a new session needed.
if [[ "$(sysctl -n dev.tty.legacy_tiocsti 2>/dev/null || echo 1)" != 0 ]]; then
    args+=(--new-session)
fi

hide_dir()  { [[ -d "$1" && ! -L "$1" ]] && args+=(--tmpfs "$1"); return 0; }
hide_file() { [[ -f "$1" ]] && args+=(--ro-bind /dev/null "$1"); return 0; }

# Credentials and anything that holds them.
for d in .ssh .gnupg .aws .azure .kube .docker .config/gh .config/op \
         .config/gcloud .claude .codex .gemini .config/opencode \
         .local/share/opencode .config/pi-agent .password-store; do
    hide_dir "${HOME}/${d}"
done
for f in .claude.json .netrc .git-credentials .npmrc .pypirc .bash_history \
         .zsh_history .python_history .node_repl_history .psql_history \
         .mysql_history .lesshst .viminfo; do
    hide_file "${HOME}/${f}"
done
# The dotfiles env file (keys) — hidden at its real path.
_dotenv="$(readlink -f "${HOME}/.dotfiles" 2>/dev/null || true)/.env"
hide_file "$_dotenv"
# Per-user runtime sockets (systemd user bus, gpg-agent, forwarded agents).
hide_dir "/run/user/$(id -u)"

# pi's own state. The agent dir gets a throwaway overlay: pi can write and
# lock its config freely in-session, but every write lands in a tmpfs that is
# discarded at exit — so settings, trust, extensions, packages or system
# prompt files the agent plants never reach the next launch. Only sessions
# persist, through a real writable mount on top.
mkdir -p "${AGENT_DIR}/sessions"
args+=(
    --overlay-src "$AGENT_DIR" --tmp-overlay "$AGENT_DIR"
    --bind "${AGENT_DIR}/sessions" "${AGENT_DIR}/sessions"
)

# Tool caches stay writable so installs and builds work.
for d in .cache .npm .cargo .rustup .local/share/uv .local/share/pnpm go/pkg; do
    [[ -d "${HOME}/${d}" ]] && args+=(--bind "${HOME}/${d}" "${HOME}/${d}")
done

# The project, last, so it wins over anything above it — except the parts of
# git that run code later, outside the sandbox, when the human next uses the
# repo: hooks, and config (core.hooksPath, core.fsmonitor, aliases).
args+=(--bind "$PROJECT" "$PROJECT")
if [[ -d "$PROJECT/.git" ]]; then
    mkdir -p "$PROJECT/.git/hooks"
    args+=(--ro-bind "$PROJECT/.git/hooks" "$PROJECT/.git/hooks")
    [[ -f "$PROJECT/.git/config" ]] && args+=(--ro-bind "$PROJECT/.git/config" "$PROJECT/.git/config")
fi
IFS=: read -r -a _extra <<<"${PI_RW:-}"
for p in "${_extra[@]}"; do
    [[ -n "$p" ]] || continue
    p="$(readlink -f "$p")"
    [[ -e "$p" ]] || { echo "pi: PI_RW path does not exist: $p" >&2; exit 1; }
    echo "pi: extra writable path: $p" >&2
    args+=(--bind "$p" "$p")
done

# --- Environment: rebuilt from an allowlist -------------------------------------
args+=(--clearenv)
for v in HOME USER LOGNAME SHELL PATH LANG LANGUAGE LC_ALL LC_CTYPE TERM \
         COLORTERM TERM_PROGRAM TERM_PROGRAM_VERSION TMUX TMUX_PANE EDITOR \
         VISUAL TZ DOCKER_HOST NO_COLOR PI_CODING_AGENT_DIR PI_LOCAL_READONLY PI_LOCAL_POLICY \
         PI_ADVISOR_SWAP_COOLDOWN_S PI_CLASSIFIER_DEADLINE_MS PI_ARBITER_URL \
         PI_ARBITER_CTX; do
    [[ -n "${!v:-}" ]] && args+=(--setenv "$v" "${!v}")
done
args+=(
    --setenv PI_SANDBOX 1
    --setenv PI_CODE_DIR "$PI_CODE_DIR"
    --setenv PI_PROJECT_DIR "$PROJECT"
    --setenv PI_SECRETS_FD 3
    --setenv PI_SKIP_VERSION_CHECK 1
    --setenv PI_TELEMETRY 0
    --chdir "$PWD"
)

[[ "${PI_LOCAL_READONLY:-}" =~ ^(1|true|yes|on)$ ]] && echo "pi: READ-ONLY / plan mode is ON." >&2
exec bwrap "${args[@]}" -- "$PI_BIN" "$@" 3<<<"$KEYS"
