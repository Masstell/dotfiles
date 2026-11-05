import unittest
from stock import reserve


class StockTest(unittest.TestCase):
    def test_too_many(self):
        s = {"a": 3}
        with self.assertRaises(ValueError):
            reserve(s, "a", 4)
        self.assertEqual(s, {"a": 3})

    def test_exactly_all(self):
        s = {"a": 3}
        self.assertEqual(reserve(s, "a", 3), 0)
        self.assertEqual(s, {"a": 0})

    def test_unknown(self):
        with self.assertRaises(KeyError):
            reserve({}, "zz", 1)

    def test_bad_qty(self):
        for q in (0, -1, 1.5, "2"):
            s = {"a": 3}
            with self.assertRaises(ValueError, msg=repr(q)):
                reserve(s, "a", q)
            self.assertEqual(s, {"a": 3})

    def test_normal(self):
        s = {"a": 3}
        self.assertEqual(reserve(s, "a", 2), 1)
