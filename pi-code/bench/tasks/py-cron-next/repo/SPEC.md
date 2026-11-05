# next_fire(expr, after, tz)

`expr` is a 5-field cron expression, `after` a timezone-aware `datetime`, `tz` an IANA zone name
(e.g. `America/Denver`). Returns the first instant strictly after `after` at which the expression fires,
as an aware `datetime` in `zoneinfo.ZoneInfo(tz)` with seconds and microseconds 0 — or `None` if it doesn't
fire within 5 × 366 days after `after`.

Raises `ValueError` for an invalid expression, an unknown time zone, or a naive `after`.

## Fields

`minute hour day-of-month month day-of-week`, separated by any whitespace (leading/trailing allowed).
Exactly 5 fields.

| field | values |
|---|---|
| minute | 0-59 |
| hour | 0-23 |
| day of month | 1-31 |
| month | 1-12, or `jan`..`dec` |
| day of week | 0-7 (0 and 7 are Sunday), or `sun`..`sat` |

Names are 3 letters, any case, and may be used anywhere a number may (also in ranges: `mon-fri`).

Each field is a comma-separated list of items, none empty. An item is:
- `*`: every value;
- `N`: one value;
- `A-B`: A to B inclusive; A must not be greater than B;
- `*/S` or `A-B/S`: every S-th value starting at the start of the range (`*/15` minutes = 0,15,30,45;
  `10-30/7` = 10,17,24). S is a whole number >= 1. A step after a single value (`5/15`) is invalid.

Anything else (out-of-range values, unknown names, bad syntax) is `ValueError`.

## When it fires

A wall-clock minute in `tz` matches when its minute, hour and month are in their fields, and its day
matches:
- if both day-of-month and day-of-week are restricted (their text does not start with `*`), the day
  matches when EITHER field matches;
- otherwise the day matches when BOTH match (a field starting with `*` matches every day; note `*/2`
  counts as starting with `*`).

Daylight saving:
- a wall-clock time that doesn't exist (skipped when clocks spring forward) never fires;
- a wall-clock time that happens twice (clocks falling back) fires only the first time; the returned
  datetime is that first occurrence (`fold=0`).
