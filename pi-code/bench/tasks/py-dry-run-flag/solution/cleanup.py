#!/usr/bin/env python3
"""Delete files older than --days in a folder."""
import argparse
import os
import sys
import time


def old_files(folder, days, now=None):
    now = now or time.time()
    cutoff = now - days * 86400
    for name in sorted(os.listdir(folder)):
        p = os.path.join(folder, name)
        if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
            yield p


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("folder")
    ap.add_argument("--days", type=int, default=30)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args(argv)
    for p in old_files(a.folder, a.days):
        if a.dry_run:
            print(f"would delete {p}")
            continue
        os.remove(p)
        print(f"deleted {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
