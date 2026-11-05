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

    def test_unknown(self):
        with self.assertRaises(KeyError):
            reserve({}, "zz", 1)
