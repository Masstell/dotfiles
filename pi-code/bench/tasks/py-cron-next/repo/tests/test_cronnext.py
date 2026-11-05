import unittest
from datetime import datetime, timezone
from zoneinfo import ZoneInfo
from cronnext import next_fire


class CronTest(unittest.TestCase):
    def test_every_15(self):
        got = next_fire("*/15 * * * *", datetime(2026, 3, 1, 10, 7, tzinfo=timezone.utc), "UTC")
        self.assertEqual(got, datetime(2026, 3, 1, 10, 15, tzinfo=ZoneInfo("UTC")))

    def test_invalid(self):
        with self.assertRaises(ValueError):
            next_fire("60 * * * *", datetime(2026, 1, 1, tzinfo=timezone.utc), "UTC")
