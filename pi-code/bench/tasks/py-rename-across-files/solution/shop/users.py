import warnings

USERS = {1: {"id": 1, "name": "Ada"}, 2: {"id": 2, "name": "Linus"}}


def get_user(uid):
    """The user with this id, or None."""
    return USERS.get(uid)


def fetch_user(uid):
    """Deprecated: use get_user."""
    warnings.warn("fetch_user is deprecated; use get_user", DeprecationWarning, stacklevel=2)
    return get_user(uid)
