#!/bin/bash

ln -svf ~/.dotfiles/bash_profile ~/.bash_profile
ln -svf ~/.dotfiles/bashrc ~/.bashrc
cp ~/.dotfiles/gitconfig_base ~/.gitconfig
ln -svf ~/.dotfiles/vimrc ~/.vimrc
curl -s https://ohmyposh.dev/install.sh | bash -s

mkdir -p ~/.vim/backups ~/.vim/swaps ~/.vim/undos
mkdir -p ~/.local/bin
ln -svf ~/.dotfiles/opencode.sh ~/.local/bin/opencode.sh
