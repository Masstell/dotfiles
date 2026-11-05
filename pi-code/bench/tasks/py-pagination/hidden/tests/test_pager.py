import unittest
from pager import paginate, page_count


class PagerTest(unittest.TestCase):
    def test_first_page(self):
        self.assertEqual(paginate(list(range(10)), 1, 3), [0, 1, 2])

    def test_last_partial_page(self):
        self.assertEqual(paginate(list(range(10)), 4, 3), [9])

    def test_past_the_end(self):
        self.assertEqual(paginate(list(range(10)), 5, 3), [])

    def test_page_count(self):
        self.assertEqual(page_count(10, 3), 4)
        self.assertEqual(page_count(9, 3), 3)
        self.assertEqual(page_count(0, 3), 0)

    def test_page_zero(self):
        with self.assertRaises(ValueError):
            paginate([1, 2], 0, 1)
        with self.assertRaises(ValueError):
            paginate([1, 2], -1, 1)


if __name__ == "__main__":
    unittest.main()
