import os
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def run(*args):
    return subprocess.run([sys.executable, os.path.join(HERE, "cleanup.py"), *args], capture_output=True, text=True)


class CleanupTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.old = os.path.join(self.dir, "old.log")
        self.new = os.path.join(self.dir, "new.log")
        for p in (self.old, self.new):
            open(p, "w").close()
        t = time.time() - 40 * 86400
        os.utime(self.old, (t, t))

    def test_deletes_old_only(self):
        r = run(self.dir, "--days", "7")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(os.path.exists(self.old))
        self.assertTrue(os.path.exists(self.new))


if __name__ == "__main__":
    unittest.main()
