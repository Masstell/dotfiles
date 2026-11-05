class Cache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.items = new Map();
  }

  get(key) {
    if (!this.items.has(key)) return undefined;
    const v = this.items.get(key);
    this.items.delete(key);
    this.items.set(key, v);
    return v;
  }

  set(key, value) {
    this.items.delete(key);
    this.items.set(key, value);
    while (this.items.size > this.maxSize) this.items.delete(this.items.keys().next().value);
    return this;
  }

  has(key) {
    return this.items.has(key);
  }

  get size() {
    return this.items.size;
  }
}

module.exports = { Cache };
