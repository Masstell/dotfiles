"""Evaluate small expressions (see SPEC.md)."""


class ExprError(Exception):
    pass


class ParseError(ExprError):
    def __init__(self, msg, pos):
        super().__init__(f"{msg} at {pos}")
        self.pos = pos


class EvalError(ExprError):
    pass


KEYWORDS = {"and", "or", "not"}
OPS = ["**", "//", "<=", ">=", "==", "!=", "+", "-", "*", "%", "<", ">", "(", ")", ","]
MAX_EXP = 10000


def tokenize(src):
    toks = []
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c in " \t\n":
            i += 1
        elif c.isdigit() and c.isascii():
            j = i
            while j < n and src[j].isdigit() and src[j].isascii():
                j += 1
            toks.append(("int", int(src[i:j]), i))
            i = j
        elif c.isascii() and (c.isalpha() or c == "_"):
            j = i
            while j < n and src[j].isascii() and (src[j].isalnum() or src[j] == "_"):
                j += 1
            w = src[i:j]
            toks.append(("kw" if w in KEYWORDS else "name", w, i))
            i = j
        else:
            for op in OPS:
                if src.startswith(op, i):
                    toks.append(("op", op, i))
                    i += len(op)
                    break
            else:
                raise ParseError(f"unexpected character {c!r}", i)
    toks.append(("end", None, n))
    return toks


class Parser:
    def __init__(self, src):
        self.toks = tokenize(src)
        self.i = 0

    def peek(self):
        return self.toks[self.i]

    def take(self):
        t = self.toks[self.i]
        self.i += 1
        return t

    def is_(self, kind, val=None):
        t = self.peek()
        return t[0] == kind and (val is None or t[1] == val)

    def expect(self, kind, val):
        t = self.peek()
        if not self.is_(kind, val):
            raise ParseError(f"expected {val!r}", t[2])
        return self.take()

    def parse(self):
        node = self.or_()
        t = self.peek()
        if t[0] != "end":
            raise ParseError("unexpected token", t[2])
        return node

    def or_(self):
        node = self.and_()
        while self.is_("kw", "or"):
            self.take()
            node = ("or", node, self.and_())
        return node

    def and_(self):
        node = self.not_()
        while self.is_("kw", "and"):
            self.take()
            node = ("and", node, self.not_())
        return node

    def not_(self):
        if self.is_("kw", "not"):
            self.take()
            return ("not", self.not_())
        return self.cmp()

    def cmp(self):
        first = self.sum()
        ops, rest = [], []
        while self.peek()[0] == "op" and self.peek()[1] in ("<", "<=", ">", ">=", "==", "!="):
            ops.append(self.take()[1])
            rest.append(self.sum())
        return ("cmp", first, ops, rest) if ops else first

    def sum(self):
        node = self.term()
        while self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            node = ("bin", op, node, self.term())
        return node

    def term(self):
        node = self.unary()
        while self.peek()[0] == "op" and self.peek()[1] in ("*", "//", "%"):
            op = self.take()[1]
            node = ("bin", op, node, self.unary())
        return node

    def unary(self):
        if self.peek()[0] == "op" and self.peek()[1] in ("+", "-"):
            op = self.take()[1]
            return ("neg" if op == "-" else "pos", self.unary())
        return self.power()

    def power(self):
        base = self.atom()
        if self.is_("op", "**"):
            self.take()
            return ("bin", "**", base, self.unary())
        return base

    def atom(self):
        t = self.peek()
        if t[0] == "int":
            self.take()
            return ("int", t[1])
        if t[0] == "name":
            self.take()
            if self.is_("op", "("):
                self.take()
                args = []
                if not self.is_("op", ")"):
                    args.append(self.or_())
                    while self.is_("op", ","):
                        self.take()
                        args.append(self.or_())
                self.expect("op", ")")
                return ("call", t[1], args)
            return ("name", t[1])
        if self.is_("op", "("):
            self.take()
            node = self.or_()
            self.expect("op", ")")
            return node
        raise ParseError("expected a value", t[2])


def ev(node, env):
    k = node[0]
    if k == "int":
        return node[1]
    if k == "name":
        if node[1] not in env:
            raise EvalError(f"unknown name {node[1]}")
        return env[node[1]]
    if k == "neg":
        return -ev(node[1], env)
    if k == "pos":
        return +ev(node[1], env)
    if k == "not":
        return not ev(node[1], env)
    if k == "and":
        return bool(ev(node[1], env)) and bool(ev(node[2], env))
    if k == "or":
        return bool(ev(node[1], env)) or bool(ev(node[2], env))
    if k == "cmp":
        left = ev(node[1], env)
        for op, sub in zip(node[2], node[3]):
            right = ev(sub, env)
            ok = {"<": left < right, "<=": left <= right, ">": left > right,
                  ">=": left >= right, "==": left == right, "!=": left != right}[op]
            if not ok:
                return False
            left = right
        return True
    if k == "bin":
        op, a = node[1], ev(node[2], env)
        b = ev(node[3], env)
        if op == "+":
            return a + b
        if op == "-":
            return a - b
        if op == "*":
            return a * b
        if op in ("//", "%"):
            if b == 0:
                raise EvalError("division by zero")
            return a // b if op == "//" else a % b
        if op == "**":
            if b < 0:
                raise EvalError("negative exponent")
            if b > MAX_EXP:
                raise EvalError("exponent too large")
            return a ** b
    if k == "call":
        name, args = node[1], node[2]
        if name in ("min", "max"):
            if not args:
                raise EvalError(f"{name} needs at least one argument")
            vals = [ev(a, env) for a in args]
            return min(vals) if name == "min" else max(vals)
        if name == "abs":
            if len(args) != 1:
                raise EvalError("abs takes exactly one argument")
            return abs(ev(args[0], env))
        raise EvalError(f"unknown function {name}")
    raise AssertionError(node)


def evaluate(src, env=None):
    return ev(Parser(src).parse(), dict(env or {}))
