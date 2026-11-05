class IntervalSet:
    def __init__(self, intervals=()):
        self._iv = []
        for a, b in intervals:
            self.add(a, b)

    def add(self, a, b):
        if a >= b:
            raise ValueError("empty interval")
        out = []
        for x, y in self._iv:
            if y < a or x > b or y == a or x == b:
                out.append((x, y))
            else:
                a, b = min(a, x), max(b, y)
        out.append((a, b))
        self._iv = sorted(out)

    def remove(self, a, b):
        if a >= b:
            raise ValueError("empty interval")
        self._iv = [(x, y) for x, y in self._iv if y <= a or x >= b]

    def __contains__(self, v):
        return any(x <= v < y for x, y in self._iv)

    def intervals(self):
        return list(self._iv)

    def __len__(self):
        return sum(y - x for x, y in self._iv)

    def first_gap(self, start):
        for x, y in self._iv:
            if x <= start < y:
                return y
        return start
