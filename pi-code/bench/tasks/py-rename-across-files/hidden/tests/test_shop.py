import pathlib
import unittest
import warnings

ROOT = pathlib.Path(__file__).resolve().parent.parent


class ShopTest(unittest.TestCase):
    def test_get_user(self):
        from shop.users import get_user
        self.assertEqual(get_user(1)["name"], "Ada")
        self.assertIsNone(get_user(9))

    def test_callers(self):
        from shop.orders import order_summary
        from shop.report import names
        self.assertEqual(order_summary({"user_id": 2, "items": [1, 2]}), "Linus: 2 items")
        self.assertEqual(names([1, 2, 3]), ["Ada", "Linus"])

    def test_alias_warns(self):
        from shop.users import fetch_user
        with warnings.catch_warnings(record=True) as w:
            warnings.simplefilter("always")
            self.assertEqual(fetch_user(1)["name"], "Ada")
        self.assertTrue(any(issubclass(x.category, DeprecationWarning) for x in w))

    def test_no_caller_uses_old_name(self):
        for f in (ROOT / "shop").glob("*.py"):
            if f.name != "users.py":
                self.assertNotIn("fetch_user", f.read_text(), f.name)
