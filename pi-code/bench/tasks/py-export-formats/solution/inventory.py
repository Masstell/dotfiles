#!/usr/bin/env python3
"""Show the inventory in items.json."""
import argparse
import csv
import io
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


def to_csv(items):
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(["name", "qty", "price"])
    for it in items:
        w.writerow([it["name"], it["qty"], f"{it['price']:.2f}"])
    return buf.getvalue()


def to_json(items):
    return json.dumps(sorted(items, key=lambda it: it["name"]), indent=2)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file", nargs="?", default="items.json")
    ap.add_argument("--format", choices=["table", "csv", "json"], default="table")
    a = ap.parse_args(argv)
    items = load_items(a.file)
    print({"table": to_table, "csv": to_csv, "json": to_json}[a.format](items))
    return 0


if __name__ == "__main__":
    sys.exit(main())
