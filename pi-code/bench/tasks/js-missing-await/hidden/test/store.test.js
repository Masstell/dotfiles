const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { saveAll, loadAll } = require("../store.js");

test("save then load immediately", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "store-"));
  const recs = Array.from({ length: 300 }, (_, i) => ({ id: i, name: "x".repeat(2000) }));
  assert.strictEqual(await saveAll(dir, recs), 300);
  assert.deepStrictEqual(await loadAll(dir), recs);
});

test("saving into a missing folder rejects", async () => {
  await assert.rejects(saveAll(path.join(os.tmpdir(), "no-such-dir-" + process.pid, "x"), [{ id: 1 }]));
});
