import unittest
from slug import slugify


class SlugTest(unittest.TestCase):
    def test_basic(self):
        self.assertEqual(slugify("Hello, World!"), "hello-world")

    def test_accents(self):
        self.assertEqual(slugify("Crème Brûlée à la carte"), "creme-brulee-a-la-carte")

    def test_runs_and_edges(self):
        self.assertEqual(slugify("  --Rock & Roll!!  "), "rock-roll")
        self.assertEqual(slugify("a___b...c"), "a-b-c")

    def test_numbers(self):
        self.assertEqual(slugify("Top 10 of 2026"), "top-10-of-2026")

    def test_empty(self):
        self.assertEqual(slugify(""), "n-a")
        self.assertEqual(slugify("!!!"), "n-a")
        self.assertEqual(slugify("日本語"), "n-a")

    def test_cut_at_word(self):
        self.assertEqual(slugify("alpha beta gamma", max_len=12), "alpha-beta")
        self.assertEqual(slugify("alpha beta gamma", max_len=10), "alpha-beta")

    def test_hard_cut(self):
        self.assertEqual(slugify("abcdefghijkl", max_len=5), "abcde")

    def test_default_limit(self):
        s = slugify("word " * 30)
        self.assertLessEqual(len(s), 60)
        self.assertFalse(s.endswith("-"))
        self.assertTrue(s.startswith("word-word"))
