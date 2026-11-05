def format_invoice(lines, currency="USD"):
    out = []
    total = 0
    for name, cents in lines:
        total += cents
        sign = "-" if cents < 0 else ""
        whole, frac = divmod(abs(cents), 100)
        amount = f"{sign}{whole:,}.{frac:02d}"
        sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency, currency + " ")
        out.append(f"{name:<20}{sym}{amount:>12}")
    sign = "-" if total < 0 else ""
    whole, frac = divmod(abs(total), 100)
    amount = f"{sign}{whole:,}.{frac:02d}"
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency, currency + " ")
    out.append(f"{'TOTAL':<20}{sym}{amount:>12}")
    return "\n".join(out)


def format_receipt(paid_cents, change_cents, currency="USD"):
    sym = {"USD": "$", "EUR": "€", "GBP": "£"}.get(currency, currency + " ")
    sign = "-" if paid_cents < 0 else ""
    whole, frac = divmod(abs(paid_cents), 100)
    paid = f"{sym}{sign}{whole:,}.{frac:02d}"
    sign = "-" if change_cents < 0 else ""
    whole, frac = divmod(abs(change_cents), 100)
    change = f"{sym}{sign}{whole:,}.{frac:02d}"
    return f"Paid {paid}, change {change}"
