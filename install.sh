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
command -v claude >/dev/null 2>&1 && ln -svf ~/.dotfiles/claude-trusted.sh ~/.local/bin/claude-trusted
# docker read-only shim — only where the docker-ro wrapper is deployed (ansible
# hardening role); elsewhere plain docker stays untouched.
[ -x /usr/local/sbin/docker-ro ] && ln -svf ~/.dotfiles/docker-shim.sh ~/.local/bin/docker
# Node >=22.19 is required by pi. node_ok is pi's own installer preflight lifted
# verbatim, so we accept exactly what pi will accept — including how it treats
# odd version strings — rather than a looser major-only compare.
node_ok() {
    command -v node >/dev/null 2>&1 || return 1
    node -e 'const [maj,min,patch]=process.versions.node.split(".").map(Number);process.exit(maj>22||(maj===22&&(min>19||(min===19&&patch>=0)))?0:1)' 2>/dev/null
}

# Provide Node 22 via nvm (reusable, no sudo). Two responsibilities: bootstrap
# nvm when the system node is too old for pi, AND — whenever nvm is present — pin
# 22 as nvm's DEFAULT. The default matters because the tracked bashrc sources nvm
# unconditionally; on a box with a pre-existing nvm whose default is older, that
# sourcing would silently downgrade `node` in every interactive shell. The nvm
# SOURCE lines live in bashrc; here we bootstrap + select 22 for THIS run too, so
# the pinned pi install below uses node 22's npm.
export NVM_DIR="$HOME/.nvm"
if ! node_ok && [ ! -s "$NVM_DIR/nvm.sh" ]; then
    echo "installing nvm (Node 22 is required by pi)..."
    # PINNED nvm release — deliberate, mirroring the pin-everything stance here;
    # bump after a quick read of the new install.sh. Download to a temp file
    # first for two reasons: (1) piping curl straight into bash hides a download
    # failure (empty stdin → bash still exits 0), and (2) in `A | B`, an env
    # prefix binds to A only — so PROFILE=/dev/null must be on the bash that runs
    # the installer, not on curl. PROFILE=/dev/null stops the installer editing
    # ~/.bashrc, a symlink into the tracked dotfile (bashrc sources nvm itself).
    _nvm_installer="$(mktemp)"
    if curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh -o "$_nvm_installer"; then
        PROFILE=/dev/null bash "$_nvm_installer" \
            || echo "nvm install failed — install Node >=22.19 manually, then re-run install.sh"
    else
        echo "nvm download failed — install Node >=22.19 manually, then re-run install.sh"
    fi
    rm -f "$_nvm_installer"
fi
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
if command -v nvm >/dev/null 2>&1; then
    # Idempotent: installs 22 only if missing, then pins it as the login default
    # so bashrc's nvm sourcing resolves `node` to 22 on every box, regardless of
    # any pre-existing default. Only runs when nvm is actually present — a box
    # with a fine system node and no nvm is left untouched (node_ok short-circuits
    # the bootstrap above, and this guard is false).
    nvm install 22 >/dev/null && nvm alias default 22 >/dev/null
fi

# pi coding agent (pi.dev) — the local-model launcher + classifier live in
# pi-code/. Auto-install pi if missing (npm global, --ignore-scripts, mirroring
# the official installer minus its pipe-to-shell and its unpinned @latest), then
# symlink the pi binary into ~/.local/bin. We install into a user-writable prefix
# (~/.npm-global) so this never needs sudo even when npm's default global prefix
# is root-owned (e.g. /usr/local — the EACCES that used to break fresh installs).
# ~/.local/bin is on PATH (see bashrc); pi's shim resolves `node` via PATH, which
# nvm's default (22) satisfies in interactive shells. Finally symlink pi-local.
if ! command -v pi >/dev/null 2>&1; then
    PI_PREFIX="$HOME/.npm-global"
    NPMBIN="$PI_PREFIX/bin"
    if [ ! -x "$NPMBIN/pi" ] && command -v npm >/dev/null; then
        if node_ok; then
            echo "installing pi (pi.dev coding agent) via npm..."
            # PINNED: pi is pre-1.0 (~weekly releases) and the tool_call hook API
            # the classifier relies on may shift. An unpinned upgrade that drops the
            # hook would silently stop gating bash. Bump deliberately after
            # re-checking pi-code/extensions/ against the new release.
            npm install -g --ignore-scripts --prefix "$PI_PREFIX" \
                @earendil-works/pi-coding-agent@0.84.2
            # Verify the real outcome, not just npm's exit code: npm can exit 0
            # yet land the bin elsewhere, which would skip the symlink below and
            # otherwise report success silently.
            [ -x "$NPMBIN/pi" ] \
                || echo "pi auto-install failed (no binary at $NPMBIN/pi) — install manually: https://pi.dev"
        else
            echo "skipping pi install — Node >=22.19 not found (have $(node -v 2>/dev/null || echo none)); install Node 22 (nvm) and re-run install.sh"
        fi
    fi
    [ -x "$NPMBIN/pi" ] && ln -svf "$NPMBIN/pi" ~/.local/bin/pi
fi
command -v pi >/dev/null 2>&1 && ln -svf ~/.dotfiles/pi-code/pi-local.sh ~/.local/bin/pi-local

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
    # Guard-hook re-registration is surgical: strip only hook COMMANDS that are the
    # guard (matched by ~-form, $HOME-expanded form, or basename — a prior run may
    # have stored either spelling), keep any sibling hooks in the same entry, drop
    # entries left empty, then append the canonical pair. Never touches unrelated
    # hooks; never duplicates.
    jq --arg guard '~/.claude/bin/claude-guard' --arg guard_abs "$HOME/.claude/bin/claude-guard" '
      def is_guard: ((.command // "") | (. == $guard or . == $guard_abs or endswith("/claude-guard")));
      .statusLine = {type:"command", command:"~/.claude/statusline.sh", padding:0, refreshInterval:10}
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
    ' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
else
    echo "jq not found — add statusLine + guard hook to ~/.claude/settings.json manually (see claude/README.md)"
fi
