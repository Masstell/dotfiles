#!/usr/bin/env python3
"""Show the inventory in items.json."""
import argparse
import json
import sys


def load_items(path):
    with open(path) as f:
        return json.load(f)


def to_table(items):
    lines = [f"{'name':<16}{'qty':>5}{'price':>10}"]
    for it in items:
        lines.append(f"{it['name']:<16}{it['qty']:>5}{it['price']:>10.2f}")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", nargs="?", default="items.json")
    a = ap.parse_args(argv)
    print(to_table(load_items(a.file)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
