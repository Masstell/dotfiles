import unittest
from report import format_receipt


class ReportTest(unittest.TestCase):
    def test_receipt(self):
        self.assertEqual(format_receipt(2000, 150), "Paid $20.00, change $1.50")
