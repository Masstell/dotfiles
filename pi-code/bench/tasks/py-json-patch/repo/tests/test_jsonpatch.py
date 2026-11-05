import unittest
from jsonpatch import apply_patch, PatchError


class PatchTest(unittest.TestCase):
    def test_add(self):
        self.assertEqual(apply_patch({"a": 1}, [{"op": "add", "path": "/b", "value": 2}]), {"a": 1, "b": 2})

    def test_bad_op(self):
        with self.assertRaises(PatchError):
            apply_patch({}, [{"op": "explode", "path": "/a"}])
