from shop.users import get_user


def order_summary(order):
    user = get_user(order["user_id"])
    name = user["name"] if user else "unknown"
    return f"{name}: {len(order['items'])} items"
