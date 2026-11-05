import unittest
from money import round_half_up


class Hidden(unittest.TestCase):
    def test_negative_half(self):
        self.assertEqual(round_half_up(-2.5), -3.0)
        self.assertEqual(round_half_up(-0.5), -1.0)

    def test_positive_half(self):
        self.assertEqual(round_half_up(2.5), 3.0)
        self.assertEqual(round_half_up(0.125, 2), 0.13)

    def test_as_written(self):
        self.assertEqual(round_half_up(1.005, 2), 1.01)
        self.assertEqual(round_half_up(2.675, 2), 2.68)

    def test_plain(self):
        self.assertEqual(round_half_up(1.24, 1), 1.2)
        self.assertEqual(round_half_up(-1.26, 1), -1.3)
        self.assertEqual(round_half_up(7), 7.0)
