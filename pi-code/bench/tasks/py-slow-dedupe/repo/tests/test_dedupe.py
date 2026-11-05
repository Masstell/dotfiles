import unittest
from dedupe import unique_in_order


class DedupeTest(unittest.TestCase):
    def test_small(self):
        rows = [{"email": "A@x.com", "n": 1}, {"email": " a@x.com ", "n": 2}, {"email": "b@x.com", "n": 3}]
        self.assertEqual([r["n"] for r in unique_in_order(rows)], [1, 3])
