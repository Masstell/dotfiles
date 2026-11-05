USERS = {1: {"id": 1, "name": "Ada"}, 2: {"id": 2, "name": "Linus"}}


def fetch_user(uid):
    """The user with this id, or None."""
    return USERS.get(uid)
