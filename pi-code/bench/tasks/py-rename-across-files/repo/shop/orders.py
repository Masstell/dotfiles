from shop.users import fetch_user


def order_summary(order):
    user = fetch_user(order["user_id"])
    name = user["name"] if user else "unknown"
    return f"{name}: {len(order['items'])} items"
