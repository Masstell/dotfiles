# dotfiles

On Linux or macOS, run `./install.sh` from this checkout. It creates
`~/.dotfiles` as a link to the checkout when needed, so cloning to `~/dotfiles`
works too. If `~/.dotfiles` already refers to another checkout, resolve that
conflict first; the installer will stop without replacing it.

The installer replaces managed shell/Vim configuration files with symlinks,
sets the global Git hooks path, and merges the Claude configuration. Back up
existing configuration files before installing. Your other Git settings are
preserved.

Git and curl should be installed. Missing oh-my-posh and jq are downloaded into
`~/.local/bin`; pi is installed when npm is available. Failed optional downloads
print a warning. On Ubuntu/Debian, missing `unzip` is installed with apt-get
(using sudo when needed) before installing oh-my-posh. Restart your shell after
installation.
