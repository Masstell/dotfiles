#!/usr/bin/env bash
# Claude Code PreToolUse guard: blocks destructive operations against protected paths.
# Usage: registered in ~/.claude/settings.json by install.sh for two matchers:
#   Bash                             — inspects tool_input.command + cwd
#   Write|Edit|MultiEdit|NotebookEdit — inspects tool_input.file_path / notebook_path
#
# Written after the 2026-08-23 incident (an agent's `rm -rf /mnt/raid*` destroyed part
# of a 15 TB array over a rw CIFS mount; see ~/raid-recovery-20260823/INCIDENT-REPORT.md).
# This hook is defense-in-depth, not a security boundary: it inspects command strings
# only and cannot see inside scripts an agent writes and then executes. The kernel-level
# boundary is filesystem ownership; this exists to stop the obvious case fast, on every
# machine the dotfiles reach.
#
# Protected paths: built-in /mnt/raid prefix, plus one path-prefix per line from
# ~/.claude/guard-paths.local (machine-local, never committed).
#
# Fail-closed policy: jq missing, unparseable input, or any internal error => exit 2
# (block). A blocked call is noisy and safe; a silent bypass is neither.

BLOCK=2
REPORT="~/raid-recovery-20260823/INCIDENT-REPORT.md"

deny() {
    printf 'claude-guard: BLOCKED: %s\nProtected after the 2026-08-23 raid deletion incident (%s).\nIf this operation is genuinely intended, the user must run it themselves or remove the path from protection.\n' "$1" "$REPORT" >&2
    exit "$BLOCK"
}

command -v jq >/dev/null 2>&1 || deny "jq is unavailable so the guard cannot parse hook input (install jq or remove the hook from ~/.claude/settings.json)"

input="$(cat)"

# Malformed JSON must not be mistaken for absent fields.
printf '%s' "$input" | jq -e . >/dev/null 2>&1 || deny "hook input is not valid JSON"

j() { printf '%s' "$input" | jq -r "$1" 2>/dev/null; }

tool="$(j '.tool_name // empty')"

# Protected path prefixes: built-in + machine-local additions.
protected=("/mnt/raid")
if [ -f "$HOME/.claude/guard-paths.local" ]; then
    while IFS= read -r line; do
        line="${line%%#*}"
        line="${line#"${line%%[![:space:]]*}"}"
        line="${line%"${line##*[![:space:]]}"}"
        [ -n "$line" ] && protected+=("$line")
    done < "$HOME/.claude/guard-paths.local"
fi

# True if $1 contains any protected prefix as a substring.
mentions_protected() {
    local s="$1" p
    for p in "${protected[@]}"; do
        case "$s" in *"$p"*) return 0 ;; esac
    done
    return 1
}

# True if $1 (a directory path) is at or under any protected prefix.
under_protected() {
    local d="$1" p
    for p in "${protected[@]}"; do
        case "$d" in "$p"|"$p"/*|"$p"*) return 0 ;; esac
    done
    return 1
}

case "$tool" in
    Write|Edit|MultiEdit|NotebookEdit)
        target="$(j '.tool_input.file_path // .tool_input.notebook_path // empty')"
        [ -z "$target" ] && deny "file tool event carried no file_path/notebook_path"
        if mentions_protected "$target"; then
            deny "$tool to protected path: $target"
        fi
        exit 0
        ;;
    Bash)
        cmd="$(j '.tool_input.command // empty')"
        cwd="$(j '.cwd // empty')"
        [ -z "$cmd" ] && exit 0

        # Destructive patterns. Word-boundary on the verb; options/paths follow freely.
        destructive=0
        if printf '%s' "$cmd" | grep -Eq \
            -e '(^|[;&|[:space:]$(])(rm|shred|unlink|rmdir|mv|truncate)([[:space:]]|$)' \
            -e '(^|[;&|[:space:]$(])rsync[^;&|]*--delete' \
            -e '(^|[;&|[:space:]$(])find[[:space:]][^;&|]*[[:space:]]-(delete|exec|ok|fprint[f0]?|fls)([[:space:]]|$)' \
            -e '(^|[;&|[:space:]$(])dd[[:space:]][^;&|]*of=' \
            -e '(^|[;&|[:space:]$(])mkfs[.[:alnum:]]*([[:space:]]|$)' \
            -e '(^|[;&|[:space:]$(])chattr[[:space:]][^;&|]*-i' \
            ; then
            destructive=1
        fi
        # Redirection truncating/appending into a protected path.
        for p in "${protected[@]}"; do
            if printf '%s' "$cmd" | grep -Eq ">>?[[:space:]]*['\"]?${p}"; then
                deny "shell redirection into protected path ($p) in: $cmd"
            fi
        done

        if [ "$destructive" = 1 ]; then
            if mentions_protected "$cmd"; then
                deny "destructive command referencing a protected path: $cmd"
            fi
            if [ -n "$cwd" ] && under_protected "$cwd"; then
                deny "destructive command while cwd ($cwd) is under a protected path: $cmd"
            fi
        fi
        exit 0
        ;;
    "")
        deny "hook input carried no tool_name"
        ;;
    *)
        # Registered matchers should prevent this; stay permissive for unknown tools
        # so a matcher typo doesn't brick unrelated tooling.
        exit 0
        ;;
esac
