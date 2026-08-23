#!/usr/bin/env bash
# Fixture tests for ~/.dotfiles/claude/guard-hook.sh — pipes hook-input JSON straight
# to the script and asserts exit codes. Never touches /mnt/raid.
HOOK="$(dirname "$0")/guard-hook.sh"
TESTHOME="$(mktemp -d)"
mkdir -p "$TESTHOME/.claude"
SCRATCH="$(mktemp -d)"   # stand-in "protected" dir for guard-paths.local cases

pass=0; fail=0
run() { # run <name> <expected-exit> <json> [extra-env...]
    local name="$1" want="$2" json="$3"; shift 3
    local got
    printf '%s' "$json" | env HOME="$TESTHOME" "$@" bash "$HOOK" >/dev/null 2>&1
    got=$?
    if [ "$got" = "$want" ]; then pass=$((pass+1)); echo "PASS  $name"
    else fail=$((fail+1)); echo "FAIL  $name (want $want got $got)"; fi
}
bash_json() { jq -cn --arg c "$1" --arg d "$2" '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}'; }
file_json() { jq -cn --arg t "$1" --arg p "$2" '{tool_name:$t, tool_input:{file_path:$p}, cwd:"/home/x"}'; }

# --- Bash: destructive + protected => block ---
run "rm raid"            2 "$(bash_json 'rm -rf /mnt/raid/tmp-test' /home/x)"
run "rm raidshare glob"  2 "$(bash_json 'rm -rf /mnt/raidshare/foo' /home/x)"
run "mv out of raid"     2 "$(bash_json 'mv /mnt/raid/a /tmp/b' /home/x)"
run "rsync --delete"     2 "$(bash_json 'rsync -a --delete src/ /mnt/raid/Media/' /home/x)"
run "find -delete"       2 "$(bash_json 'find /mnt/raid/x -name t -delete' /home/x)"
run "find -exec"         2 "$(bash_json 'find /mnt/raid -name t -exec rm {} ;' /home/x)"
run "dd of= raid"        2 "$(bash_json 'dd if=/dev/zero of=/mnt/raid/img bs=1M' /home/x)"
run "redirect into raid" 2 "$(bash_json 'echo hi > /mnt/raid/f' /home/x)"
run "append into raid"   2 "$(bash_json 'echo hi >> /mnt/raid/f' /home/x)"
run "truncate raid"      2 "$(bash_json 'truncate -s0 /mnt/raid/f' /home/x)"
run "chattr -i raid"     2 "$(bash_json 'chattr -i /mnt/raid/Media' /home/x)"
run "chained rm"         2 "$(bash_json 'cd /tmp && rm -rf /mnt/raid/x' /home/x)"
# --- Bash: cwd under protected + destructive => block ---
run "cwd-relative rm"    2 "$(bash_json 'rm -rf *' /mnt/raid/Media)"
run "cwd raidshare rm"   2 "$(bash_json 'rm -f old.txt' /mnt/raidshare)"
# --- Bash: allowed ---
run "read-only ls raid"  0 "$(bash_json 'ls -la /mnt/raid/Media' /home/x)"
run "cat raid file"      0 "$(bash_json 'cat /mnt/raid/Media/a.txt' /home/x)"
run "rm in home"         0 "$(bash_json 'rm -rf node_modules' /home/x/proj)"
run "grep mentions rm"   0 "$(bash_json "grep -r 'rm -rf' docs/" /home/x)"
run "rsync no delete"    0 "$(bash_json 'rsync -a /mnt/raid/Media/ /tmp/copy/' /home/x)"
run "find no action"     0 "$(bash_json 'find /mnt/raid -name x -print' /home/x)"
run "empty command"      0 "$(jq -cn '{tool_name:"Bash", tool_input:{}, cwd:"/home/x"}')"
# --- File tools ---
run "Write raid"         2 "$(file_json Write /mnt/raid/Media/x.txt)"
run "Edit raid"          2 "$(file_json Edit /mnt/raidshare/y.conf)"
run "NotebookEdit raid"  2 "$(jq -cn '{tool_name:"NotebookEdit", tool_input:{notebook_path:"/mnt/raid/n.ipynb"}, cwd:"/home/x"}')"
run "Write home"         0 "$(file_json Write /home/x/notes.md)"
run "Write no path"      2 "$(jq -cn '{tool_name:"Write", tool_input:{}, cwd:"/home/x"}')"
# --- Degraded / hostile input => fail closed ---
run "malformed json"     2 'this is not json'
run "no tool_name"       2 "$(jq -cn '{tool_input:{command:"ls"}}')"
printf '%s' "$(bash_json 'ls' /home/x)" | env HOME="$TESTHOME" PATH=/nonexistent /bin/bash "$HOOK" >/dev/null 2>&1
if [ $? = 2 ]; then pass=$((pass+1)); echo "PASS  jq missing"; else fail=$((fail+1)); echo "FAIL  jq missing"; fi
# --- guard-paths.local additions ---
printf '# test\n%s\n' "$SCRATCH" > "$TESTHOME/.claude/guard-paths.local"
run "local: rm scratch"    2 "$(bash_json "rm -rf $SCRATCH/sub" /home/x)"
run "local: Write scratch" 2 "$(file_json Write "$SCRATCH/f.txt")"
run "local: cwd scratch"   2 "$(bash_json 'rm -f x' "$SCRATCH")"
run "local: other allowed" 0 "$(bash_json 'rm -rf /home/x/other' /home/x)"
rm -f "$TESTHOME/.claude/guard-paths.local"
# --- Live end-to-end (still scratch only): hook run exactly as Claude would ---
printf '%s\n' "$SCRATCH" > "$TESTHOME/.claude/guard-paths.local"
mkdir -p "$SCRATCH/live"; touch "$SCRATCH/live/canary"
printf '%s' "$(bash_json "rm -rf $SCRATCH/live" /home/x)" | env HOME="$TESTHOME" bash "$HOOK" >/dev/null 2>&1
if [ $? = 2 ] && [ -e "$SCRATCH/live/canary" ]; then pass=$((pass+1)); echo "PASS  live canary survives"; else fail=$((fail+1)); echo "FAIL  live canary"; fi

rm -rf "$TESTHOME" "$SCRATCH"
echo "----"; echo "pass=$pass fail=$fail"
[ "$fail" = 0 ]
