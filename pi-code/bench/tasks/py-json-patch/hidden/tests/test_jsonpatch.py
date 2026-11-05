import copy
import json
import unittest
from jsonpatch import apply_patch, PatchError


def ok(doc, patch, want):
    return ("ok", doc, patch, want)


def err(doc, patch):
    return ("err", doc, patch, None)


CASES = [
    # RFC 6902 appendix A
    ok({"foo": "bar"}, [{"op": "add", "path": "/baz", "value": "qux"}], {"baz": "qux", "foo": "bar"}),
    ok({"foo": ["bar", "baz"]}, [{"op": "add", "path": "/foo/1", "value": "qux"}], {"foo": ["bar", "qux", "baz"]}),
    ok({"baz": "qux", "foo": "bar"}, [{"op": "remove", "path": "/baz"}], {"foo": "bar"}),
    ok({"foo": ["bar", "qux", "baz"]}, [{"op": "remove", "path": "/foo/1"}], {"foo": ["bar", "baz"]}),
    ok({"baz": "qux", "foo": "bar"}, [{"op": "replace", "path": "/baz", "value": "boo"}], {"baz": "boo", "foo": "bar"}),
    ok({"foo": {"bar": "baz", "waldo": "fred"}, "qux": {"corge": "grault"}},
       [{"op": "move", "from": "/foo/waldo", "path": "/qux/thud"}],
       {"foo": {"bar": "baz"}, "qux": {"corge": "grault", "thud": "fred"}}),
    ok({"foo": ["all", "grass", "cows", "eat"]}, [{"op": "move", "from": "/foo/1", "path": "/foo/3"}],
       {"foo": ["all", "cows", "eat", "grass"]}),
    ok({"baz": "qux", "foo": ["a", 2, "c"]},
       [{"op": "test", "path": "/baz", "value": "qux"}, {"op": "test", "path": "/foo/1", "value": 2}],
       {"baz": "qux", "foo": ["a", 2, "c"]}),
    err({"baz": "qux"}, [{"op": "test", "path": "/baz", "value": "bar"}]),
    ok({"foo": "bar"}, [{"op": "add", "path": "/child", "value": {"grandchild": {}}}], {"foo": "bar", "child": {"grandchild": {}}}),
    ok({"foo": "bar"}, [{"op": "add", "path": "/baz", "value": "qux", "xyz": 123}], {"foo": "bar", "baz": "qux"}),
    err({"foo": "bar"}, [{"op": "add", "path": "/baz/bat", "value": "qux"}]),
    ok({"/": 9, "~1": 10}, [{"op": "test", "path": "/~01", "value": 10}], {"/": 9, "~1": 10}),
    err({"/": 9, "~1": 10}, [{"op": "test", "path": "/~01", "value": "10"}]),
    ok({"foo": ["bar"]}, [{"op": "add", "path": "/foo/-", "value": ["abc", "def"]}], {"foo": ["bar", ["abc", "def"]]}),
    # pointers
    ok({"a/b": 1, "m~n": 2}, [{"op": "replace", "path": "/a~1b", "value": 3}, {"op": "remove", "path": "/m~0n"}], {"a/b": 3}),
    ok({"": {"": 1}}, [{"op": "replace", "path": "//", "value": 2}], {"": {"": 2}}),
    err({"a": 1}, [{"op": "remove", "path": "a"}]),
    err({"a~2": 1}, [{"op": "remove", "path": "/a~2"}]),
    err({"a~": 1}, [{"op": "remove", "path": "/a~"}]),
    ok({"a": 1}, [{"op": "add", "path": "", "value": [1, 2]}], [1, 2]),
    ok({"a": 1}, [{"op": "replace", "path": "", "value": None}], None),
    err({"a": 1}, [{"op": "remove", "path": ""}]),
    # arrays
    ok([1, 2], [{"op": "add", "path": "/2", "value": 3}], [1, 2, 3]),
    err([1, 2], [{"op": "add", "path": "/3", "value": 3}]),
    err([1, 2], [{"op": "add", "path": "/01", "value": 3}]),
    err([1, 2], [{"op": "add", "path": "/-1", "value": 3}]),
    err([1, 2], [{"op": "remove", "path": "/2"}]),
    err([1, 2], [{"op": "remove", "path": "/-"}]),
    err([1, 2], [{"op": "replace", "path": "/-", "value": 0}]),
    err([1, 2], [{"op": "test", "path": "/-", "value": 2}]),
    err([[1]], [{"op": "add", "path": "/-/0", "value": 2}]),
    err([1, 2], [{"op": "add", "path": "/1e0", "value": 3}]),
    ok([1, 2], [{"op": "add", "path": "/0", "value": 0}], [0, 1, 2]),
    ok({"a": [1, 2, 3]}, [{"op": "move", "from": "/a/0", "path": "/a/-"}], {"a": [2, 3, 1]}),
    ok({"a": [1, 2, 3]}, [{"op": "move", "from": "/a/0", "path": "/a/2"}], {"a": [2, 3, 1]}),
    err({"a": [1, 2, 3]}, [{"op": "move", "from": "/a/0", "path": "/a/3"}]),
    ok({"a": [1, 2]}, [{"op": "copy", "from": "/a/0", "path": "/a/-"}], {"a": [1, 2, 1]}),
    err({"a": [1, 2]}, [{"op": "copy", "from": "/a/-", "path": "/b"}]),
    # move/copy edge cases
    err({"a": {"b": 1}}, [{"op": "move", "from": "/a", "path": "/a/b/c"}]),
    ok({"a": {"b": 1}}, [{"op": "move", "from": "/a", "path": "/a"}], {"a": {"b": 1}}),
    err({"a": 1}, [{"op": "move", "from": "/x", "path": "/x"}]),
    ok({"ab": 1}, [{"op": "move", "from": "/ab", "path": "/abc"}], {"abc": 1}),
    ok({"a": {"b": 1}, "c": 2}, [{"op": "move", "from": "/a", "path": "/c"}], {"c": {"b": 1}}),
    err({"a": 1}, [{"op": "move", "from": "/b", "path": "/c"}]),
    err({"a": 1}, [{"op": "move", "path": "/c"}]),
    err({"a": 1}, [{"op": "copy", "from": 5, "path": "/c"}]),
    # test equality
    ok({"n": 1}, [{"op": "test", "path": "/n", "value": 1.0}], {"n": 1}),
    err({"n": 1}, [{"op": "test", "path": "/n", "value": True}]),
    err({"n": True}, [{"op": "test", "path": "/n", "value": 1}]),
    err({"n": 0}, [{"op": "test", "path": "/n", "value": False}]),
    err({"n": None}, [{"op": "test", "path": "/n", "value": 0}]),
    ok({"n": None}, [{"op": "test", "path": "/n", "value": None}], {"n": None}),
    ok({"n": [1, {"x": 2.0}]}, [{"op": "test", "path": "/n", "value": [1.0, {"x": 2}]}], {"n": [1, {"x": 2.0}]}),
    err({"n": [1, 2]}, [{"op": "test", "path": "/n", "value": [2, 1]}]),
    err({"n": {"a": 1}}, [{"op": "test", "path": "/n", "value": {"a": 1, "b": None}}]),
    err({"n": "1"}, [{"op": "test", "path": "/n", "value": 1}]),
    err({"n": [True]}, [{"op": "test", "path": "/n", "value": [1]}]),
    err({"n": 1}, [{"op": "test", "path": "/m", "value": None}]),
    # malformed
    err({}, {"op": "add", "path": "/a", "value": 1}),
    err({}, [["add", "/a", 1]]),
    err({}, [{"path": "/a", "value": 1}]),
    err({}, [{"op": "add", "value": 1}]),
    err({}, [{"op": "add", "path": "/a"}]),
    err({}, [{"op": "replace", "path": "/a", "value": 1}]),
    err({}, [{"op": "test", "path": ""}]),
    err({}, [{"op": "add", "path": 7, "value": 1}]),
    err({"a": "str"}, [{"op": "add", "path": "/a/b", "value": 1}]),
    err({"a": 5}, [{"op": "remove", "path": "/a/0"}]),
    ok({"a": 1}, [{"op": "add", "path": "/a", "value": None}], {"a": None}),
    ok({}, [], {}),
]


class Cases(unittest.TestCase):
    def test_cases(self):
        bad = []
        for i, (kind, doc, patch, want) in enumerate(CASES):
            before = copy.deepcopy(doc)
            pbefore = copy.deepcopy(patch)
            try:
                got = ("ok", apply_patch(doc, patch))
            except PatchError:
                got = ("err",)
            except Exception as e:
                got = ("crash", type(e).__name__)
            if kind == "ok" and (got[0] != "ok" or json.dumps(got[1], sort_keys=True) != json.dumps(want, sort_keys=True)):
                bad.append((i, patch, got, want))
            if kind == "err" and got != ("err",):
                bad.append((i, patch, got, "PatchError"))
            if doc != before or patch != pbefore:
                bad.append((i, "input modified"))
        self.assertEqual(len(bad), 0, f"{len(bad)} cases wrong: {bad[:4]}")

    def test_atomic_and_no_sharing(self):
        doc = {"a": [1, 2], "b": {"c": 1}}
        with self.assertRaises(PatchError):
            apply_patch(doc, [{"op": "add", "path": "/a/-", "value": 3}, {"op": "remove", "path": "/zz"}])
        self.assertEqual(doc, {"a": [1, 2], "b": {"c": 1}})
        v = {"deep": [1]}
        patch = [{"op": "add", "path": "/v", "value": v}, {"op": "copy", "from": "/b", "path": "/d"}]
        out = apply_patch(doc, patch)
        v["deep"].append(2)
        out["a"].append(99)
        out["d"]["c"] = 5
        self.assertEqual(out["v"], {"deep": [1]})
        self.assertEqual(doc, {"a": [1, 2], "b": {"c": 1}})
        self.assertEqual(out["b"], {"c": 1})
