const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { saveAll, loadAll } = require("../store.js");

test("save then load one record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  await saveAll(dir, [{ id: 1, name: "a" }]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepStrictEqual(await loadAll(dir), [{ id: 1, name: "a" }]);
});
