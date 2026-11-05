def round_half_up(x, places=0):
    """Round x to `places` decimals, halves away from zero (as people do by hand)."""
    m = 10 ** places
    return int(x * m + 0.5) / m
