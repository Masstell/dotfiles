# IntervalSet

A set of integers stored as half-open intervals `[a, b)` (a included, b not).

- `IntervalSet(intervals=())`: starts empty, then `add`s each `(a, b)` pair given.
- `add(a, b)` / `remove(a, b)`: add or remove every integer x with a <= x < b. `a >= b` raises
  `ValueError` and changes nothing.
- `x in s`: whether x is in the set.
- `s.intervals()`: a new list of `(a, b)` tuples, sorted, covering exactly the set's integers, with no
  two touching or overlapping (`[1, 3)` and `[3, 5)` are one interval `(1, 5)`).
- `len(s)`: how many integers are in the set.
- `s.first_gap(start)`: the smallest integer x >= start that is not in the set.
- `s.complement(lo, hi)`: a new IntervalSet of the integers in `[lo, hi)` that are not in s.
  `lo > hi` raises `ValueError`; `lo == hi` gives an empty set.
- `s | t`, `s & t`, `s - t`: new IntervalSets (union, intersection, difference); s and t are unchanged.
- `s == t`: same integers. `bool(s)`: not empty.
- `s.span()`: `(min, max + 1)` of the set's integers, or `None` if empty.

Performance: with tens of thousands of intervals, each `add`, `remove`, `in` and `first_gap` must take
well under a millisecond (no scanning every interval per operation).
