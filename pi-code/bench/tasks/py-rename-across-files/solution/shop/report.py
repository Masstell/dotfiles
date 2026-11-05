from shop import users


def names(ids):
    return [u["name"] for u in (users.get_user(i) for i in ids) if u]
