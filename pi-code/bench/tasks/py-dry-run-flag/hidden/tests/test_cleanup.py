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


    def test_dry_run_deletes_nothing(self):
        r = run(self.dir, "--days", "7", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(self.old))
        self.assertTrue(os.path.exists(self.new))
        self.assertIn(f"would delete {self.old}", r.stdout)
        self.assertNotIn(self.new, r.stdout)

    def test_dry_run_after_folder(self):
        r = run("--dry-run", self.dir)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(os.path.exists(self.old))


if __name__ == "__main__":
    unittest.main()
