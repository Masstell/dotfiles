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

# Agent skills — shared across Copilot CLI, Codex, Claude Code, and opencode
mkdir -p ~/.agents/skills ~/.claude/skills ~/.config/opencode/skills
for skill in ~/.dotfiles/skills/*/; do
    ln -svf "$skill" ~/.agents/skills/
    ln -svf "$skill" ~/.claude/skills/
    ln -svf "$skill" ~/.config/opencode/skills/
done
