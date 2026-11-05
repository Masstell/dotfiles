"""A tiny SQL SELECT engine over one in-memory table (see SPEC.md)."""
import re


class SqlError(Exception):
    pass


KEYWORDS = {"select", "from", "where", "group", "by", "order", "asc", "desc", "limit", "offset",
            "and", "or", "not", "is", "null", "count", "sum", "min", "max", "avg"}
AGGS = {"count", "sum", "min", "max", "avg"}
TOKEN = re.compile(r"\s*(?:(\d+)|('(?:[^']|'')*')|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|=|<|>|\(|\)|,|\*|-))")


def tokenize(sql):
    toks, i = [], 0
    sql = sql.rstrip()
    while i < len(sql):
        m = TOKEN.match(sql, i)
        if not m or m.end() == i:
            raise SqlError(f"bad input at {i}")
        num, s, word, op = m.groups()
        if num is not None:
            toks.append(("num", int(num)))
        elif s is not None:
            toks.append(("str", s[1:-1].replace("''", "'")))
        elif word is not None:
            w = word.lower()
            toks.append(("kw", w) if w in KEYWORDS else ("id", w))
        else:
            toks.append(("op", op))
        i = m.end()
    toks.append(("end", None))
    return toks


class P:
    def __init__(self, sql):
        self.t = tokenize(sql)
        self.i = 0

    def peek(self, k=0):
        return self.t[self.i + k]

    def take(self):
        tok = self.t[self.i]
        self.i += 1
        return tok

    def accept(self, kind, val=None):
        tok = self.peek()
        if tok[0] == kind and (val is None or tok[1] == val):
            self.i += 1
            return tok
        return None

    def need(self, kind, val=None):
        tok = self.accept(kind, val)
        if not tok:
            raise SqlError(f"expected {val or kind}, got {self.peek()[1]!r}")
        return tok


def parse(sql):
    p = P(sql)
    p.need("kw", "select")
    items = []
    if p.accept("op", "*"):
        items = "*"
    else:
        while True:
            items.append(sel_item(p))
            if not p.accept("op", ","):
                break
    p.need("kw", "from")
    if p.need("id")[1] != "t":
        raise SqlError("the table is called t")
    where = None
    if p.accept("kw", "where"):
        where = cond(p)
    group = []
    if p.accept("kw", "group"):
        p.need("kw", "by")
        while True:
            group.append(p.need("id")[1])
            if not p.accept("op", ","):
                break
    order = []
    if p.accept("kw", "order"):
        p.need("kw", "by")
        while True:
            if p.peek()[0] == "num":
                key = ("pos", p.take()[1])
            else:
                key = sel_item(p)
            desc = False
            if p.accept("kw", "desc"):
                desc = True
            else:
                p.accept("kw", "asc")
            order.append((key, desc))
            if not p.accept("op", ","):
                break
    limit = offset = None
    if p.accept("kw", "limit"):
        limit = p.need("num")[1]
        if p.accept("kw", "offset"):
            offset = p.need("num")[1]
    p.need("end")
    return items, where, group, order, limit, offset


def sel_item(p):
    tok = p.peek()
    if tok[0] == "kw" and tok[1] in AGGS:
        p.take()
        p.need("op", "(")
        if tok[1] == "count" and p.accept("op", "*"):
            arg = "*"
        else:
            arg = p.need("id")[1]
        p.need("op", ")")
        return ("agg", tok[1], arg)
    return ("col", p.need("id")[1])


def cond(p):
    node = and_(p)
    while p.accept("kw", "or"):
        node = ("or", node, and_(p))
    return node


def and_(p):
    node = not_(p)
    while p.accept("kw", "and"):
        node = ("and", node, not_(p))
    return node


def not_(p):
    if p.accept("kw", "not"):
        return ("not", not_(p))
    return pred(p)


def pred(p):
    if p.peek() == ("op", "(") :
        p.take()
        node = cond(p)
        p.need("op", ")")
        return node
    left = operand(p)
    if p.accept("kw", "is"):
        neg = bool(p.accept("kw", "not"))
        p.need("kw", "null")
        return ("isnull", left, neg)
    tok = p.take()
    if tok[0] != "op" or tok[1] not in ("=", "!=", "<>", "<", "<=", ">", ">="):
        raise SqlError(f"expected a comparison, got {tok[1]!r}")
    return ("cmp", "!=" if tok[1] == "<>" else tok[1], left, operand(p))


def operand(p):
    tok = p.take()
    if tok[0] == "id":
        return ("col", tok[1])
    if tok[0] == "num":
        return ("lit", tok[1])
    if tok[0] == "str":
        return ("lit", tok[1])
    if tok == ("kw", "null"):
        return ("lit", None)
    if tok == ("op", "-") and p.peek()[0] == "num":
        return ("lit", -p.take()[1])
    raise SqlError(f"expected a value, got {tok[1]!r}")


def truth(node, row, idx):
    k = node[0]
    if k == "and":
        a, b = truth(node[1], row, idx), truth(node[2], row, idx)
        if a is False or b is False:
            return False
        return None if a is None or b is None else True
    if k == "or":
        a, b = truth(node[1], row, idx), truth(node[2], row, idx)
        if a is True or b is True:
            return True
        return None if a is None or b is None else False
    if k == "not":
        a = truth(node[1], row, idx)
        return None if a is None else not a
    if k == "isnull":
        v = value(node[1], row, idx)
        return (v is not None) if node[2] else (v is None)
    if k == "cmp":
        a, b = value(node[2], row, idx), value(node[3], row, idx)
        if a is None or b is None:
            return None
        return {"=": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[node[1]]
    raise AssertionError(node)


def value(node, row, idx):
    if node[0] == "lit":
        return node[1]
    return row[idx[node[1]]]


def check_cols(node, idx):
    if node is None:
        return
    if node[0] == "col":
        if node[1] not in idx:
            raise SqlError(f"no column {node[1]}")
    elif node[0] in ("and", "or"):
        check_cols(node[1], idx); check_cols(node[2], idx)
    elif node[0] == "not":
        check_cols(node[1], idx)
    elif node[0] == "isnull":
        check_cols(node[1], idx)
    elif node[0] == "cmp":
        check_cols(node[2], idx); check_cols(node[3], idx)


def aggregate(fn, arg, rows, idx):
    if fn == "count" and arg == "*":
        return len(rows)
    vals = [r[idx[arg]] for r in rows if r[idx[arg]] is not None]
    if fn == "count":
        return len(vals)
    if not vals:
        return None
    if fn == "sum":
        return sum(vals)
    if fn == "min":
        return min(vals)
    if fn == "max":
        return max(vals)
    return sum(vals) / len(vals)


def sort_key(v, desc):
    # NULLs first ascending (so last descending); ints before strings, as SQLite orders them.
    if v is None:
        return (0, 0, 0)
    return (1, 0, v) if isinstance(v, int) else (1, 1, v)


def query(columns, rows, sql):
    items, where, group, order, limit, offset = parse(sql)
    idx = {c.lower(): i for i, c in enumerate(columns)}
    check_cols(where, idx)
    for g in group:
        if g not in idx:
            raise SqlError(f"no column {g}")
    if items == "*":
        if group:
            raise SqlError("SELECT * with GROUP BY")
        items = [("col", c.lower()) for c in columns]
    for it in items:
        col = it[1] if it[0] == "col" else it[2]
        if col != "*" and col not in idx:
            raise SqlError(f"no column {col}")
        if it[0] == "agg" and it[2] == "*" and it[1] != "count":
            raise SqlError("only COUNT takes *")
    has_agg = any(it[0] == "agg" for it in items)
    if has_agg or group:
        bare = [it[1] for it in items if it[0] == "col" and it[1] not in group]
        if bare:
            raise SqlError(f"column {bare[0]} must be in GROUP BY")
    kept = [r for r in rows if where is None or truth(where, r, idx) is True]
    if has_agg or group:
        groups = {}
        for r in kept:
            groups.setdefault(tuple(r[idx[g]] for g in group), []).append(r)
        if not group and not groups:
            groups[()] = []
        out = []
        for key, rs in groups.items():
            gv = dict(zip(group, key))
            out.append(tuple(gv[it[1]] if it[0] == "col" else aggregate(it[1], it[2], rs, idx) for it in items))
    else:
        out = [tuple(r[idx[it[1]]] for it in items) for r in kept]
    if order:
        keys = []
        for key, desc in order:
            if key[0] == "pos":
                if not 1 <= key[1] <= len(items):
                    raise SqlError(f"ORDER BY position {key[1]} out of range")
                keys.append((key[1] - 1, desc))
            elif key in items:
                keys.append((items.index(key), desc))
            else:
                raise SqlError("ORDER BY must name a selected column or aggregate")
        for i, desc in reversed(keys):
            out.sort(key=lambda row: sort_key(row[i], desc), reverse=desc)
    if offset:
        out = out[offset:]
    if limit is not None:
        out = out[:limit]
    return out
