import inspect
import unittest
import report
from tests import original


CASES = [[("Widget", 1999), ("Gadget", 123456)], [("Refund", -505)], [], [("A", 0), ("B", 5)]]


class ReportTest(unittest.TestCase):
    def test_invoice_unchanged(self):
        for lines in CASES:
            for cur in ("USD", "EUR", "GBP", "JPY"):
                self.assertEqual(report.format_invoice(lines, cur), original.format_invoice(lines, cur))

    def test_receipt_unchanged(self):
        for paid, change in ((2000, 150), (0, 0), (123456789, -5), (-100, 7)):
            for cur in ("USD", "EUR", "CHF"):
                self.assertEqual(report.format_receipt(paid, change, cur), original.format_receipt(paid, change, cur))

    def test_format_money(self):
        self.assertEqual(report.format_money(123450, "USD"), "$1,234.50")
        self.assertEqual(report.format_money(-5, "USD"), "$-0.05")
        self.assertEqual(report.format_money(100, "CHF"), "CHF 1.00")

    def test_used_by_both(self):
        for f in (report.format_invoice, report.format_receipt):
            src = inspect.getsource(f)
            self.assertIn("format_money(", src, f.__name__)
            self.assertNotIn("divmod", src, f.__name__)
