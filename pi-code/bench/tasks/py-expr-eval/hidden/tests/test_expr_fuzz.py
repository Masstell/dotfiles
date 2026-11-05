import random
import unittest
import expr
from tests import ref_expr as ref

NAMES = ["a", "b", "c", "x1", "_t"]
OPS = ["+", "-", "*", "//", "%", "**", "<", "<=", ">", ">=", "==", "!=", "and", "or"]


def gen(r, depth):
    if depth <= 0 or r.random() < 0.25:
        k = r.random()
        if k < 0.5:
            return str(r.randint(0, 12))
        if k < 0.85:
            return r.choice(NAMES + ["zz"] if r.random() < 0.05 else NAMES)
        return r.choice(["min", "max", "abs"]) + "(" + ", ".join(gen(r, depth - 1) for _ in range(r.choice([1, 1, 2, 3, 0]))) + ")"
    k = r.random()
    if k < 0.12:
        return r.choice(["-", "+", "not "]) + gen(r, depth - 1)
    if k < 0.25:
        return "(" + gen(r, depth - 1) + ")"
    op = r.choice(OPS)
    if op == "**":
        return gen(r, 0) + " ** " + str(r.randint(0, 4))
    sp = r.choice(["", " ", "  "])
    if op in ("and", "or"):
        sp = " "
    return gen(r, depth - 1) + sp + op + sp + gen(r, depth - 1)


def mutate(r, s):
    s = list(s)
    for _ in range(r.randint(1, 3)):
        i = r.randrange(len(s) + 1)
        k = r.random()
        if k < 0.4 and s:
            del s[min(i, len(s) - 1)]
        else:
            s.insert(i, r.choice(list("()+-*,<>=!%$ 0a") + ["**", "//", " and ", " not "]))
    return "".join(s)


def outcome(mod, src, env):
    try:
        v = mod.evaluate(src, env)
        return ("ok", type(v).__name__, v)
    except mod.ParseError as e:
        return ("ParseError", e.pos)
    except mod.EvalError:
        return ("EvalError",)
    except mod.ExprError as e:
        return ("ExprError?", type(e).__name__)


class Fuzz(unittest.TestCase):
    def run_cases(self, seed, n, mutated):
        r = random.Random(seed)
        bad = []
        for _ in range(n):
            src = gen(r, r.randint(1, 5))
            if mutated:
                src = mutate(r, src)
            env = {k: r.choice([r.randint(-5, 9), True, False]) for k in NAMES}
            try:
                got = outcome(expr, src, env)
            except Exception as e:  # anything but ExprError is wrong
                got = ("crash", type(e).__name__)
            want = outcome(ref, src, env)
            if got != want:
                bad.append((src, env, got, want))
        self.assertEqual(len(bad), 0, f"{len(bad)}/{n} differ, e.g. {bad[:3]}")

    def test_valid(self):
        self.run_cases(1, 3000, False)

    def test_invalid(self):
        self.run_cases(2, 3000, True)
