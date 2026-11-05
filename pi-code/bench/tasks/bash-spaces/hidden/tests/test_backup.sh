#!/usr/bin/env bash
# Grading test for backup.sh.
set -u
HERE="$(cd "$(dirname "$0")/.." && pwd)"
t="$(mktemp -d)"
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$t/my docs" "$t/back ups"
echo one > "$t/my docs/a file.txt"
echo two > "$t/my docs/plain.txt"
echo skip > "$t/my docs/notes.md"
out="$(bash "$HERE/backup.sh" "$t/my docs" "$t/back ups" 2>&1)" || fail "exit status: $out"
day="$(date +%F)"
[[ -f "$t/back ups/$day/a file.txt" ]] || fail "a file.txt not copied: $out"
[[ -f "$t/back ups/$day/plain.txt" ]] || fail "plain.txt not copied"
[[ ! -e "$t/back ups/$day/notes.md" ]] || fail "copied a non-.txt file"
[[ "$out" == *"backed up 2 files"* ]] || fail "wrong summary: $out"
mkdir -p "$t/empty dir"
out="$(bash "$HERE/backup.sh" "$t/empty dir" "$t/out2" 2>&1)" || fail "empty source failed: $out"
[[ "$out" == *"backed up 0 files"* ]] || fail "empty source summary: $out"
echo ok
