#!/usr/bin/env bash
# Copy every .txt file from SRC into DEST/YYYY-MM-DD/, keeping names.
# Usage: backup.sh SRC DEST
set -e
SRC=$1
DEST=$2
day=$(date +%F)
mkdir -p $DEST/$day
for f in $(ls $SRC/*.txt); do
  cp $f $DEST/$day/
done
echo "backed up $(ls $DEST/$day | wc -l) files"
