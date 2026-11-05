import unittest
from datetime import datetime, timezone
from dates import parse_ts

TEN = datetime(2026, 11, 5, 10, tzinfo=timezone.utc)


class DatesTest(unittest.TestCase):
    def test_plain(self):
        self.assertEqual(parse_ts("2026-11-05T10:00:00"), TEN)

    def test_z(self):
        self.assertEqual(parse_ts("2026-11-05T10:00:00Z"), TEN)

    def test_offset_converted(self):
        d = parse_ts("2026-11-05T12:00:00+02:00")
        self.assertEqual(d, TEN)
        self.assertEqual(d.utcoffset().total_seconds(), 0)

    def test_fraction(self):
        self.assertEqual(parse_ts("2026-11-05T10:00:00.250Z"), TEN.replace(microsecond=250000))

    def test_aware_utc(self):
        for s in ("2026-11-05T10:00:00", "2026-11-05T05:00:00-05:00"):
            d = parse_ts(s)
            self.assertIsNotNone(d.tzinfo)
            self.assertEqual(d.utcoffset().total_seconds(), 0)
