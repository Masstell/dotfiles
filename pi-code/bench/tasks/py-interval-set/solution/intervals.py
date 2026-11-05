from bisect import bisect_left, bisect_right


class IntervalSet:
    """Integers as sorted, disjoint, non-touching half-open intervals (two parallel lists)."""

    def __init__(self, intervals=()):
        self._s = []
        self._e = []
        for a, b in intervals:
            self.add(a, b)

    @classmethod
    def _of(cls, pairs):
        n = cls()
        for a, b in pairs:
            n._s.append(a)
            n._e.append(b)
        return n

    def add(self, a, b):
        if a >= b:
            raise ValueError("empty interval")
        i = bisect_left(self._e, a)       # first interval ending at or after a (touching merges)
        j = bisect_right(self._s, b)      # past the last interval starting at or before b
        if i < j:
            a = min(a, self._s[i])
            b = max(b, self._e[j - 1])
        self._s[i:j] = [a]
        self._e[i:j] = [b]

    def remove(self, a, b):
        if a >= b:
            raise ValueError("empty interval")
        i = bisect_right(self._e, a)      # first interval ending after a
        j = bisect_left(self._s, b)       # past the last interval starting before b
        if i >= j:
            return
        ns, ne = [], []
        if self._s[i] < a:
            ns.append(self._s[i]); ne.append(a)
        if self._e[j - 1] > b:
            ns.append(b); ne.append(self._e[j - 1])
        self._s[i:j] = ns
        self._e[i:j] = ne

    def __contains__(self, v):
        i = bisect_right(self._s, v) - 1
        return i >= 0 and v < self._e[i]

    def intervals(self):
        return list(zip(self._s, self._e))

    def __len__(self):
        return sum(self._e) - sum(self._s)

    def __bool__(self):
        return bool(self._s)

    def __eq__(self, other):
        return isinstance(other, IntervalSet) and self._s == other._s and self._e == other._e

    def first_gap(self, start):
        i = bisect_right(self._s, start) - 1
        if i >= 0 and start < self._e[i]:
            return self._e[i]
        return start

    def span(self):
        return (self._s[0], self._e[-1]) if self._s else None

    def complement(self, lo, hi):
        if lo > hi:
            raise ValueError("lo > hi")
        out, cur = [], lo
        i = max(bisect_right(self._e, lo), 0)
        while i < len(self._s) and self._s[i] < hi:
            if self._s[i] > cur:
                out.append((cur, self._s[i]))
            cur = max(cur, self._e[i])
            i += 1
        if cur < hi:
            out.append((cur, hi))
        return IntervalSet._of(out)

    def __or__(self, other):
        n = IntervalSet._of(self.intervals())
        for a, b in other.intervals():
            n.add(a, b)
        return n

    def __sub__(self, other):
        n = IntervalSet._of(self.intervals())
        for a, b in other.intervals():
            n.remove(a, b)
        return n

    def __and__(self, other):
        out, i, j = [], 0, 0
        A, B = self.intervals(), other.intervals()
        while i < len(A) and j < len(B):
            a, b = max(A[i][0], B[j][0]), min(A[i][1], B[j][1])
            if a < b:
                out.append((a, b))
            if A[i][1] < B[j][1]:
                i += 1
            else:
                j += 1
        return IntervalSet._of(out)
