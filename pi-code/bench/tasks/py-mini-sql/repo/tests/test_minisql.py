import unittest
from minisql import query, SqlError

COLS = ["id", "name", "qty"]
ROWS = [(1, "bolt", 10), (2, "nut", None), (3, "gear", 4)]


class MiniSqlTest(unittest.TestCase):
    def test_where_order(self):
        self.assertEqual(query(COLS, ROWS, "SELECT name FROM t WHERE qty > 5 ORDER BY name"), [("bolt",)])

    def test_count(self):
        self.assertEqual(query(COLS, ROWS, "select count(*), count(qty) from t"), [(3, 2)])

    def test_error(self):
        with self.assertRaises(SqlError):
            query(COLS, ROWS, "SELECT nope FROM t")
