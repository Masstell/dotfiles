import unittest
from expr import evaluate, ParseError, EvalError


class ExprTest(unittest.TestCase):
    def test_arithmetic(self):
        self.assertEqual(evaluate("1 + 2 * 3"), 7)

    def test_names(self):
        self.assertEqual(evaluate("x * 2", {"x": 21}), 42)

    def test_errors(self):
        with self.assertRaises(ParseError):
            evaluate("1 +")
        with self.assertRaises(EvalError):
            evaluate("1 // 0")
