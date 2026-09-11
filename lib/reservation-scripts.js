// Phase 4D.25 / .1 / .2 — the Lua scripts run atomically, server-side, via
// kv.eval(script, keys, args). This is a real, supported primitive: the
// `kv` object @vercel/kv exports is a thin Proxy directly over an
// @upstash/redis `Redis` instance (@vercel/kv's own source:
// `export const kv = new Proxy({}, { get(_, prop) { return Reflect.get(_kv, prop); } })`
// where `_kv` is `new VercelKV(...)`, and `VercelKV extends Redis` from
// `@upstash/redis`), and that `Redis` class defines `eval = (script, keys,
// args) => new EvalCommand([script, keys, args], this.opts).exec(this.client)`,
// which issues a real Upstash REST `EVAL` command.
//
// -- Phase 4D.25.2: why these scripts use Redis HASHes, not JSON blobs --
// The 4D.25.1 version of these scripts stored each reservation/request
// record as a single JSON string, decoded and re-encoded with Lua's
// `cjson` library inside the script. Asked to freshly verify that against
// the actual installed client/server: `kv.eval()` itself is confirmed real
// (the JS client method traces straight to a genuine Upstash REST EVAL
// call, verified from @upstash/redis's own source, checked above). But
// `cjson` availability is a property of Upstash's server-side Lua sandbox,
// not of the JS client -- nothing in the installed package or its source
// says which Lua standard libraries that sandbox exposes, and published
// Upstash documentation covers EVAL's existence without listing Lua
// library support. Rather than ship a script whose correctness depends on
// an unverified library, every script below uses ONLY core Redis commands
// (GET/SET/INCRBY/DECRBY/SADD/SREM/EXPIRE/DEL/HGET/HSET) -- record fields
// are stored as separate hash fields instead of one encoded blob. Core
// commands are guaranteed by EVAL support itself (a Lua script's only job
// is to call them); there is nothing left to verify.
//
// -- What these fix, and why a claim-key/JSON-blob approach wasn't enough --
// commit()/release()/reserve() used to be multi-step (claim a key, THEN
// mutate; or increment a counter, THEN write metadata about it later) --
// each gap between those steps was a real crash window an external review
// found. A single EVAL is genuinely atomic -- Redis executes a script's
// body without interleaving any other command from any other client -- so
// folding "check current state, transition it, adjust the counter, update
// the index" into one script removes the whole class of gap instead of
// adding a second claim mechanism on top of it.

// -- RESERVE --
// KEYS[1] = counter key (the real credits/free-usage counter)
// KEYS[2] = reservation record key (a HASH)
// KEYS[3] = customer's active-reservation index (a SET of reservationIds)
// ARGV[1] = amount to reserve
// ARGV[2] = limit (post-reservation ceiling)
// ARGV[3] = reservationId
// ARGV[4] = counterKey (stored in the record so release()/reconciliation
//           can refund generically without re-deriving tier/period logic)
// ARGV[5] = createdAt (ms epoch, as a string)
// ARGV[6] = expiresAt (ms epoch, as a string) -- meaningful only while 'reserved'
//
// Atomically: check the allowance, and if it holds, apply the increment,
// write the reservation record, and index it -- all three happen together
// or none do. There is no observable state where the counter is
// incremented but no recoverable reservation record/index entry exists.
//
// Phase 4D.25.2: the record gets NO TTL here (no EXPIRE call at all while
// 'reserved'). An unresolved reservation is recovery metadata, not cache --
// if it expired before the customer's next visit, an abandoned reservation
// could permanently leak an allowance unit with no way to ever refund it
// (the exact bug an external review found in the 4D.25.1 24h-TTL design).
// A 'reserved' record now lives exactly as long as it takes for the
// customer to make another request, however long that is.
const RESERVE_SCRIPT = `
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if current + amount > limit then
  return {0, current}
end
local used = redis.call('INCRBY', KEYS[1], amount)
redis.call('HSET', KEYS[2], 'status', 'reserved', 'counterKey', ARGV[4], 'amount', ARGV[1], 'createdAt', ARGV[5], 'expiresAt', ARGV[6])
redis.call('SADD', KEYS[3], ARGV[3])
return {1, used}
`;

// -- COMMIT (no requestId) --
// KEYS[1] = reservation record key
// KEYS[2] = customer's active-reservation index
// ARGV[1] = reservationId
// ARGV[2] = post-resolution audit TTL, seconds
//
// Atomically: only if still 'reserved', flip to 'committed', drop it from
// the active index, and NOW apply a finite audit TTL (the record no longer
// needs to survive indefinitely once it's resolved -- unlike the unresolved
// case above, a committed record is not recovery metadata for anything).
// Already committed/released -> no-op (idempotent).
const COMMIT_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status ~= 'reserved' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'committed')
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[2], ARGV[1])
return 1
`;

// -- RELEASE (no requestId) --
// KEYS[1] = reservation record key
// KEYS[2] = counter key (read from the record's own counterKey field by the
//           caller before invoking this -- see release() in
//           reservation-ledger.js; that pre-read only picks which physical
//           key to target, it never decides WHETHER to refund -- that
//           decision is re-made from scratch, atomically, in this script)
// KEYS[3] = customer's active-reservation index
// ARGV[1] = reservationId
// ARGV[2] = post-resolution audit TTL, seconds
//
// Atomically: only if still 'reserved', flip to 'released', refund the
// counter by the record's own stored amount, drop it from the active
// index, and apply the same finite audit TTL as commit.
const RELEASE_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status ~= 'reserved' then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HSET', KEYS[1], 'status', 'released')
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('DECRBY', KEYS[2], amount)
redis.call('SREM', KEYS[3], ARGV[1])
return 1
`;

// -- COMMIT + requestId completion, as ONE atomic operation --
// KEYS[1] = reservation record key
// KEYS[2] = customer's active-reservation index
// KEYS[3] = requestId record key
// ARGV[1] = reservationId
// ARGV[2] = post-resolution audit TTL, seconds (reservation record)
// ARGV[3] = remaining (post-spend), as a string
// ARGV[4] = tier, as a string
// ARGV[5] = completed-record TTL, seconds
// ARGV[6] = createdAt for the completed record, ms epoch as a string
//
// Phase 4D.25.2, closing the second reviewed gap: the old code committed
// the reservation, then (as a LATER, separate write) marked the requestId
// 'completed' -- a process dying in between left the allowance correctly
// spent but the requestId record stuck 'in_flight', so a client retry
// after that record's TTL lapsed could trigger a second real generation
// and a second real spend under the same requestId. Folding both writes
// into one script removes that window entirely: there is no state where
// the reservation is committed but the requestId isn't also completed, for
// any request that supplied one.
const COMMIT_WITH_REQUEST_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status ~= 'reserved' then return 0 end
redis.call('HSET', KEYS[1], 'status', 'committed')
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('SREM', KEYS[2], ARGV[1])
redis.call('DEL', KEYS[3])
redis.call('HSET', KEYS[3], 'status', 'completed', 'remaining', ARGV[3], 'tier', ARGV[4], 'createdAt', ARGV[6])
redis.call('EXPIRE', KEYS[3], ARGV[5])
return 1
`;

// -- RELEASE + requestId failure, as ONE atomic operation --
// Symmetric with COMMIT_WITH_REQUEST_SCRIPT. Not required for correctness
// the way the commit case was (a release always means the allowance was
// already safely refunded, so a client retry is safe even if the requestId
// bookkeeping write is delayed or lost -- worst case is a 409 until the
// in-flight-looking record's TTL lapses, never a double-spend), but folding
// it in removes a second separate write and keeps the two paths symmetric.
// KEYS[1] = reservation record key
// KEYS[2] = counter key
// KEYS[3] = customer's active-reservation index
// KEYS[4] = requestId record key
// ARGV[1] = reservationId
// ARGV[2] = post-resolution audit TTL, seconds (reservation record)
// ARGV[3] = failed-record TTL, seconds
// ARGV[4] = createdAt for the failed record, ms epoch as a string
const RELEASE_WITH_REQUEST_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if not status then return 0 end
if status ~= 'reserved' then return 0 end
local amount = tonumber(redis.call('HGET', KEYS[1], 'amount'))
redis.call('HSET', KEYS[1], 'status', 'released')
redis.call('EXPIRE', KEYS[1], ARGV[2])
redis.call('DECRBY', KEYS[2], amount)
redis.call('SREM', KEYS[3], ARGV[1])
redis.call('DEL', KEYS[4])
redis.call('HSET', KEYS[4], 'status', 'failed', 'createdAt', ARGV[4])
redis.call('EXPIRE', KEYS[4], ARGV[3])
return 1
`;

// -- CLAIM (or reclaim) a requestId slot --
// KEYS[1] = requestId record key
// ARGV[1] = createdAt, ms epoch as a string
// ARGV[2] = in-flight TTL, seconds
//
// Atomically: claim the slot if it's unclaimed, OR if the prior attempt
// under this requestId ended in 'failed'/'released' (meaning it never
// consumed an allowance, so a fresh retry is safe) -- in both cases,
// overwrite with a new 'in_flight' record and report claimed. Otherwise
// ('in_flight' or 'completed') leave it untouched and return the existing
// status (+ remaining/tier, if present) so the caller can respond
// appropriately (409 vs. a replayed "already processed"). Doing the
// read-then-conditionally-write as one script is what makes two concurrent
// retries of the same failed requestId race-safe -- exactly one can ever
// observe `claimed`.
//
// Note on TTL expiry of an in_flight record: if the ORIGINAL request is
// still genuinely running (slow, not crashed) when its own requestId
// record's TTL lapses, a retry would see no record and claim a brand-new
// slot, potentially starting a second real generation concurrently with a
// still-live first one. This is a known, bounded edge case inherent to any
// TTL-based liveness signal without a heartbeat: it cannot cause a
// customer to be overcharged beyond their real allowance (every actual
// spend still goes through the same atomic RESERVE_SCRIPT limit check),
// it can only -- in the rare case of a request that is unusually slow but
// not actually dead -- let a legitimate retry also succeed. The TTL
// (REQUEST_RECORD_TTL_SECONDS, ~120s) is kept safely above Vercel's 60s
// maxDuration specifically to make this rare.
const CLAIM_REQUEST_SCRIPT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status and status ~= 'failed' and status ~= 'released' then
  local remaining = redis.call('HGET', KEYS[1], 'remaining')
  local tier = redis.call('HGET', KEYS[1], 'tier')
  return {0, status, remaining or '', tier or ''}
end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'status', 'in_flight', 'createdAt', ARGV[1])
redis.call('EXPIRE', KEYS[1], ARGV[2])
return {1}
`;

module.exports = {
  RESERVE_SCRIPT,
  COMMIT_SCRIPT,
  RELEASE_SCRIPT,
  COMMIT_WITH_REQUEST_SCRIPT,
  RELEASE_WITH_REQUEST_SCRIPT,
  CLAIM_REQUEST_SCRIPT,
};
