import unittest
import inventory


class InventoryTest(unittest.TestCase):
    def test_table(self):
        t = inventory.to_table([{"name": "a", "qty": 1, "price": 2}])
        self.assertIn("a", t)
