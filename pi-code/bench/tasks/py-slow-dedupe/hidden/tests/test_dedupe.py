import time
import unittest
from dedupe import unique_in_order


class DedupeTest(unittest.TestCase):
    def test_small(self):
        rows = [{"email": "A@x.com", "n": 1}, {"email": " a@x.com ", "n": 2}, {"email": "b@x.com", "n": 3}]
        self.assertEqual([r["n"] for r in unique_in_order(rows)], [1, 3])

    def test_large_fast_and_correct(self):
        rows = [{"email": f"User{i % 150000}@Example.com", "n": i} for i in range(200000)]
        t = time.perf_counter()
        out = unique_in_order(rows)
        self.assertLess(time.perf_counter() - t, 2.0)
        self.assertEqual(len(out), 150000)
        self.assertEqual(out[0]["n"], 0)
        self.assertEqual(out[-1]["n"], 149999)

    def test_returns_the_same_row_objects(self):
        rows = [{"email": "a@x"}, {"email": "A@X"}]
        self.assertIs(unique_in_order(rows)[0], rows[0])
