import random
import time
import unittest
from intervals import IntervalSet

U = 60  # brute-force universe: 0..59 (operations reach a little outside it)


class Ref:
    def __init__(self):
        self.s = set()

    def add(self, a, b):
        self.s |= set(range(a, b))

    def remove(self, a, b):
        self.s -= set(range(a, b))

    def intervals(self):
        out = []
        for x in sorted(self.s):
            if out and out[-1][1] == x:
                out[-1][1] = x + 1
            else:
                out.append([x, x + 1])
        return [tuple(p) for p in out]


def ref_of(s):
    r = Ref()
    for a, b in s.intervals():
        r.add(a, b)
    return r


class Cases(unittest.TestCase):
    def test_issues(self):
        s = IntervalSet()
        s.add(1, 3); s.add(3, 5)
        self.assertEqual(s.intervals(), [(1, 5)])
        s = IntervalSet([(0, 10)]); s.remove(4, 6)
        self.assertEqual(s.intervals(), [(0, 4), (6, 10)])
        s = IntervalSet([(0, 5), (6, 8)])
        self.assertEqual(s.first_gap(0), 5)
        self.assertEqual(s.first_gap(5), 5)
        self.assertEqual(s.first_gap(6), 8)
        self.assertEqual(s.first_gap(-3), -3)

    def test_errors_change_nothing(self):
        s = IntervalSet([(0, 5)])
        for f in (lambda: s.add(3, 3), lambda: s.add(4, 2), lambda: s.remove(1, 1), lambda: s.complement(5, 4)):
            with self.assertRaises(ValueError):
                f()
        self.assertEqual(s.intervals(), [(0, 5)])
        self.assertEqual(s.complement(3, 3).intervals(), [])

    def test_misc(self):
        s = IntervalSet([(5, 7), (-3, -1)])
        self.assertEqual(s.span(), (-3, 7))
        self.assertIsNone(IntervalSet().span())
        self.assertFalse(IntervalSet())
        self.assertTrue(s)
        self.assertEqual(s, IntervalSet([(-3, -2), (-2, -1), (5, 7)]))
        self.assertNotEqual(s, IntervalSet([(5, 7)]))
        t = IntervalSet([(0, 6)])
        u = s | t
        self.assertEqual(s.intervals(), [(-3, -1), (5, 7)])
        self.assertEqual(u.intervals(), [(-3, -1), (0, 7)])
        self.assertEqual((s & t).intervals(), [(5, 6)])
        self.assertEqual((s - t).intervals(), [(-3, -1), (6, 7)])
        self.assertEqual(t.intervals(), [(0, 6)])
        l = s.intervals(); l.append((99, 100))
        self.assertEqual(s.intervals(), [(-3, -1), (5, 7)])

    def test_fuzz(self):
        r = random.Random(7)
        bad = []
        for case in range(400):
            s, ref = IntervalSet(), Ref()
            others = []
            for _ in range(r.randint(1, 40)):
                a = r.randint(-5, U + 5); b = a + r.choice([1, 1, 2, 3, 5, 8, 13, 0, -2])
                op = r.random()
                try:
                    if op < 0.55:
                        s.add(a, b); good = a < b
                        if good: ref.add(a, b)
                    else:
                        s.remove(a, b); good = a < b
                        if good: ref.remove(a, b)
                    if not good:
                        bad.append(("no ValueError", a, b)); break
                except ValueError:
                    if a < b:
                        bad.append(("ValueError for valid", a, b)); break
                got = s.intervals()
                if got != ref.intervals():
                    bad.append(("intervals", case, got, ref.intervals())); break
                x = r.randint(-8, U + 8)
                if (x in s) != (x in ref.s) or len(s) != len(ref.s):
                    bad.append(("in/len", case, x)); break
                g = x
                while g in ref.s:
                    g += 1
                if s.first_gap(x) != g:
                    bad.append(("first_gap", case, x, s.first_gap(x), g)); break
                lo = r.randint(-8, U); hi = lo + r.randint(0, 30)
                want = sorted(set(range(lo, hi)) - ref.s)
                if sorted(ref_of(s.complement(lo, hi)).s) != want:
                    bad.append(("complement", case, lo, hi)); break
                if r.random() < 0.2:
                    o = IntervalSet([(c, c + r.randint(1, 6)) for c in r.sample(range(-5, U), r.randint(0, 8))])
                    oref = ref_of(o)
                    before = s.intervals()
                    for name, res, w in (("|", s | o, ref.s | oref.s), ("&", s & o, ref.s & oref.s), ("-", s - o, ref.s - oref.s)):
                        rr = Ref(); rr.s = w
                        if res.intervals() != rr.intervals():
                            bad.append((name, case)); break
                    if s.intervals() != before:
                        bad.append(("operand changed", case))
        self.assertEqual(len(bad), 0, bad[:3])

    def test_speed(self):
        r = random.Random(3)
        s = IntervalSet()
        t = time.perf_counter()
        for i in range(40000):
            a = r.randrange(0, 4_000_000)
            s.add(a, a + r.randint(1, 60))
            if i % 500 == 0 and time.perf_counter() - t > 3.0:
                self.fail(f"too slow: {i} adds in 3s")
        for i in range(20000):
            if i % 500 == 0 and time.perf_counter() - t > 3.0:
                self.fail(f"too slow: {i} removes in 3s")
            a = r.randrange(0, 4_000_000)
            s.remove(a, a + r.randint(1, 30))
            a in s
            s.first_gap(a)
        dt = time.perf_counter() - t
        self.assertGreater(len(s.intervals()), 20000)
        self.assertLess(dt, 3.0, f"{dt:.1f}s for 80k operations")
