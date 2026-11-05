def unique_in_order(rows):
    """Rows with a duplicate email removed, keeping the first. Emails compare case-insensitively,
    ignoring surrounding spaces."""
    seen = set()
    out = []
    for row in rows:
        key = row["email"].strip().lower()
        if key not in seen:
            seen.add(key)
            out.append(row)
    return out
