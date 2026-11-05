const { test } = require("node:test");
const assert = require("node:assert");
const { Cache } = require("../cache.js");

test("get and set", () => {
  const c = new Cache(2);
  c.set("a", 1);
  assert.strictEqual(c.get("a"), 1);
  assert.strictEqual(c.has("b"), false);
  assert.strictEqual(c.get("b"), undefined);
});

test("evicts least recently used", () => {
  const c = new Cache(2);
  c.set("a", 1).set("b", 2).set("c", 3);
  assert.strictEqual(c.has("a"), false);
  assert.strictEqual(c.size, 2);
});

test("get counts as use", () => {
  const c = new Cache(2);
  c.set("a", 1); c.set("b", 2);
  c.get("a");
  c.set("c", 3);
  assert.strictEqual(c.has("a"), true);
  assert.strictEqual(c.has("b"), false);
});

test("set of existing key updates and counts as use", () => {
  const c = new Cache(2);
  c.set("a", 1); c.set("b", 2);
  c.set("a", 10);
  c.set("c", 3);
  assert.strictEqual(c.get("a"), 10);
  assert.strictEqual(c.has("b"), false);
  assert.strictEqual(c.size, 2);
});

test("keys like toString are fine", () => {
  const c = new Cache(3);
  assert.strictEqual(c.has("toString"), false);
  c.set("toString", 1);
  assert.strictEqual(c.get("toString"), 1);
});

test("large", () => {
  const c = new Cache(1000);
  for (let i = 0; i < 100000; i++) c.set(i, i);
  assert.strictEqual(c.size, 1000);
  assert.strictEqual(c.has(98999), false);
  assert.strictEqual(c.get(99999), 99999);
});
