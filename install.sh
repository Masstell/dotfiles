#!/bin/bash

ln -svf ~/.dotfiles/bash_profile ~/.bash_profile
ln -svf ~/.dotfiles/bashrc ~/.bashrc
cp ~/.dotfiles/gitconfig_base ~/.gitconfig
ln -svf ~/.dotfiles/vimrc ~/.vimrc
command -v oh-my-posh || curl -s https://ohmyposh.dev/install.sh | bash -s
ln -svf ~/.dotfiles/bashrc ~/.bashrc

mkdir -p ~/.vim/backups ~/.vim/swaps ~/.vim/undos
mkdir -p ~/.local/bin
[ -x ~/.opencode/bin/opencode ] && ln -svf ~/.dotfiles/opencode.sh ~/.local/bin/opencode.sh
command -v claude >/dev/null 2>&1 && ln -svf ~/.dotfiles/claude-local.sh ~/.local/bin/claude-local.sh

# Agent skills — shared across Copilot CLI, Codex, Claude Code, and opencode
mkdir -p ~/.agents/skills ~/.claude/skills ~/.config/opencode/skills
for skill in ~/.dotfiles/skills/*/; do
    ln -svf "$skill" ~/.agents/skills/
    ln -svf "$skill" ~/.claude/skills/
    ln -svf "$skill" ~/.config/opencode/skills/
done

# Claude Code status line + global working prefs + declare-status helper
mkdir -p ~/.claude/bin ~/.claude/status
ln -svf ~/.dotfiles/claude/statusline.sh  ~/.claude/statusline.sh
ln -svf ~/.dotfiles/claude/claude-status  ~/.claude/bin/claude-status
ln -svf ~/.dotfiles/claude/CLAUDE.md      ~/.claude/CLAUDE.md
# Merge status-line config into settings.json (idempotent; preserves machine-specific settings)
if command -v jq >/dev/null; then
    SETTINGS=~/.claude/settings.json
    [ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
    tmp=$(mktemp)
    jq '
      .statusLine = {type:"command", command:"~/.claude/statusline.sh", padding:0, refreshInterval:10}
      | .permissions = ((.permissions // {}) + {allow: (((.permissions.allow // []) + ["Bash(~/.claude/bin/claude-status:*)"]) | unique)})
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
else
    echo "jq not found — add statusLine to ~/.claude/settings.json manually (see claude/README.md)"
fi
