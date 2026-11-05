import pathlib
import random
import sqlite3
import unittest
from minisql import query, SqlError

ROOT = pathlib.Path(__file__).resolve().parent.parent
COLS = ["id", "a", "b", "s", "g"]
TYPES = {"id": "INTEGER", "a": "INTEGER", "b": "INTEGER", "s": "TEXT", "g": "TEXT"}
INTS, STRS = ["id", "a", "b"], ["s", "g"]


def make_table(r):
    rows = []
    for i in range(r.randint(0, 25)):
        rows.append((i + 1,
                     None if r.random() < 0.1 else r.randint(0, 5),
                     None if r.random() < 0.3 else r.randint(-3, 3),
                     None if r.random() < 0.2 else r.choice(["x", "y", "z", "xy", "Y", "", "x'y"]),
                     r.choice(["p", "q", "r"])))
    return rows


def lit(r, col):
    if col in INTS:
        return str(r.randint(-4, 6))
    return "'" + r.choice(["x", "y", "xy", "Y", "", "p", "q", "x'y"]).replace("'", "''") + "'"


def kw(r, w):
    return r.choice([w, w.lower(), w.capitalize()])


def gen_cond(r, depth):
    k = r.random()
    if depth > 0 and k < 0.25:
        return f"{gen_cond(r, depth - 1)} {kw(r, r.choice(['AND', 'OR']))} {gen_cond(r, depth - 1)}"
    if depth > 0 and k < 0.35:
        return f"{kw(r, 'NOT')} {gen_cond(r, depth - 1)}"
    if depth > 0 and k < 0.45:
        return f"({gen_cond(r, depth - 1)})"
    col = r.choice(COLS)
    k = r.random()
    if k < 0.15:
        return f"{col} {kw(r, 'IS')} {kw(r, 'NOT') + ' ' if r.random() < 0.5 else ''}{kw(r, 'NULL')}"
    op = r.choice(["=", "!=", "<>", "<", "<=", ">", ">="])
    if k < 0.3:
        other = r.choice(INTS if col in INTS else STRS)
    elif k < 0.37:
        other = kw(r, "NULL")
    else:
        other = lit(r, col)
    return f"{col} {op} {other}" if r.random() < 0.8 else f"{other} {op} {col}"


def gen_query(r):
    where = f" {kw(r, 'WHERE')} {gen_cond(r, r.randint(0, 3))}" if r.random() < 0.7 else ""
    if r.random() < 0.5:
        sel = ["*"] if r.random() < 0.2 else r.sample(COLS, r.randint(1, 4))
        out = COLS if sel == ["*"] else sel
        group = ""
    else:
        g = r.sample(["a", "g", "s", "b"], r.randint(0, 2))
        aggs = []
        for _ in range(r.randint(1, 3)):
            f = r.choice(["COUNT", "SUM", "MIN", "MAX", "AVG", "COUNT"])
            arg = "*" if f == "COUNT" and r.random() < 0.4 else r.choice(INTS if f in ("SUM", "AVG") else COLS)
            aggs.append(f"{kw(r, f)}({arg})")
        sel = g + aggs
        r.shuffle(sel)
        out = sel
        group = f" {kw(r, 'GROUP')} {kw(r, 'BY')} {', '.join(g)}" if g else ""
    order = ""
    ordered = r.random() < 0.75
    if ordered:
        idxs = list(range(len(out)))
        r.shuffle(idxs)
        parts = []
        for i in idxs:
            ref = str(i + 1) if r.random() < 0.25 or sel == ["*"] and r.random() < 0.5 else out[i]
            parts.append(ref + r.choice(["", " ASC", " DESC", " asc", " desc"]))
        order = f" {kw(r, 'ORDER')} {kw(r, 'BY')} " + ", ".join(parts)
    limit = ""
    if ordered and r.random() < 0.4:
        limit = f" {kw(r, 'LIMIT')} {r.randint(0, 8)}" + (f" {kw(r, 'OFFSET')} {r.randint(0, 5)}" if r.random() < 0.5 else "")
    return f"{kw(r, 'SELECT')} {', '.join(sel)} {kw(r, 'FROM')} t{where}{group}{order}{limit}", ordered


def norm(rows, ordered):
    rows = [tuple(round(v, 9) if isinstance(v, float) else v for v in row) for row in rows]
    return rows if ordered else sorted(rows, key=repr)


class Fuzz(unittest.TestCase):
    def test_against_sqlite(self):
        r = random.Random(23)
        bad = []
        n = 2500
        for i in range(n):
            rows = make_table(r)
            db = sqlite3.connect(":memory:")
            db.execute("CREATE TABLE t (" + ", ".join(f"{c} {TYPES[c]}" for c in COLS) + ")")
            db.executemany("INSERT INTO t VALUES (?, ?, ?, ?, ?)", rows)
            sql, ordered = gen_query(r)
            want = norm(db.execute(sql).fetchall(), ordered)
            try:
                got = norm(query(list(COLS), list(rows), sql), ordered)
            except Exception as e:
                got = f"{type(e).__name__}: {e}"
            if got != want:
                bad.append((sql, rows[:6], got if isinstance(got, str) else got[:6], want[:6]))
        self.assertEqual(len(bad), 0, f"{len(bad)}/{n} queries differ from SQLite, e.g. {bad[:2]}")


class Cases(unittest.TestCase):
    rows = [(1, 2, None, "x", "p"), (2, None, 1, None, "q"), (3, 2, 3, "y", "p")]

    def q(self, sql):
        return query(COLS, self.rows, sql)

    def test_no_database_library(self):
        src = (ROOT / "minisql.py").read_text()
        self.assertNotIn("sqlite", src)

    def test_empty_aggregate(self):
        self.assertEqual(self.q("SELECT COUNT(*), SUM(a), AVG(b), MIN(s) FROM t WHERE id > 99"), [(0, None, None, None)])
        self.assertEqual(self.q("SELECT g, COUNT(*) FROM t WHERE id > 99 GROUP BY g"), [])

    def test_three_valued(self):
        self.assertEqual(self.q("SELECT id FROM t WHERE NOT (b > 1) ORDER BY id"), [(2,)])
        self.assertEqual(self.q("SELECT id FROM t WHERE b > 1 OR a = 2 ORDER BY id"), [(1,), (3,)])
        self.assertEqual(self.q("SELECT id FROM t WHERE NOT (a = 2 AND b IS NULL) ORDER BY 1"), [(2,), (3,)])
        self.assertEqual(self.q("SELECT id FROM t WHERE a = NULL OR a <> NULL"), [])

    def test_strings_and_order(self):
        self.assertEqual(self.q("SELECT s FROM t ORDER BY s"), [(None,), ("x",), ("y",)])
        self.assertEqual(self.q("SELECT s FROM t ORDER BY s DESC"), [("y",), ("x",), (None,)])
        self.assertEqual(query(["s"], [("it's",)], "SELECT s FROM t WHERE s = 'it''s'"), [("it's",)])
        self.assertEqual(self.q("select ID from T where A >= -1 order by Id desc limit 2 offset 1"), [(1,)])

    def test_errors(self):
        for bad in ("SELECT nope FROM t", "SELECT * FROM u", "SELECT * FROM t GROUP BY g", "SELECT a, COUNT(*) FROM t",
                    "SELECT a, COUNT(*) FROM t GROUP BY g", "SELECT SUM(*) FROM t", "SELECT a FROM t ORDER BY b",
                    "SELECT a FROM t ORDER BY 2", "SELECT a FROM t ORDER BY 0", "SELECT a FROM t WHERE", "SELECT FROM t",
                    "SELECT a FROM t LIMIT", "SELECT a FROM t LIMIT -1", "SELECT a t", "SELECT a FROM t WHERE zz = 1",
                    "SELECT a FROM t GROUP BY zz", "SELECT a FROM t WHERE a = 1 junk", "SELECT a FROM t WHERE (a = 1",
                    "SELECT a FROM t GROUP BY a ORDER BY COUNT(*)", "SELECT a FROM t WHERE a IS 1", "SELECT a FROM t OFFSET 1"):
            with self.assertRaises(SqlError, msg=bad):
                self.q(bad)
