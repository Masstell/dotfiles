"""JSON Patch (RFC 6902): see SPEC.md."""
import copy
import re


class PatchError(Exception):
    pass


_INDEX = re.compile(r"0|[1-9][0-9]*\Z")
_OPS = {"add", "remove", "replace", "move", "copy", "test"}


def _tokens(ptr):
    if not isinstance(ptr, str):
        raise PatchError("pointer must be a string")
    if ptr == "":
        return []
    if not ptr.startswith("/"):
        raise PatchError(f"pointer must start with '/': {ptr!r}")
    out = []
    for t in ptr[1:].split("/"):
        if re.search(r"~(?![01])", t):
            raise PatchError(f"bad escape in {ptr!r}")
        out.append(t.replace("~1", "/").replace("~0", "~"))
    return out


def _index(tok, arr, allow_end):
    if tok == "-" and allow_end:
        return len(arr)
    if not _INDEX.fullmatch(tok):
        raise PatchError(f"bad array index {tok!r}")
    i = int(tok)
    if i > len(arr) or (i == len(arr) and not allow_end):
        raise PatchError(f"index {i} out of range")
    return i


def _get(doc, toks):
    cur = doc
    for t in toks:
        if isinstance(cur, dict):
            if t not in cur:
                raise PatchError(f"no member {t!r}")
            cur = cur[t]
        elif isinstance(cur, list):
            cur = cur[_index(t, cur, False)]
        else:
            raise PatchError("path goes through a scalar")
    return cur


def _add(doc, toks, value):
    if not toks:
        return value
    parent = _get(doc, toks[:-1])
    t = toks[-1]
    if isinstance(parent, dict):
        parent[t] = value
    elif isinstance(parent, list):
        parent.insert(_index(t, parent, True), value)
    else:
        raise PatchError("parent is not a container")
    return doc


def _remove(doc, toks):
    if not toks:
        raise PatchError("cannot remove the whole document")
    parent = _get(doc, toks[:-1])
    t = toks[-1]
    if isinstance(parent, dict):
        if t not in parent:
            raise PatchError(f"no member {t!r}")
        return parent.pop(t)
    if isinstance(parent, list):
        return parent.pop(_index(t, parent, False))
    raise PatchError("parent is not a container")


def _equal(a, b):
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    if a is None or b is None:
        return a is None and b is None
    return type(a) is type(b) and a == b


def apply_patch(doc, patch):
    if not isinstance(patch, list):
        raise PatchError("patch must be a list")
    doc = copy.deepcopy(doc)
    for op in patch:
        if not isinstance(op, dict):
            raise PatchError("operation must be an object")
        kind = op.get("op")
        if kind not in _OPS:
            raise PatchError(f"unknown op {kind!r}")
        if "path" not in op:
            raise PatchError("missing path")
        path = _tokens(op["path"])
        if kind in ("add", "replace", "test") and "value" not in op:
            raise PatchError("missing value")
        if kind in ("move", "copy"):
            if "from" not in op:
                raise PatchError("missing from")
            frm = _tokens(op["from"])
        if kind == "add":
            doc = _add(doc, path, copy.deepcopy(op["value"]))
        elif kind == "remove":
            _remove(doc, path)
        elif kind == "replace":
            _get(doc, path)
            if not path:
                doc = copy.deepcopy(op["value"])
            else:
                _remove(doc, path)
                doc = _add(doc, path, copy.deepcopy(op["value"]))
        elif kind == "move":
            if frm == path:
                _get(doc, frm)
                continue
            if len(frm) < len(path) and path[: len(frm)] == frm:
                raise PatchError("cannot move a value into its own child")
            if not frm:
                raise PatchError("cannot move the whole document")
            value = _remove(doc, frm)
            doc = _add(doc, path, value)
        elif kind == "copy":
            doc = _add(doc, path, copy.deepcopy(_get(doc, frm)))
        elif kind == "test":
            if not _equal(_get(doc, path), op["value"]):
                raise PatchError("test failed")
    return doc
