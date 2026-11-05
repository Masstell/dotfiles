// See SPEC.md.
class Emitter {
  constructor() {
    this._ev = new Map(); // event -> [{ fn, once, fired }]
  }

  _check(fn) {
    if (typeof fn !== "function") throw new TypeError("listener must be a function");
  }

  _add(event, fn, once, front) {
    this._check(fn);
    let list = this._ev.get(event);
    if (!list) this._ev.set(event, (list = []));
    const reg = { fn, once, fired: false };
    if (front) list.unshift(reg);
    else list.push(reg);
    return this;
  }

  on(event, fn) { return this._add(event, fn, false, false); }
  addListener(event, fn) { return this.on(event, fn); }
  prependListener(event, fn) { return this._add(event, fn, false, true); }
  once(event, fn) { return this._add(event, fn, true, false); }
  prependOnceListener(event, fn) { return this._add(event, fn, true, true); }

  _removeReg(event, reg) {
    const list = this._ev.get(event);
    if (!list) return;
    const i = list.indexOf(reg);
    if (i >= 0) list.splice(i, 1);
    if (!list.length) this._ev.delete(event);
  }

  off(event, fn) {
    this._check(fn);
    const list = this._ev.get(event);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].fn === fn) {
        list.splice(i, 1);
        if (!list.length) this._ev.delete(event);
        break;
      }
    }
    return this;
  }
  removeListener(event, fn) { return this.off(event, fn); }

  removeAllListeners(event) {
    if (arguments.length === 0) this._ev.clear();
    else this._ev.delete(event);
    return this;
  }

  emit(event, ...args) {
    const list = this._ev.get(event);
    if (!list || !list.length) {
      if (event === "error") {
        const err = args[0];
        if (err instanceof Error) throw err;
        throw new Error(`Unhandled error. (${String(err)})`);
      }
      return false;
    }
    for (const reg of list.slice()) {
      if (reg.once) {
        this._removeReg(event, reg);
        if (reg.fired) continue;
        reg.fired = true;
      }
      reg.fn.apply(this, args);
    }
    return true;
  }

  listeners(event) {
    return (this._ev.get(event) || []).map((r) => r.fn);
  }

  listenerCount(event) {
    return (this._ev.get(event) || []).length;
  }

  eventNames() {
    return [...this._ev.keys()];
  }
}

module.exports = { Emitter };
