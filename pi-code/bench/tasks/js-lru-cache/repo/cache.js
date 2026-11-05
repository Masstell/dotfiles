class Cache {
  constructor(maxSize = 100) {
    this.maxSize = maxSize;
    this.items = {};
  }

  get(key) {
    return this.items[key];
  }

  set(key, value) {
    this.items[key] = value;
    return this;
  }

  has(key) {
    return key in this.items;
  }
}

module.exports = { Cache };
