# Open issues

- #12 `add(1, 3)` then `add(3, 5)` leaves two intervals; they should merge.
- #15 `remove(4, 6)` from `[0, 10)` removes everything instead of leaving `[0, 4)` and `[6, 10)`.
- #19 The importer adds ~40k ranges and takes minutes.
- #21 `first_gap` sometimes returns a number that is in the set.
