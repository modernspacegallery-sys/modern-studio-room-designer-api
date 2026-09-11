// Minimal in-memory stand-in for the subset of the @vercel/kv API this
// phase's code actually uses (get/set/incr/incrby/expire). Same pattern and
// reasoning as the fake-kv used in the 4D.10-4D.11.1 Projects test suite —
// intentionally NOT more capable/atomic than the real primitives it stands
// in for.

function createFakeKv() {
  const store = new Map();

  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    async incr(key) {
      const v = (store.get(key) || 0) + 1;
      store.set(key, v);
      return v;
    },
    async incrby(key, amount) {
      const v = (store.get(key) || 0) + amount;
      store.set(key, v);
      return v;
    },
    async expire() {
      return 1;
    },
    reset() {
      store.clear();
    },
    _store: store,
  };
}

module.exports = { createFakeKv };
