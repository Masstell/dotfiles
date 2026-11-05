import csv
import io
import json
import os
import pathlib
import subprocess
import sys
import unittest
import inventory

ROOT = pathlib.Path(__file__).resolve().parent.parent
ITEMS = [{"name": "widget", "qty": 3, "price": 2.5}, {"name": "bolt", "qty": 120, "price": 0.1}]


def cli(*args):
    return subprocess.run([sys.executable, str(ROOT / "inventory.py"), *args], capture_output=True, text=True, cwd=ROOT)


class Hidden(unittest.TestCase):
    def test_csv(self):
        rows = list(csv.reader(io.StringIO(inventory.to_csv(ITEMS))))
        self.assertEqual(rows[0], ["name", "qty", "price"])
        self.assertEqual(rows[1], ["widget", "3", "2.50"])
        self.assertEqual(rows[2], ["bolt", "120", "0.10"])

    def test_json(self):
        j = inventory.to_json(ITEMS)
        self.assertEqual([x["name"] for x in json.loads(j)], ["bolt", "widget"])
        self.assertIn("\n ", j)

    def test_cli_formats(self):
        self.assertIn("widget", cli().stdout)
        self.assertTrue(cli("--format", "csv").stdout.startswith("name,qty,price"))
        self.assertEqual(json.loads(cli("--format", "json").stdout)[0]["name"], "bolt")
        self.assertNotEqual(cli("--format", "xml").returncode, 0)

    def test_readme(self):
        self.assertIn("--format", (ROOT / "README.md").read_text())
