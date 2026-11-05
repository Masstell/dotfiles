import unittest
from datetime import datetime, timezone
from dates import parse_ts


class DatesTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_ts("2026-11-05T10:00:00"), datetime(2026, 11, 5, 10, tzinfo=timezone.utc))
