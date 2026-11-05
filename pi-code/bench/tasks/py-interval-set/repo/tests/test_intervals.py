import unittest
from intervals import IntervalSet


class IntervalTest(unittest.TestCase):
    def test_add_and_contains(self):
        s = IntervalSet([(1, 3), (10, 12)])
        self.assertIn(2, s)
        self.assertNotIn(3, s)
        self.assertEqual(len(s), 4)
