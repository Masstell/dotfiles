const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const NodeEE = require("node:events");
const { Emitter } = require("../emitter.js");

test("does not use node's events module", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "emitter.js"), "utf8");
  assert.ok(!/require\(\s*["'](node:)?events["']\s*\)|from\s+["'](node:)?events["']/.test(src));
});

test("basics", () => {
  const e = new Emitter();
  const got = [];
  const f = function (a) { got.push([this === e, a]); };
  assert.strictEqual(e.on("x", f), e);
  e.once("x", f);
  e.prependListener("x", f);
  assert.strictEqual(e.listenerCount("x"), 3);
  e.off("x", f); // the last in call order: the once registration, not the prepended one
  assert.strictEqual(e.listenerCount("x"), 2);
  assert.strictEqual(e.emit("x", 1), true);
  assert.deepStrictEqual(got, [[true, 1], [true, 1]]);
  assert.strictEqual(e.listenerCount("x"), 2);
  const g = () => got.push("g");
  e.once("z", g); e.on("z", g); e.off("z", g); // removes the on (last), keeps the once
  e.emit("z"); e.emit("z");
  assert.strictEqual(got.filter((x) => x === "g").length, 1);
  assert.throws(() => e.on("x", 5), TypeError);
  const err = new Error("boom");
  assert.throws(() => e.emit("error", err), (x) => x === err);
  assert.throws(() => e.emit("error", "str"), Error);
  e.on("error", () => {});
  assert.strictEqual(e.emit("error", "str"), true);
  assert.strictEqual(e.addListener("y", f), e);
  assert.strictEqual(e.removeListener("y", f), e);
  assert.deepStrictEqual(e.eventNames(), ["x", "error"]);
  assert.strictEqual(e.removeAllListeners(), e);
  assert.deepStrictEqual(e.eventNames(), []);
});

// Replay the same random script against Node's EventEmitter and Emitter; compare everything observable.
const EVENTS = ["a", "b", "c", "error"];
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
}

function makeScript(seed) {
  const r = rng(seed);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const behaviours = []; // per listener id: what it does when called
  for (let id = 0; id < 6; id++) {
    const acts = [];
    const n = Math.floor(r() * 3);
    for (let k = 0; k < n; k++) {
      const kind = pick(["offSelf", "on", "once", "prepend", "emit", "removeAll", "throw", "offOther", "none", "none"]);
      acts.push({ kind, ev: pick(EVENTS), other: Math.floor(r() * 6) });
    }
    behaviours.push(acts);
  }
  const ops = [];
  for (let i = 0; i < 40; i++) {
    ops.push({
      op: pick(["on", "on", "on", "once", "once", "prependListener", "prependOnceListener", "off", "off", "emit", "emit", "emit", "emit", "removeAllListeners", "removeAllEvent"]),
      ev: pick(EVENTS), id: Math.floor(r() * 6), arg: Math.floor(r() * 100), errArg: r() < 0.5,
    });
  }
  return { behaviours, ops };
}

function run(E, script) {
  const em = new E();
  const log = [];
  const fns = [];
  let depth = 0;
  for (let id = 0; id < 6; id++) {
    fns.push(function (...args) {
      log.push(["call", id, this === em, JSON.stringify(args.map((a) => (a instanceof Error ? "E:" + a.message : a)))]);
      for (const act of script.behaviours[id]) {
        if (act.kind === "offSelf") em.off(this === em ? currentEvent[currentEvent.length - 1] : "a", fns[id]);
        else if (["on", "once", "prepend"].includes(act.kind) && em.listenerCount(act.ev) >= 6) continue;
        else if (act.kind === "on") em.on(act.ev, fns[act.other]);
        else if (act.kind === "once") em.once(act.ev, fns[act.other]);
        else if (act.kind === "prepend") em.prependListener(act.ev, fns[act.other]);
        else if (act.kind === "offOther") em.off(act.ev, fns[act.other]);
        else if (act.kind === "removeAll") em.removeAllListeners(act.ev);
        else if (act.kind === "throw") throw new Error("thrown by " + id);
        else if (act.kind === "emit" && depth < 3 && act.ev !== "error") {
          depth++;
          try { log.push(["nested", act.ev, doEmit(act.ev, [id])]); } finally { depth--; }
        }
      }
    });
  }
  const currentEvent = [];
  const doEmit = (ev, args) => {
    currentEvent.push(ev);
    try { return em.emit(ev, ...args); } finally { currentEvent.pop(); }
  };
  const ids = (list) => list.map((f) => fns.indexOf(f));
  for (const o of script.ops) {
    try {
      let ret;
      if (o.op === "emit") {
        const args = o.ev === "error" ? [o.errArg ? new Error("e" + o.arg) : "s" + o.arg] : [o.arg];
        ret = doEmit(o.ev, args);
      } else if (o.op === "removeAllEvent") ret = em.removeAllListeners(o.ev) === em;
      else if (o.op === "removeAllListeners") ret = em.removeAllListeners() === em;
      else if (["on", "once", "prependListener", "prependOnceListener"].includes(o.op) && em.listenerCount(o.ev) >= 8) ret = "skipped";
      else ret = em[o.op](o.ev, fns[o.id]) === em;
      log.push(["ret", o.op, o.ev, ret]);
    } catch (e) {
      log.push(["threw", o.op, o.ev, e instanceof Error ? (/^(e\d+|thrown by \d)$/.test(e.message) ? e.message : "other error") : "non-error"]);
    }
    log.push(["state", JSON.stringify(em.eventNames()), JSON.stringify(EVENTS.map((ev) => [em.listenerCount(ev), ids(em.listeners(ev))]))]);
  }
  return log;
}

test("matches Node's EventEmitter on random scripts", () => {
  let failures = 0, first;
  for (let seed = 1; seed <= 1500; seed++) {
    const script = makeScript(seed);
    const want = run(NodeEE, script);
    let got;
    try { got = run(Emitter, script); } catch (e) { got = [["crash", String(e)]]; }
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      failures++;
      if (!first) {
        let i = 0;
        while (i < want.length && JSON.stringify(got[i]) === JSON.stringify(want[i])) i++;
        first = { seed, step: i, got: got[i], want: want[i], before: want.slice(Math.max(0, i - 3), i) };
      }
    }
  }
  assert.strictEqual(failures, 0, `${failures}/1500 scripts differ; first: ${JSON.stringify(first)}`);
});
