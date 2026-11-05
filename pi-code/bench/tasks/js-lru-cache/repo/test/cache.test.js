const { test } = require("node:test");
const assert = require("node:assert");
const { Cache } = require("../cache.js");

test("get and set", () => {
  const c = new Cache(2);
  c.set("a", 1);
  assert.strictEqual(c.get("a"), 1);
  assert.strictEqual(c.has("b"), false);
});
