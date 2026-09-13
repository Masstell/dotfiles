#!/bin/bash
set -euo pipefail

# Shell configuration and launchers use this stable path, even when the checkout
# was cloned elsewhere (for example, ~/dotfiles).
DOTFILES_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
if [ "$DOTFILES_DIR" != "$HOME/.dotfiles" ]; then
    if [ -e "$HOME/.dotfiles" ] || [ -L "$HOME/.dotfiles" ]; then
        if [ "$(cd -- "$HOME/.dotfiles" && pwd -P)" != "$DOTFILES_DIR" ]; then
            echo "~/.dotfiles already points to another checkout; run its installer or move it first." >&2
            exit 1
        fi
    else
        ln -sv "$DOTFILES_DIR" "$HOME/.dotfiles"
    fi
fi

mkdir -p "$HOME/.local/bin"
export PATH="$HOME/.local/bin:$PATH"

ln -svfn ~/.dotfiles/bash_profile ~/.bash_profile
ln -svfn ~/.dotfiles/bashrc ~/.bashrc
# Global git hooks (git-hooks/): every hook name dispatches to hooks.d/<name>
# then the repo's own .git/hooks/<name>. Currently strips Co-authored-by
# trailers from all commit messages so no harness can add bot attribution.
git config --global core.hooksPath ~/.dotfiles/git-hooks
ln -svfn ~/.dotfiles/vimrc ~/.vimrc
if ! command -v oh-my-posh >/dev/null 2>&1; then
    # Minimal Ubuntu/Debian installs may lack unzip, which the upstream
    # installer needs to extract themes.
    if ! command -v unzip >/dev/null 2>&1; then
        if command -v apt-get >/dev/null 2>&1; then
            echo "installing unzip (required by oh-my-posh)..."
            if [ "$EUID" -eq 0 ]; then
                apt-get install -y unzip || echo "unzip auto-install failed" >&2
            elif command -v sudo >/dev/null 2>&1; then
                sudo apt-get install -y unzip || echo "unzip auto-install failed" >&2
            fi
        fi
    fi
    if ! command -v unzip >/dev/null 2>&1; then
        echo "unzip is missing — install it and rerun ./install.sh to enable oh-my-posh" >&2
    elif ! curl -fsSL https://ohmyposh.dev/install.sh | bash -s -- -d "$HOME/.local/bin"; then
        echo "oh-my-posh auto-install failed — using the fallback shell prompt" >&2
    fi
fi

mkdir -p ~/.vim/backups ~/.vim/swaps ~/.vim/undos

# jq — required by the Claude status line and the settings.json merge below.
# Grab the standalone binary (no sudo); mirrors the sudo-less oh-my-posh install above.
if ! command -v jq >/dev/null; then
    case "$(uname -s)-$(uname -m)" in
        Linux-x86_64)  jqbin=jq-linux-amd64 ;;
        Linux-aarch64) jqbin=jq-linux-arm64 ;;
        Darwin-arm64)  jqbin=jq-macos-arm64 ;;
        Darwin-x86_64) jqbin=jq-macos-amd64 ;;
        *)             jqbin= ;;
    esac
    if [ -n "$jqbin" ] && curl -fsSL -o ~/.local/bin/jq \
        "https://github.com/jqlang/jq/releases/latest/download/$jqbin"; then
        chmod +x ~/.local/bin/jq
    else
        rm -f ~/.local/bin/jq
        echo "could not auto-install jq (unknown platform or download failed) — install it manually"
    fi
fi

[ -x ~/.opencode/bin/opencode ] && ln -svfn ~/.dotfiles/opencode.sh ~/.local/bin/opencode.sh
command -v claude >/dev/null 2>&1 && ln -svfn ~/.dotfiles/claude-local.sh ~/.local/bin/claude-local.sh
command -v claude >/dev/null 2>&1 && ln -svfn ~/.dotfiles/claude-trusted.sh ~/.local/bin/claude-trusted
# docker read-only shim — only where the docker-ro wrapper is deployed (ansible
# hardening role); elsewhere plain docker stays untouched.
[ -x /usr/local/sbin/docker-ro ] && ln -svfn ~/.dotfiles/docker-shim.sh ~/.local/bin/docker
# pi coding agent (pi.dev) — the local-model launcher + classifier live in
# pi-code/. Auto-install pi if missing (npm global, --ignore-scripts, mirroring
# the official installer minus its pipe-to-shell), then symlink the pi binary
# into ~/.local/bin — npm's global prefix (~/.npm-global/bin) is NOT on PATH,
# but ~/.local/bin is (see bashrc). Finally symlink the pi-local launcher.
if ! command -v pi >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    NPMBIN="$(npm config get prefix 2>/dev/null)/bin"
    if [ ! -x "$NPMBIN/pi" ] && command -v npm >/dev/null; then
        echo "installing pi (pi.dev coding agent) via npm..."
        # PINNED: pi is pre-1.0 (~weekly releases) and the tool_call hook API
        # the classifier relies on may shift. An unpinned upgrade that drops the
        # hook would silently stop gating bash. Bump deliberately after
        # re-checking pi-code/extensions/ against the new release.
        npm install -g --ignore-scripts @earendil-works/pi-coding-agent@0.84.2 \
            || echo "pi auto-install failed — install manually: https://pi.dev"
        NPMBIN="$(npm config get prefix 2>/dev/null)/bin"
    fi
    [ -x "$NPMBIN/pi" ] && ln -svfn "$NPMBIN/pi" ~/.local/bin/pi
fi
command -v pi >/dev/null 2>&1 && ln -svfn ~/.dotfiles/pi-code/pi-local.sh ~/.local/bin/pi-local

# Agent skills — shared across Copilot CLI, Codex, Claude Code, and opencode
mkdir -p ~/.agents/skills ~/.claude/skills ~/.config/opencode/skills
for skill in "$DOTFILES_DIR"/skills/*; do
    [ -d "$skill" ] || continue
    skill_name="${skill##*/}"
    ln -svfn "$skill" "$HOME/.agents/skills/$skill_name"
    ln -svfn "$skill" "$HOME/.claude/skills/$skill_name"
    ln -svfn "$skill" "$HOME/.config/opencode/skills/$skill_name"
done

# Claude Code status line + global working prefs + declare-status helper + guard hook
mkdir -p ~/.claude/bin ~/.claude/status
ln -svfn ~/.dotfiles/claude/statusline.sh  ~/.claude/statusline.sh
ln -svfn ~/.dotfiles/claude/claude-status  ~/.claude/bin/claude-status
ln -svfn ~/.dotfiles/claude/CLAUDE.md      ~/.claude/CLAUDE.md
ln -svfn ~/.dotfiles/claude/guard-hook.sh  ~/.claude/bin/claude-guard
# Merge status-line config + guard hook + no-attribution into settings.json
# (attribution = official off-switch for Co-Authored-By / PR footer / session
# URL; the git-hooks/ commit-msg hook is the backstop if this key is ever
# deprecated). Idempotent; preserves
# machine-specific settings and unrelated hooks — existing claude-guard entries are
# replaced with the canonical pair rather than duplicated)
if command -v jq >/dev/null; then
    SETTINGS=~/.claude/settings.json
    [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
    tmp=$(mktemp "$SETTINGS.tmp.XXXXXX")
    trap 'rm -f -- "$tmp"' EXIT
    # Guard-hook re-registration is surgical: strip only hook COMMANDS that are the
    # guard (matched by ~-form, $HOME-expanded form, or basename — a prior run may
    # have stored either spelling), keep any sibling hooks in the same entry, drop
    # entries left empty, then append the canonical pair. Never touches unrelated
    # hooks; never duplicates.
    jq --arg guard '~/.claude/bin/claude-guard' --arg guard_abs "$HOME/.claude/bin/claude-guard" '
      def is_guard: ((.command // "") | (. == $guard or . == $guard_abs or endswith("/claude-guard")));
      .statusLine = {type:"command", command:"~/.claude/statusline.sh", padding:0, refreshInterval:10}
      | .attribution = {commit:"", pr:"", sessionUrl:false}
      | .permissions = ((.permissions // {}) + {allow: (((.permissions.allow // []) + ["Bash(~/.claude/bin/claude-status:*)"]) | unique)})
      | .hooks = (.hooks // {})
      | .hooks.PreToolUse = (
          ((.hooks.PreToolUse // [])
            | map(.hooks = ((.hooks // []) | map(select(is_guard | not))))
            | map(select((.hooks | length) > 0)))
          + [
              {matcher: "Bash", hooks: [{type: "command", command: $guard}]},
              {matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{type: "command", command: $guard}]}
            ]
        )
    ' "$SETTINGS" > "$tmp"
    mv "$tmp" "$SETTINGS"
    trap - EXIT
else
    echo "jq not found — add statusLine + guard hook to ~/.claude/settings.json manually (see claude/README.md)"
fi
