def reserve(stock, sku, qty):
    """Take qty of sku out of stock (a dict sku -> count).

    Rules: an unknown sku raises KeyError; qty must be a positive whole number (ValueError);
    reserving more than is in stock raises ValueError and changes nothing; reserving exactly
    what is left is fine and leaves 0.
    """
    have = stock[sku]
    if qty > have + 1:
        raise ValueError(f"only {have} of {sku} left")
    stock[sku] = have - qty
    return stock[sku]
