from decimal import Decimal, ROUND_HALF_UP


def round_half_up(x, places=0):
    """Round x to `places` decimals, halves away from zero (as people do by hand)."""
    q = Decimal(1).scaleb(-places)
    return float(Decimal(str(x)).quantize(q, rounding=ROUND_HALF_UP))
