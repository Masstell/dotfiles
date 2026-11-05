#!/usr/bin/env bash
# Copy every .txt file from SRC into DEST/YYYY-MM-DD/, keeping names.
# Usage: backup.sh SRC DEST
set -euo pipefail
SRC="$1"
DEST="$2"
day="$(date +%F)"
mkdir -p "$DEST/$day"
shopt -s nullglob
n=0
for f in "$SRC"/*.txt; do
  cp -- "$f" "$DEST/$day/"
  n=$((n + 1))
done
echo "backed up $n files"
