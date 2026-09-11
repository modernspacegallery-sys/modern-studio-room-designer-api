// Minimal in-memory stand-in for the subset of the @vercel/kv API this
// codebase actually uses (get/set/incr/incrby/expire/del/smembers/srem/
// sadd/hget/hset/hgetall/eval). Same pattern and reasoning as the fake-kv
// used in the 4D.10-4D.11.1 Projects test suite -- intentionally NOT more
// capable/atomic than the real primitives it stands in for, EXCEPT for
// eval() below, which is deliberately as atomic as the real thing (see its
// comment).
//
// Phase 4D.25 extension: set() accepts an options object and honors `nx`.
// `ex` (TTL) is accepted but not simulated -- nothing in this codebase's
// decision logic depends on real KV-level expiry actually firing;
// unresolved-reservation liveness is judged by comparing a stored
// `expiresAt` timestamp to Date.now(), never by whether a key vanished.
//
// Phase 4D.25.1 extension: adds a Set-backed store for smembers/srem/sadd,
// and an eval() that is NOT a Lua interpreter -- it's a registry, keyed by
// exact reference to the script-source constants exported from
// lib/reservation-scripts.js, of synchronous JS functions that mirror each
// script's algorithm exactly. "Synchronous" is the important word: each
// handler runs start-to-finish with no `await` inside it, so -- because
// Node is single-threaded -- nothing else can interleave partway through
// one, the same atomicity guarantee the real Redis EVAL provides by
// executing a script's body without interleaving any other command.
//
// Phase 4D.25.2 extension: adds a Hash-backed store for hget/hset/hgetall,
// mirroring the production scripts' move away from JSON-blob strings (see
// reservation-scripts.js for why: cjson availability in Upstash's Lua
// sandbox couldn't be verified, so every script -- and this fake -- now
// uses only core Redis commands). Also updates the RESERVE/COMMIT/RELEASE
// handlers for the revised TTL policy (no TTL while 'reserved'; a finite
// audit TTL applied only at resolution) and adds handlers for the two new
// "with request" scripts. Critically, this fake does NOT simulate TTL
// expiry at all (see above) -- so it cannot accidentally make a test pass
// by "forgetting" a record the real, TTL-free-while-reserved production
// script would also still remember. Tests that need to simulate an
// abandoned reservation do so the same way as before: by directly editing
// the stored record's `expiresAt` field into the past, never by deleting it.

const {
  RESERVE_SCRIPT,
  COMMIT_SCRIPT,
  RELEASE_SCRIPT,
  COMMIT_WITH_REQUEST_SCRIPT,
  RELEASE_WITH_REQUEST_SCRIPT,
  CLAIM_REQUEST_SCRIPT,
} = require('../lib/reservation-scripts');

function createFakeKv() {
  const store = new Map();
  const sets = new Map(); // key -> Set<string>
  const hashes = new Map(); // key -> Map<field, value>
  const expireCalls = []; // { key, ttl } -- every simulated EXPIRE, from eval scripts AND the plain expire() method

  function getSet(key) {
    if (!sets.has(key)) sets.set(key, new Set());
    return sets.get(key);
  }
  // Mirrors real Redis SREM: removing the last member deletes the key
  // entirely rather than leaving a persistent empty SET behind. The public
  // srem() method already does this; the eval-script handlers below must
  // do the same thing when they remove an active-index member directly,
  // since they operate on the Map without going through srem().
  function removeFromSet(key, member) {
    const s = sets.get(key);
    if (!s) return;
    s.delete(member);
    if (s.size === 0) sets.delete(key);
  }
  function getHash(key) {
    if (!hashes.has(key)) hashes.set(key, new Map());
    return hashes.get(key);
  }
  function hashToObject(key) {
    if (!hashes.has(key) || hashes.get(key).size === 0) return null;
    return Object.fromEntries(hashes.get(key));
  }

  // Each handler receives (keys, args) exactly as kv.eval(script, keys,
  // args) would pass them to the real Upstash REST EVAL call, and returns
  // exactly what the corresponding Lua script returns (see
  // lib/reservation-scripts.js for the authoritative algorithm each of
  // these mirrors line-for-line). Real TTL expiry is never simulated (see
  // the file header), but every EXPIRE call the real scripts make is
  // logged to `expireCalls` (exposed as `_expireCalls`) at the exact same
  // point in the algorithm, with its key and TTL -- so a test can assert
  // "reserve() applies no TTL" or "commit() applies exactly this TTL"
  // without needing real expiry to actually happen.
  const SCRIPT_HANDLERS = new Map([
    [
      RESERVE_SCRIPT,
      (keys, args) => {
        const [counterKey, recordKey, activeKey] = keys;
        const amount = Number(args[0]);
        const limit = Number(args[1]);
        const reservationId = args[2];
        const counterKeyArg = args[3];
        const createdAt = args[4];
        const expiresAt = args[5];

        const current = Number(store.get(counterKey) || 0);
        if (current + amount > limit) {
          return [0, current];
        }
        const used = current + amount;
        store.set(counterKey, used);
        const h = getHash(recordKey);
        h.clear();
        h.set('status', 'reserved');
        h.set('counterKey', counterKeyArg);
        h.set('amount', String(amount));
        h.set('createdAt', String(createdAt));
        h.set('expiresAt', String(expiresAt));
        // NO ttl applied -- matches RESERVE_SCRIPT exactly: an unresolved
        // reservation record never expires.
        getSet(activeKey).add(reservationId);
        return [1, used];
      },
    ],
    [
      COMMIT_SCRIPT,
      (keys, args) => {
        const [recordKey, activeKey] = keys;
        const [reservationId] = args;
        const h = getHash(recordKey);
        const status = h.get('status');
        if (!status) return 0;
        if (status !== 'reserved') return 0;
        h.set('status', 'committed');
        expireCalls.push({ key: recordKey, ttl: Number(args[1]) }); // finite post-resolution audit TTL
        removeFromSet(activeKey, reservationId);
        return 1;
      },
    ],
    [
      RELEASE_SCRIPT,
      (keys, args) => {
        const [recordKey, counterKey, activeKey] = keys;
        const [reservationId, auditTtl] = args;
        const h = getHash(recordKey);
        const status = h.get('status');
        if (!status) return 0;
        if (status !== 'reserved') return 0;
        const amount = Number(h.get('amount'));
        h.set('status', 'released');
        expireCalls.push({ key: recordKey, ttl: Number(auditTtl) }); // finite post-resolution audit TTL
        const current = Number(store.get(counterKey) || 0);
        store.set(counterKey, current - amount);
        removeFromSet(activeKey, reservationId);
        return 1;
      },
    ],
    [
      COMMIT_WITH_REQUEST_SCRIPT,
      (keys, args) => {
        const [recordKey, activeKey, reqKey] = keys;
        const [reservationId, , remaining, tier, , createdAt] = args;
        const h = getHash(recordKey);
        const status = h.get('status');
        if (!status) return 0;
        if (status !== 'reserved') return 0;
        h.set('status', 'committed');
        expireCalls.push({ key: recordKey, ttl: Number(args[1]) }); // finite post-resolution audit TTL
        removeFromSet(activeKey, reservationId);
        const rh = getHash(reqKey);
        rh.clear();
        rh.set('status', 'completed');
        rh.set('remaining', String(remaining));
        rh.set('tier', String(tier));
        rh.set('createdAt', String(createdAt));
        expireCalls.push({ key: reqKey, ttl: Number(args[4]) }); // completed-record TTL
        return 1;
      },
    ],
    [
      RELEASE_WITH_REQUEST_SCRIPT,
      (keys, args) => {
        const [recordKey, counterKey, activeKey, reqKey] = keys;
        const [reservationId, auditTtl, failedTtl, createdAt] = args;
        const h = getHash(recordKey);
        const status = h.get('status');
        if (!status) return 0;
        if (status !== 'reserved') return 0;
        const amount = Number(h.get('amount'));
        h.set('status', 'released');
        expireCalls.push({ key: recordKey, ttl: Number(auditTtl) }); // finite post-resolution audit TTL
        const current = Number(store.get(counterKey) || 0);
        store.set(counterKey, current - amount);
        removeFromSet(activeKey, reservationId);
        const rh = getHash(reqKey);
        rh.clear();
        rh.set('status', 'failed');
        rh.set('createdAt', String(createdAt));
        expireCalls.push({ key: reqKey, ttl: Number(failedTtl) });
        return 1;
      },
    ],
    [
      CLAIM_REQUEST_SCRIPT,
      (keys, args) => {
        const [key] = keys;
        const [, ttlSeconds] = args;
        const h = getHash(key);
        const status = h.get('status');
        if (status && status !== 'failed' && status !== 'released') {
          return [0, status, h.get('remaining') || '', h.get('tier') || ''];
        }
        h.clear();
        h.set('status', 'in_flight');
        expireCalls.push({ key, ttl: Number(ttlSeconds) }); // in-flight TTL, applied on every fresh claim/reclaim
        return [1];
      },
    ],
  ]);

  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async set(key, value, opts) {
      if (opts && opts.nx && store.has(key)) {
        return null; // matches real client: SET NX on an existing key returns nil/null, writes nothing
      }
      store.set(key, value);
      return 'OK';
    },
    async del(key) {
      let removed = 0;
      if (store.delete(key)) removed = 1;
      if (hashes.delete(key)) removed = 1;
      if (sets.delete(key)) removed = 1;
      return removed;
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
    async expire(key, ttl) {
      expireCalls.push({ key, ttl: Number(ttl) });
      return 1;
    },
    async sadd(key, member) {
      const s = getSet(key);
      const before = s.size;
      s.add(member);
      return s.size > before ? 1 : 0;
    },
    async srem(key, member) {
      const s = sets.get(key);
      if (!s) return 0;
      const had = s.delete(member);
      if (s.size === 0) sets.delete(key); // matches real Redis: an empty SET is not a key
      return had ? 1 : 0;
    },
    async smembers(key) {
      return Array.from(getSet(key));
    },
    async hget(key, field) {
      const h = hashes.get(key);
      return h && h.has(field) ? h.get(field) : null;
    },
    async hset(key, fields) {
      const h = getHash(key);
      for (const [f, v] of Object.entries(fields)) h.set(f, v);
      return Object.keys(fields).length;
    },
    async hgetall(key) {
      return hashToObject(key);
    },
    // NOT a Lua interpreter -- see the file header comment. `script` must
    // be one of the exact constants exported from lib/reservation-scripts.js.
    async eval(script, keys, args) {
      const handler = SCRIPT_HANDLERS.get(script);
      if (!handler) {
        throw new Error('fake-kv.eval: unrecognized script (not one of the lib/reservation-scripts.js constants)');
      }
      return handler(keys, args);
    },
    reset() {
      store.clear();
      sets.clear();
      hashes.clear();
      expireCalls.length = 0;
    },
    _store: store,
    _sets: sets,
    _hashes: hashes,
    _expireCalls: expireCalls,
  };
}

module.exports = { createFakeKv };
