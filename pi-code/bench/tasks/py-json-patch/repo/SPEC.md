# apply_patch(doc, patch)

Applies a JSON Patch (RFC 6902) to `doc` (Python values as `json.loads` makes them) and returns the result.
Any problem raises `PatchError`. `doc` and `patch` are never modified, and the result shares no mutable
object with either. If any operation fails, nothing is applied (the caller just gets the error).

Details, where the RFCs leave room or are easy to get wrong:

- `patch` must be a list of dicts. Each needs `op` (one of add, remove, replace, move, copy, test) and a
  string `path`; `add`, `replace` and `test` need a `value` member (its value may be `None`); `move` and
  `copy` need a string `from`. Other members are ignored.
- JSON Pointer (RFC 6901): `""` is the whole document; anything else starts with `/`. In each token,
  `~1` means `/` and `~0` means `~` (so `~01` is `~1`); any other `~` is an error.
- Array index tokens are `0` or a number without leading zeros. `-` means "after the last element"
  and is valid only as the final token of an `add` path or of a `move`/`copy` target path. For `add`
  (and `move`/`copy` targets) the index may equal the array's length (append); otherwise it must be less.
- Going through a value that is not an object or array, or a missing member, is an error.
- `add` with path `""` replaces the whole document. `add` to an existing object member replaces it.
  The parent of the target must exist.
- `remove` and `replace` need the target to exist. `remove` with path `""` is an error;
  `replace` with path `""` replaces the whole document.
- `move`: `from` must exist; moving a value into one of its own children (from is a proper prefix of
  path, comparing tokens) is an error; it behaves as removing `from` and then adding at `path` (so array
  indices in `path` refer to the array after the removal). `from` equal to `path` changes nothing.
- `copy`: adds a deep copy of the value at `from` at `path`.
- `test`: passes when the value at `path` equals `value` in JSON terms: numbers are equal when
  mathematically equal (`1` equals `1.0`), but `true`/`false` are not numbers (`true` does not equal `1`);
  arrays are equal element by element in order; objects have the same members with equal values.
