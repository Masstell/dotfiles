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
