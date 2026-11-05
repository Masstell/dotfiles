import unittest
from shop.users import fetch_user
from shop.orders import order_summary


class ShopTest(unittest.TestCase):
    def test_user(self):
        self.assertEqual(fetch_user(1)["name"], "Ada")

    def test_order(self):
        self.assertEqual(order_summary({"user_id": 2, "items": [1, 2]}), "Linus: 2 items")
