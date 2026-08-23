#!/bin/bash

ln -svf ~/.dotfiles/bash_profile ~/.bash_profile
ln -svf ~/.dotfiles/bashrc ~/.bashrc
cp ~/.dotfiles/gitconfig_base ~/.gitconfig
ln -svf ~/.dotfiles/vimrc ~/.vimrc
command -v oh-my-posh || curl -s https://ohmyposh.dev/install.sh | bash -s
ln -svf ~/.dotfiles/bashrc ~/.bashrc

mkdir -p ~/.vim/backups ~/.vim/swaps ~/.vim/undos
mkdir -p ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"

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

[ -x ~/.opencode/bin/opencode ] && ln -svf ~/.dotfiles/opencode.sh ~/.local/bin/opencode.sh
command -v claude >/dev/null 2>&1 && ln -svf ~/.dotfiles/claude-local.sh ~/.local/bin/claude-local.sh

# Agent skills — shared across Copilot CLI, Codex, Claude Code, and opencode
mkdir -p ~/.agents/skills ~/.claude/skills ~/.config/opencode/skills
for skill in ~/.dotfiles/skills/*/; do
    ln -svf "$skill" ~/.agents/skills/
    ln -svf "$skill" ~/.claude/skills/
    ln -svf "$skill" ~/.config/opencode/skills/
done

# Claude Code status line + global working prefs + declare-status helper + guard hook
mkdir -p ~/.claude/bin ~/.claude/status
ln -svf ~/.dotfiles/claude/statusline.sh  ~/.claude/statusline.sh
ln -svf ~/.dotfiles/claude/claude-status  ~/.claude/bin/claude-status
ln -svf ~/.dotfiles/claude/CLAUDE.md      ~/.claude/CLAUDE.md
ln -svf ~/.dotfiles/claude/guard-hook.sh  ~/.claude/bin/claude-guard
# Merge status-line config + guard hook into settings.json (idempotent; preserves
# machine-specific settings and unrelated hooks — existing claude-guard entries are
# replaced with the canonical pair rather than duplicated)
if command -v jq >/dev/null; then
    SETTINGS=~/.claude/settings.json
    [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
    tmp=$(mktemp)
    jq --arg guard '~/.claude/bin/claude-guard' '
      .statusLine = {type:"command", command:"~/.claude/statusline.sh", padding:0, refreshInterval:10}
      | .permissions = ((.permissions // {}) + {allow: (((.permissions.allow // []) + ["Bash(~/.claude/bin/claude-status:*)"]) | unique)})
      | .hooks = (.hooks // {})
      | .hooks.PreToolUse = (
          ((.hooks.PreToolUse // []) | map(select(((.hooks // []) | any(.command == $guard)) | not)))
          + [
              {matcher: "Bash", hooks: [{type: "command", command: $guard}]},
              {matcher: "Write|Edit|MultiEdit|NotebookEdit", hooks: [{type: "command", command: $guard}]}
            ]
        )
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
else
    echo "jq not found — add statusLine + guard hook to ~/.claude/settings.json manually (see claude/README.md)"
fi
