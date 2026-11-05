"""next_fire(expr, after, tz): see SPEC.md."""
from datetime import timedelta, timezone
from zoneinfo import ZoneInfo

MONTHS = "jan feb mar apr may jun jul aug sep oct nov dec".split()
DAYS = "sun mon tue wed thu fri sat".split()
LIMITS = [(0, 59, None), (0, 23, None), (1, 31, None), (1, 12, MONTHS), (0, 7, DAYS)]
HORIZON = timedelta(days=5 * 366)


def _value(tok, lo, hi, names):
    t = tok.lower()
    if names and t in names:
        v = names.index(t) + (1 if names is MONTHS else 0)
    elif t.isascii() and t.isdigit():
        v = int(t)
    else:
        raise ValueError(f"bad value {tok!r}")
    if not lo <= v <= hi:
        raise ValueError(f"{v} out of range {lo}-{hi}")
    return v


def _field(text, lo, hi, names):
    out = set()
    for item in text.split(","):
        if not item:
            raise ValueError("empty item")
        rng, _, step = item.partition("/")
        if "/" in item:
            if not (step.isascii() and step.isdigit()) or int(step) < 1:
                raise ValueError(f"bad step {item!r}")
            s = int(step)
        else:
            s = 1
        if rng == "*":
            a, b = lo, hi
        elif "-" in rng:
            x, _, y = rng.partition("-")
            a, b = _value(x, lo, hi, names), _value(y, lo, hi, names)
            if a > b:
                raise ValueError(f"backwards range {item!r}")
        else:
            if "/" in item:
                raise ValueError(f"step after a single value {item!r}")
            a = b = _value(rng, lo, hi, names)
        out.update(range(a, b + 1, s))
    return out


def parse(expr):
    parts = expr.split()
    if len(parts) != 5:
        raise ValueError("need 5 fields")
    f = [_field(p, *LIMITS[i]) for i, p in enumerate(parts)]
    dow = {d % 7 for d in f[4]}
    return f[0], f[1], f[2], f[3], dow, not parts[2].startswith("*"), not parts[4].startswith("*")


def _day_ok(c, d):
    _, _, dom, mon, dow, rdom, rdow = c
    if d.month not in mon:
        return False
    a, b = d.day in dom, (d.isoweekday() % 7) in dow
    return (a or b) if (rdom and rdow) else (a and b)


def next_fire(expr, after, tz):
    if after.tzinfo is None or after.utcoffset() is None:
        raise ValueError("after must be timezone-aware")
    try:
        z = ZoneInfo(tz)
    except Exception:
        raise ValueError(f"unknown time zone {tz!r}")
    c = parse(expr)
    minutes = sorted(c[0])
    t = after.astimezone(timezone.utc).replace(second=0, microsecond=0) + timedelta(minutes=1)
    end = after.astimezone(timezone.utc) + HORIZON
    while t <= end:
        loc = t.astimezone(z)
        if loc.fold == 1 or not _day_ok(c, loc) or loc.hour not in c[1]:
            # The rest of this wall-clock hour can't match either.
            t += timedelta(minutes=60 - loc.minute)
            continue
        nxt = next((m for m in minutes if m >= loc.minute), None)
        if nxt is None:
            t += timedelta(minutes=60 - loc.minute)
            continue
        if nxt > loc.minute:
            t += timedelta(minutes=nxt - loc.minute)
            continue
        return loc if t <= end else None
    return None
