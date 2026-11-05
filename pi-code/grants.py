#!/usr/bin/env python3
"""Folder grants for pi (extensions/folders.ts), run by pi.sh outside the sandbox.

  grants.py list  <project>                               granted folders, one per line (rechecked)
  grants.py apply <request> <keyfile> <nonce> <project>   verify a signed request, update the list,
                                                          print {"session","added","removed","by"}

The list lives in ~/.config/pi-agent/grants/ (hidden from the sandbox). A
request is two lines: the JSON payload, then HMAC-SHA256 of "pi-grant\\0" +
payload with the grant key, which only pi's process holds. The payload must
carry this launch's nonce and project. Every folder is checked here again;
this, not the extension, decides what gets mounted.
"""
import hashlib
import hmac
import json
import os
import sys

HOME = os.path.realpath(os.path.expanduser("~"))
STORE = os.path.join(HOME, ".config", "pi-agent", "grants")
CODE_DIR = os.path.dirname(os.path.realpath(__file__))
SYSTEM = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/proc", "/sys", "/dev",
          "/run", "/var", "/root", "/snap", "/opt", "/srv", "/tmp"]
MAX_GRANTS = 20


def inside(p, d):
    return p == d or p.startswith(d.rstrip("/") + "/")


def refusal(real, project):
    """Why a resolved folder can't be writable, or ''. folders.ts mirrors this."""
    if not os.path.isdir(real):
        return "not an existing folder"
    if real == "/":
        return "the whole filesystem"
    if inside(HOME, real):
        return "home itself or a folder above it"
    if real.startswith(HOME + "/") and real[len(HOME) + 1:].split("/")[0].startswith("."):
        return "a hidden folder in home"
    repo = os.path.dirname(CODE_DIR)
    if inside(real, repo) or inside(repo, real):
        return "pi's own code"
    for s in SYSTEM:
        if inside(real, s):
            return f"a system folder ({s})"
    if project and inside(real, project):
        return "inside the project (already writable)"
    return ""


def store_file(project):
    return os.path.join(STORE, hashlib.sha256(project.encode()).hexdigest()[:32] + ".json")


def load(project):
    try:
        with open(store_file(project)) as f:
            data = json.load(f)
        if data.get("project") == project and isinstance(data.get("paths"), list):
            return [p for p in data["paths"] if isinstance(p, str)]
    except (OSError, ValueError):
        pass
    return []


def save(project, paths):
    os.makedirs(STORE, mode=0o700, exist_ok=True)
    f = store_file(project)
    tmp = f + ".tmp"
    with open(tmp, "w") as out:
        json.dump({"project": project, "paths": paths}, out, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, f)


def cmd_list(project):
    for p in load(project):
        real = os.path.realpath(p)
        # A granted folder that moved, vanished, or now resolves somewhere it shouldn't is skipped.
        if real == p and not refusal(real, project):
            print(p)


def cmd_apply(request, keyfile, nonce, project):
    try:
        with open(request, "rb") as f:
            raw = f.read(65536)
        with open(keyfile) as f:
            key = f.read().strip()
    except OSError as e:
        sys.exit(f"pi: folder request unreadable: {e}")
    lines = raw.decode("utf-8", "replace").split("\n")
    if len(lines) < 2 or not key:
        sys.exit("pi: folder request malformed")
    payload, sig = lines[0], lines[1].strip()
    want = hmac.new(key.encode(), b"pi-grant\0" + payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(want, sig):
        sys.exit("pi: ignored a folder request that pi didn't sign (something in the sandbox wrote it)")
    try:
        req = json.loads(payload)
    except ValueError:
        sys.exit("pi: folder request malformed")
    if req.get("nonce") != nonce or req.get("project") != project:
        sys.exit("pi: ignored a folder request from another pi launch")
    paths = load(project)
    added, removed = [], []
    for p in req.get("add") or []:
        real = os.path.realpath(str(p))
        why = refusal(real, project)
        if why:
            print(f"pi: not granting {real}: {why}", file=sys.stderr)
        elif real not in paths and len(paths) < MAX_GRANTS:
            paths.append(real)
            added.append(real)
    for p in req.get("remove") or []:
        if p in paths:
            paths.remove(p)
            removed.append(p)
    save(project, paths)
    session = req.get("session") if isinstance(req.get("session"), str) else ""
    print(json.dumps({"session": session, "added": added, "removed": removed, "by": req.get("by") or "user"}))


if __name__ == "__main__":
    a = sys.argv[1:]
    if a[:1] == ["list"] and len(a) == 2:
        cmd_list(a[1])
    elif a[:1] == ["apply"] and len(a) == 5:
        cmd_apply(*a[1:])
    else:
        sys.exit(__doc__)
