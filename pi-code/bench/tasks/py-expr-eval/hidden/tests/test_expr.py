import unittest
from expr import evaluate, ExprError, ParseError, EvalError


def pos(src):
    try:
        evaluate(src)
    except ParseError as e:
        return e.pos
    return None


class Cases(unittest.TestCase):
    def test_precedence(self):
        for src, want in [("1 + 2 * 3", 7), ("(1 + 2) * 3", 9), ("-2**2", -4), ("(-2)**2", 4), ("2**3**2", 512),
                          ("2**-0", 1), ("10 - 3 - 2", 5), ("100 // 7 % 4", 2), ("-7 // 2", -4), ("-7 % 3", 2),
                          ("7 % -3", -2), ("--3", 3), ("-+-3", 3), ("2 * -3", -6), ("007 + 1", 8)]:
            self.assertEqual(evaluate(src), want, src)

    def test_logic(self):
        for src, want in [("1 < 2 < 3", True), ("3 > 2 > 2", False), ("1 == 1 != 2", True), ("not 1 == 2", True),
                          ("not 0", True), ("2 and 3", True), ("0 or 0", False), ("1 or 1 // 0", True),
                          ("0 and 1 // 0", False), ("2 < 1 < 1 // 0", False), ("not not 5", True),
                          ("1 < 2 == 2", True), ("1 + (2 < 3)", 2), ("1 or 0 and 0", True), ("not 1 or 1", True)]:
            r = evaluate(src)
            self.assertEqual(r, want, src)
            self.assertIs(type(r), type(want), src)

    def test_calls(self):
        self.assertEqual(evaluate("max(1, x, 3)", {"x": 9}), 9)
        self.assertEqual(evaluate("min(4)"), 4)
        self.assertEqual(evaluate("abs(-5) + abs(2)"), 7)
        self.assertIs(evaluate("max(t, 1)", {"t": True}), True)
        for bad in ("max()", "abs(1, 2)", "abs()", "foo(1)", "y + 1"):
            with self.assertRaises(EvalError, msg=bad):
                evaluate(bad)

    def test_eval_errors(self):
        for bad in ("1 // 0", "1 % (2 - 2)", "2 ** -1", "2 ** 10001", "x"):
            with self.assertRaises(EvalError, msg=bad):
                evaluate(bad)
        self.assertEqual(evaluate("1 ** 10000"), 1)

    def test_parse_positions(self):
        for src, p in [("1 +", 3), ("1 2", 2), ("(1", 2), ("1 $ 2", 2), ("", 0), ("  ", 2), ("1 + * 2", 4),
                       ("max(1,)", 6), ("f(1 2)", 4), ("1 ** ", 5), ("and", 0), ("x = 1", 2), ("1 2 $", 4),
                       ("()", 1), ("1_000", 1), ("é", 0), ("(1))", 3), ("not", 3), ("1 < ", 4), ("3 !", 2)]:
            self.assertEqual(pos(src), p, src)

    def test_only_expr_errors(self):
        for src in ("1 / 2", "1.5", "'a'", "1 +- ", "max(", "[1]", "a.b", "1e3"):
            with self.assertRaises(ExprError, msg=src):
                evaluate(src)

    def test_env_bools(self):
        self.assertEqual(evaluate("t + t", {"t": True}), 2)
        self.assertIs(evaluate("-t < 0", {"t": True}), True)
