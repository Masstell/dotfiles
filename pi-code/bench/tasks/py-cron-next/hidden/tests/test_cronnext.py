import random
import unittest
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from cronnext import next_fire
from tests import ref_cron

UTC = timezone.utc
DEN = ZoneInfo("America/Denver")


def utc(*a):
    return datetime(*a, tzinfo=UTC)


class Cases(unittest.TestCase):
    def eq(self, got, want):
        self.assertIsNotNone(got)
        self.assertEqual(got, want)
        self.assertEqual(got.utcoffset(), want.utcoffset())
        self.assertEqual((got.second, got.microsecond, got.fold), (0, 0, 0))

    def test_basics(self):
        self.eq(next_fire("*/15 * * * *", utc(2026, 3, 1, 10, 7), "UTC"), datetime(2026, 3, 1, 10, 15, tzinfo=ZoneInfo("UTC")))
        self.eq(next_fire("0 * * * *", utc(2026, 3, 1, 10, 0), "UTC"), datetime(2026, 3, 1, 11, 0, tzinfo=ZoneInfo("UTC")))
        self.eq(next_fire("0 9 * * mon-fri", utc(2026, 11, 6, 17), "America/Denver"), datetime(2026, 11, 9, 9, 0, tzinfo=DEN))
        self.eq(next_fire("10-30/7 * * * *", utc(2026, 1, 1, 0, 24, 30), "UTC"), datetime(2026, 1, 1, 1, 10, tzinfo=ZoneInfo("UTC")))
        self.eq(next_fire("  0   12  *  JAN,Jul  *  ", utc(2026, 2, 1), "UTC"), datetime(2026, 7, 1, 12, tzinfo=ZoneInfo("UTC")))
        self.eq(next_fire("0 0 * * 7", utc(2026, 11, 2), "UTC"), datetime(2026, 11, 8, tzinfo=ZoneInfo("UTC")))
        self.assertIsNone(next_fire("0 0 30 2 *", utc(2026, 1, 1), "UTC"))
        self.eq(next_fire("0 0 29 2 *", utc(2026, 1, 1), "UTC"), datetime(2028, 2, 29, tzinfo=ZoneInfo("UTC")))

    def test_dom_dow_rule(self):
        # Restricted both: either. 2026-11-13 is a Friday.
        self.eq(next_fire("0 0 13 * fri", utc(2026, 11, 2), "UTC"), datetime(2026, 11, 6, tzinfo=ZoneInfo("UTC")))
        # dow starts with '*': both must match -> the 13th that is also any day.
        self.eq(next_fire("0 0 13 * */1", utc(2026, 11, 2), "UTC"), datetime(2026, 11, 13, tzinfo=ZoneInfo("UTC")))
        # dom '*': only the weekday.
        self.eq(next_fire("0 0 * * fri", utc(2026, 11, 2), "UTC"), datetime(2026, 11, 6, tzinfo=ZoneInfo("UTC")))

    def test_spring_forward(self):
        # 2026-03-08 02:00 Denver doesn't exist; 02:30 never fires that day.
        self.eq(next_fire("30 2 * * *", datetime(2026, 3, 7, 3, 0, tzinfo=DEN), "America/Denver"), datetime(2026, 3, 9, 2, 30, tzinfo=DEN))
        self.eq(next_fire("*/20 * * * *", datetime(2026, 3, 8, 1, 50, tzinfo=DEN), "America/Denver"), datetime(2026, 3, 8, 3, 0, tzinfo=DEN))

    def test_fall_back(self):
        # 2026-11-01 01:00-01:59 happens twice in Denver; fires only the first time.
        first = datetime(2026, 11, 1, 1, 30, tzinfo=DEN)
        self.eq(next_fire("30 1 * * *", datetime(2026, 11, 1, 0, 0, tzinfo=DEN), "America/Denver"), first)
        after_first = utc(2026, 11, 1, 7, 45)  # 01:45 first pass (MDT)
        self.eq(next_fire("30 1 * * *", after_first, "America/Denver"), datetime(2026, 11, 2, 1, 30, tzinfo=DEN))
        self.eq(next_fire("*/30 * * * *", after_first, "America/Denver"), datetime(2026, 11, 1, 2, 0, tzinfo=DEN))

    def test_after_any_zone(self):
        a = datetime(2026, 6, 1, 12, 0, tzinfo=timezone(timedelta(hours=5, minutes=30)))
        self.eq(next_fire("0 * * * *", a, "UTC"), datetime(2026, 6, 1, 7, 0, tzinfo=ZoneInfo("UTC")))

    def test_invalid(self):
        a = utc(2026, 1, 1)
        for bad in ("* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8",
                    "5/15 * * * *", "*/0 * * * *", "10-5 * * * *", "1,,2 * * * *", "* * * foo *", "* * * * monday",
                    "a * * * *", "-1 * * * *", "*/x * * * *", "1-2-3 * * * *", ""):
            with self.assertRaises(ValueError, msg=bad):
                next_fire(bad, a, "UTC")
        with self.assertRaises(ValueError):
            next_fire("* * * * *", datetime(2026, 1, 1), "UTC")
        with self.assertRaises(ValueError):
            next_fire("* * * * *", a, "Mars/Olympus")


ZONES = ["UTC", "America/Denver", "Europe/London", "Asia/Kolkata", "Australia/Sydney", "America/St_Johns"]
TRANSITIONS = [utc(2026, 3, 8, 9), utc(2026, 11, 1, 8), utc(2026, 3, 29, 1), utc(2026, 10, 25, 1),
               utc(2026, 4, 4, 16), utc(2026, 10, 3, 16), utc(2026, 3, 8, 5, 30), utc(2026, 11, 1, 4, 30)]


def gen_field(r, lo, hi, names=None):
    items = []
    for _ in range(r.choice([1, 1, 1, 2, 3])):
        k = r.random()
        if k < 0.3:
            items.append("*" + (f"/{r.randint(1, 8)}" if r.random() < 0.4 else ""))
        elif k < 0.65:
            v = r.randint(lo, hi)
            items.append(names[v - (1 if hi == 12 else 0)] if names and r.random() < 0.3 and v - (1 if hi == 12 else 0) < len(names) else str(v))
        else:
            a = r.randint(lo, hi); b = r.randint(a, hi)
            items.append(f"{a}-{b}" + (f"/{r.randint(1, 5)}" if r.random() < 0.3 else ""))
    return ",".join(items)


def gen(r):
    return " ".join([gen_field(r, 0, 59), gen_field(r, 0, 23), gen_field(r, 1, 31) if r.random() < 0.5 else "*",
                     gen_field(r, 1, 12, ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]) if r.random() < 0.3 else "*",
                     gen_field(r, 0, 7, ["sun", "mon", "tue", "wed", "thu", "fri", "sat"]) if r.random() < 0.5 else "*"])


def outcome(f, *a):
    try:
        v = f(*a)
        return None if v is None else (v.astimezone(UTC), v.utcoffset(), v.second, v.microsecond, v.fold, str(v.tzinfo))
    except ValueError:
        return "ValueError"


class Fuzz(unittest.TestCase):
    def test_fuzz(self):
        r = random.Random(11)
        bad = []
        for i in range(500):
            expr = gen(r)
            if r.random() < 0.15:
                s = list(expr); s[r.randrange(len(s))] = r.choice(list("*-/,x9 "))
                expr = "".join(s)
            tz = r.choice(ZONES)
            if r.random() < 0.5:
                after = r.choice(TRANSITIONS) + timedelta(minutes=r.randint(-180, 180), seconds=r.randint(0, 59))
            else:
                after = utc(2026, 1, 1) + timedelta(minutes=r.randint(0, 2 * 525600))
            if r.random() < 0.3:
                after = after.astimezone(ZoneInfo(r.choice(ZONES)))
            want = outcome(ref_cron.next_fire, expr, after, tz)
            try:
                got = outcome(next_fire, expr, after, tz)
            except Exception as e:
                got = ("crash", type(e).__name__)
            if got != want:
                bad.append((expr, after.isoformat(), tz, got, want))
        self.assertEqual(len(bad), 0, f"{len(bad)}/500 differ, e.g. {bad[:3]}")
