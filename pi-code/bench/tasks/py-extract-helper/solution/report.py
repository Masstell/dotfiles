SYMBOLS = {"USD": "$", "EUR": "€", "GBP": "£"}


def format_money(cents, currency="USD"):
    sym = SYMBOLS.get(currency, currency + " ")
    sign = "-" if cents < 0 else ""
    whole, frac = divmod(abs(cents), 100)
    return f"{sym}{sign}{whole:,}.{frac:02d}"


def format_invoice(lines, currency="USD"):
    sym = SYMBOLS.get(currency, currency + " ")
    out = []
    total = sum(cents for _, cents in lines)
    for name, cents in [*lines, ("TOTAL", total)]:
        out.append(f"{name:<20}{sym}{format_money(cents, currency)[len(sym):]:>12}")
    return "\n".join(out)


def format_receipt(paid_cents, change_cents, currency="USD"):
    return f"Paid {format_money(paid_cents, currency)}, change {format_money(change_cents, currency)}"
