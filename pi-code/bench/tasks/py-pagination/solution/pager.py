def paginate(items, page, per_page):
    """Return the items on page `page` (1-based), per_page items per page."""
    if per_page < 1:
        raise ValueError("per_page must be at least 1")
    if page < 1:
        raise ValueError("page must be at least 1")
    start = (page - 1) * per_page
    return items[start:start + per_page]


def page_count(n_items, per_page):
    """How many pages n_items fill, counting a final partial page."""
    if per_page < 1:
        raise ValueError("per_page must be at least 1")
    return -(-n_items // per_page)
