const { test } = require("node:test");
const assert = require("node:assert");
const { Emitter } = require("../emitter.js");

test("on and emit", () => {
  const e = new Emitter();
  const got = [];
  e.on("x", (a, b) => got.push(a + b));
  assert.strictEqual(e.emit("x", 1, 2), true);
  assert.deepStrictEqual(got, [3]);
  assert.strictEqual(e.emit("y"), false);
});
