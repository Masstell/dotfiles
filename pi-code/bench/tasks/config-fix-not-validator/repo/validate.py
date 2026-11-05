#!/usr/bin/env python3
"""Check a services config: python3 validate.py config.json"""
import json
import sys


def problems(cfg):
    out = []
    names = {s["name"] for s in cfg["services"]}
    ports = {}
    for s in cfg["services"]:
        image = s.get("image", "")
        if ":" not in image or image.endswith(":latest"):
            out.append(f"{s['name']}: image must have an exact tag, not latest")
        p = s.get("port")
        if not isinstance(p, int) or not 1024 <= p <= 65535:
            out.append(f"{s['name']}: port must be a number from 1024 to 65535")
        elif p in ports:
            out.append(f"{s['name']}: port {p} already used by {ports[p]}")
        else:
            ports[p] = s["name"]
        for d in s.get("depends_on", []):
            if d not in names:
                out.append(f"{s['name']}: depends on unknown service {d}")
    return out


if __name__ == "__main__":
    errs = problems(json.load(open(sys.argv[1])))
    for e in errs:
        print(e)
    sys.exit(1 if errs else 0)
