// Phase 4D.25 / .1 / .2 — shared, tier-agnostic atomic reservation +
// idempotency primitives for credit-consuming AI operations. Currently used
// only by api/redesign.js (via lib/usage-store.js and lib/credits.js), but
// written generically so a future Studio tool with the same "don't pay for
// a generation we discard" problem can reuse it.
//
// -- Why a shared module instead of duplicating this in usage-store.js and
//    credits.js --
// Free-tier and AI+ accounting differ only in which KV key holds the
// counter and what the limit is. The hard part -- reserve atomically,
// discover and recover EVERY abandoned reservation for a customer without a
// background worker, and make commit/release/reconcile mutually exclusive
// and crash-safe under concurrency -- is identical for both, so it lives
// here once.
//
// -- Phase 4D.25.2: the two gaps an external review found in 4D.25.1, and
//    how they're closed here --
//
//   1. The 4D.25.1 design gave every reservation record a 24-hour TTL
//      (lease + audit buffer), including while still 'reserved'. If a
//      process died right after reserving and the customer didn't return
//      within 24 hours, the record -- the ONLY place counterKey/amount
//      live -- expired before it could ever be reconciled. Reconciliation
//      would then find an active-index entry with no record behind it and
//      clean up the index (correctly, as an orphan), but with no metadata
//      left to refund by. Net effect: a permanently leaked allowance unit,
//      for a free-tier customer potentially half of their entire lifetime
//      allowance. Fixed by removing the TTL entirely while a record is
//      'reserved' (see RESERVE_SCRIPT in reservation-scripts.js) -- an
//      unresolved reservation is recovery metadata, not cache, and now
//      lives exactly as long as it takes the customer to come back,
//      whether that's a minute or a year. A finite audit TTL is applied
//      only AFTER resolution (inside COMMIT_SCRIPT/RELEASE_SCRIPT), when
//      the record is no longer load-bearing for anything.
//   2. The 4D.25.1 success path committed the reservation, then (as a
//      separate, later write) marked the requestId 'completed'. A process
//      dying in between left the allowance correctly spent but the
//      requestId stuck 'in_flight' -- once that record's own TTL lapsed, a
//      client retry under the same requestId could trigger a second real
//      generation and a second real spend, defeating the point of
//      requestId idempotency. Fixed by COMMIT_WITH_REQUEST_SCRIPT, which
//      commits the reservation AND completes the requestId record in one
//      script -- there is no state where one happened without the other,
//      for any request that supplied a requestId.
//
// Both fixes follow the same shape as every earlier fix in this file: move
// the actual atomic decision entirely server-side into one Lua script,
// rather than trying to approximate atomicity with more application-level
// bookkeeping steps.
//
// -- Why records are Redis HASHes, not JSON strings (also 4D.25.2) --
// The 4D.25.1 scripts used cjson.encode/decode inside Lua to read and patch
// a JSON blob. Freshly asked to verify that against the real client: the
// installed package genuinely supports kv.eval() (traced to a real Upstash
// REST EVAL call in @upstash/redis's own source), but cjson availability
// is a property of Upstash's server-side Lua sandbox, not the JS client --
// nothing in the installed package or public Upstash docs confirms which
// Lua standard libraries that sandbox exposes. Rather than depend on an
// unverified library, every script now uses only core Redis commands
// (GET/SET/INCRBY/DECRBY/SADD/SREM/EXPIRE/DEL/HGET/HSET) against HASH-
// shaped records -- see reservation-scripts.js for the exact scripts.
//
// -- Lease duration (while 'reserved') --
// api/redesign.js is configured in vercel.json with "maxDuration": 60 --
// Vercel force-kills that function at 60s regardless of the platform's
// higher general ceiling. RESERVATION_LEASE_SECONDS is 90 (60s hard
// platform kill + 30s safety margin) -- this is stored in the record's
// `expiresAt` field and used only to decide whether an unresolved
// reservation looks abandoned yet; it is NOT a storage TTL (see above).
//
// -- TTL / storage cleanup, fully revised in 4D.25.2 --
// Reservation records: NO TTL while 'reserved' (see above). Once resolved
// (committed or released), RESERVATION_AUDIT_TTL_SECONDS (24h) is applied
// explicitly inside the same script that performs the transition.
// Active-reservation index: no TTL at all. It's a SET; Redis automatically
// deletes a SET once its last member is SREM'd, so an index with only
// resolved (removed) reservations simply doesn't exist as a key -- there is
// no "permanent empty index" to leak, and no arbitrary expiry to guess.
// requestId dedupe records: REQUEST_RECORD_TTL_SECONDS (~120s) for
// in-flight/failed/released, COMPLETED_REQUEST_RECORD_TTL_SECONDS (24h)
// for completed -- long enough that a legitimately delayed retry still
// gets a safe "already processed" answer instead of a fresh spend.
//
// -- Reconciliation bound --
// reconcileStaleReservations() no longer truncates the customer's active
// index at an arbitrary cap. The real bound is structural, not guessed: the
// atomic RESERVE_SCRIPT only ever opens a new reservation if the SAME
// counter it's about to increment is still <= limit afterward, and every
// open (unresolved) reservation holds exactly `amount` units of that
// counter until it resolves. So the number of simultaneously unresolved
// reservations for one customer can never exceed floor(limit / amount) --
// with this codebase's only cost (`standard_redesign`, amount = 1), that's
// exactly the currently effective limit itself: FREE_LIMIT (default 2) or
// AI_PLUS_MONTHLY_CREDITS (default 20), whichever tier. RECONCILE_WARN_
// THRESHOLD below is a monitoring signal for "something is operationally
// wrong" (a misconfigured limit, a bug elsewhere), never a cap that skips
// members -- every member returned by SMEMBERS is always processed.
//
// -- Phase 4D.25.3: reconciliation must also run on the READ path --
// reconcileStaleReservations() was, until this phase, only ever called from
// reserve() (below). But the Room Designer page's first network call is a
// read-only usage check (GET /apps/modern-studio/usage or GET /api/usage),
// which calls getRemaining()/getCreditsRemaining() in lib/usage-store.js /
// lib/credits.js -- neither of which touched the reservation ledger at all.
// If a customer's last unit was consumed by a reservation that then went
// abandoned (the invoking request died before commit/release), that stale
// reservation would sit un-reconciled forever from the read path's point of
// view: the usage check would keep reporting `remaining: 0`, the UI would
// keep showing the limit-reached state, the customer would never click
// "Design My Room" again, /api/redesign (and therefore reserve(), the only
// prior trigger for reconciliation) would never run -- a permanent
// functional lockout despite the reservation being technically recoverable.
// Fixed by exporting reconcileStaleReservations (below) and having both
// read functions call it before computing "remaining" -- see their own
// files for the one-line call site. This function's own behavior is
// UNCHANGED: it still only refunds reservations that are actually past
// their lease (see reconcileOne), never touches committed reservations or
// completed requestId records, and never calls OpenAI (it only ever calls
// RELEASE_SCRIPT, a pure KV operation). A reservation still within its 90s
// lease is left alone and continues to count as unavailable, whether
// discovered from reserve() or from a read.
//
// -- No module cycle -- this file (reservation-ledger.js) does not import
// usage-store.js or credits.js, and never will need to: it only knows
// about generic counterKey strings, never which tier/period a counter
// belongs to. getRemaining()/getCreditsRemaining() -> reconcile -> release
// -> (pure KV) is a one-way call graph; release() has no path back into
// either usage-store.js or credits.js.

const { kv } = require('@vercel/kv');
const crypto = require('crypto');
const {
  RESERVE_SCRIPT,
  COMMIT_SCRIPT,
  RELEASE_SCRIPT,
  COMMIT_WITH_REQUEST_SCRIPT,
  RELEASE_WITH_REQUEST_SCRIPT,
  CLAIM_REQUEST_SCRIPT,
} = require('./reservation-scripts');

const RESERVATION_LEASE_SECONDS = parseInt(process.env.REDESIGN_RESERVATION_LEASE_SECONDS || '90', 10);
const RESERVATION_AUDIT_TTL_SECONDS = 24 * 60 * 60;
const REQUEST_RECORD_TTL_SECONDS = RESERVATION_LEASE_SECONDS + 30;
const COMPLETED_REQUEST_RECORD_TTL_SECONDS = 24 * 60 * 60;

// Purely a monitoring signal -- see the file header. Never used to skip or
// truncate reconciliation.
const RECONCILE_WARN_THRESHOLD = 100;

function reservationKey(customerId, reservationId) {
  return `redesign:reservation:${customerId}:${reservationId}`;
}
function activeSetKey(customerId) {
  return `redesign:reservations:active:${customerId}`;
}
function requestKey(customerId, requestId) {
  return `redesign:req:${customerId}:${requestId}`;
}

function newReservationId() {
  return crypto.randomUUID();
}

// Walks EVERY reservation this customer currently has open (bounded only by
// how many actually exist -- see the file header on why that's structurally
// small) and resolves any that are 'reserved' past their lease. Purely
// lazy -- triggered only by that same customer's own next reserve() call,
// never a background sweeper.
async function reconcileStaleReservations(customerId) {
  const setKey = activeSetKey(customerId);
  const ids = await kv.smembers(setKey);
  if (!ids || ids.length === 0) return;

  if (ids.length > RECONCILE_WARN_THRESHOLD) {
    console.warn(
      `reservation-ledger: customer ${customerId} has ${ids.length} unresolved reservations -- ` +
        'this is far beyond what any currently configured allowance limit should allow; investigate.'
    );
  }

  const now = Date.now();
  await Promise.all(ids.map((id) => reconcileOne(customerId, setKey, id, now)));
}

async function reconcileOne(customerId, setKey, reservationId, now) {
  const key = reservationKey(customerId, reservationId);
  const record = await kv.hgetall(key);

  if (!record || !record.status) {
    // Orphaned index entry (record already resolved+expired via its own
    // post-resolution audit TTL, or never existed) -- safe to drop from the
    // index; never touches a counter.
    await kv.srem(setKey, reservationId).catch(() => {});
    return;
  }
  if (record.status !== 'reserved') {
    // Stale membership (already resolved elsewhere, e.g. a concurrent
    // reconciliation pass) -- safe cleanup, never touches a counter.
    await kv.srem(setKey, reservationId).catch(() => {});
    return;
  }
  if (now < Number(record.expiresAt)) return; // still within lease -- not abandoned, leave it alone

  // record.counterKey is read here only to know which physical counter key
  // to pass to the script -- it never changes for a given reservationId, so
  // reading it non-atomically first introduces no race. The actual
  // decision of WHETHER to refund is re-made from scratch, atomically,
  // inside RELEASE_SCRIPT itself.
  await kv.eval(RELEASE_SCRIPT, [key, record.counterKey, setKey], [reservationId, String(RESERVATION_AUDIT_TTL_SECONDS)]).catch(() => {});
}

// Reserve `amount` units against `counterKey`, capped at `limit`.
// Returns { ok: true, reservationId, remaining } or { ok: false, remaining }.
// Atomic: RESERVE_SCRIPT performs the limit check, the counter increment,
// the reservation record write, and the active-index add in one Redis-side
// script execution. A rejected reservation makes no counter change at all;
// a successful one can never leave the counter incremented without a
// recoverable, TTL-free (while unresolved) record.
async function reserve({ customerId, counterKey, amount, limit }) {
  await reconcileStaleReservations(customerId);

  const reservationId = newReservationId();
  const now = Date.now();
  const expiresAt = now + RESERVATION_LEASE_SECONDS * 1000;
  const recordKey = reservationKey(customerId, reservationId);
  const setKey = activeSetKey(customerId);

  const result = await kv.eval(
    RESERVE_SCRIPT,
    [counterKey, recordKey, setKey],
    [String(amount), String(limit), reservationId, counterKey, String(now), String(expiresAt)]
  );
  const [status, counterValue] = result;

  if (Number(status) !== 1) {
    return { ok: false, remaining: Math.max(0, limit - Number(counterValue)) };
  }
  return { ok: true, reservationId, remaining: Math.max(0, limit - Number(counterValue)) };
}

// Mark a reservation committed (the unit was legitimately spent -- no
// counter change, since reserve() already applied it). Atomic and
// idempotent via COMMIT_SCRIPT. Use this for a request that did NOT supply
// a requestId; for one that did, use commitWithRequestCompletion instead
// so the requestId's 'completed' state is applied in the SAME atomic step.
async function commit(customerId, reservationId) {
  const key = reservationKey(customerId, reservationId);
  const setKey = activeSetKey(customerId);
  const result = await kv.eval(COMMIT_SCRIPT, [key, setKey], [reservationId, String(RESERVATION_AUDIT_TTL_SECONDS)]);
  return Number(result) === 1;
}

// Commit a reservation AND mark its requestId 'completed', atomically, in
// one script (COMMIT_WITH_REQUEST_SCRIPT) -- see the file header on why
// this can't be two separate writes.
async function commitWithRequestCompletion(customerId, reservationId, requestId, { remaining, tier }) {
  const key = reservationKey(customerId, reservationId);
  const setKey = activeSetKey(customerId);
  const reqKey = requestKey(customerId, requestId);
  const result = await kv.eval(
    COMMIT_WITH_REQUEST_SCRIPT,
    [key, setKey, reqKey],
    [reservationId, String(RESERVATION_AUDIT_TTL_SECONDS), String(remaining), String(tier), String(COMPLETED_REQUEST_RECORD_TTL_SECONDS), String(Date.now())]
  );
  return Number(result) === 1;
}

// Refund a reservation (generation failed, or it was never used). Atomic
// and idempotent via RELEASE_SCRIPT for the same reasons as commit().
async function release(customerId, reservationId) {
  const key = reservationKey(customerId, reservationId);
  const record = await kv.hgetall(key); // only to learn counterKey -- see the note on reconcileOne above
  if (!record || !record.status) return false;
  const setKey = activeSetKey(customerId);
  const result = await kv.eval(RELEASE_SCRIPT, [key, record.counterKey, setKey], [reservationId, String(RESERVATION_AUDIT_TTL_SECONDS)]);
  return Number(result) === 1;
}

// Release a reservation AND mark its requestId 'failed', atomically, in one
// script. Not required for the same load-bearing reason the commit-side
// fix was (a release always means the allowance was already refunded, so a
// delayed/lost failure-bookkeeping write is never a double-spend risk --
// only, at worst, a 409 until the stale-looking record's TTL lapses), but
// kept symmetric with the success path since it costs nothing extra here.
async function releaseWithRequestFailure(customerId, reservationId, requestId) {
  const key = reservationKey(customerId, reservationId);
  const record = await kv.hgetall(key);
  if (!record || !record.status) return false;
  const setKey = activeSetKey(customerId);
  const reqKey = requestKey(customerId, requestId);
  const result = await kv.eval(
    RELEASE_WITH_REQUEST_SCRIPT,
    [key, record.counterKey, setKey, reqKey],
    [reservationId, String(RESERVATION_AUDIT_TTL_SECONDS), String(REQUEST_RECORD_TTL_SECONDS), String(Date.now())]
  );
  return Number(result) === 1;
}

// -- Optional requestId idempotency layer --
// Deliberately does NOT cache the (potentially multi-MB) generated image --
// only status + credit outcome.

// Atomically claims a fresh requestId slot, OR -- if the prior attempt
// under this requestId ended 'failed'/'released' -- atomically reclaims it
// for a new attempt. Returns { claimed: true } in both of those cases, or
// { claimed: false, existing } if the slot is genuinely 'in_flight' or
// already 'completed'. See CLAIM_REQUEST_SCRIPT.
async function claimOrReclaimRequestSlot(customerId, requestId) {
  const key = requestKey(customerId, requestId);
  const result = await kv.eval(CLAIM_REQUEST_SCRIPT, [key], [String(Date.now()), String(REQUEST_RECORD_TTL_SECONDS)]);
  const [claimed, status, remainingStr, tierStr] = result;
  if (Number(claimed) === 1) return { claimed: true };
  const existing = { status };
  if (remainingStr !== '' && remainingStr != null) existing.remaining = Number(remainingStr);
  if (tierStr !== '' && tierStr != null) existing.tier = tierStr;
  return { claimed: false, existing };
}

// Plain (non-atomic-with-anything-else) bookkeeping write, for the cases
// where there is no reservation to couple it with in the first place (a
// request rejected before ever reserving -- e.g. the free-tier IP guard,
// or an oversized image). Clears any stale fields from a previous state
// before writing the new ones, since HSET only merges/overwrites the
// fields it's given.
async function markRequestRecord(customerId, requestId, status, extra = {}) {
  const key = requestKey(customerId, requestId);
  const ttl = status === 'completed' ? COMPLETED_REQUEST_RECORD_TTL_SECONDS : REQUEST_RECORD_TTL_SECONDS;
  const fields = { status, createdAt: String(Date.now()) };
  if (extra.remaining !== undefined) fields.remaining = String(extra.remaining);
  if (extra.tier !== undefined) fields.tier = String(extra.tier);
  await kv.del(key).catch(() => {});
  await kv.hset(key, fields);
  await kv.expire(key, ttl);
}

module.exports = {
  RESERVATION_LEASE_SECONDS,
  RESERVATION_AUDIT_TTL_SECONDS,
  reserve,
  commit,
  commitWithRequestCompletion,
  release,
  releaseWithRequestFailure,
  claimOrReclaimRequestSlot,
  markRequestRecord,
  // Phase 4D.25.3 -- exported so read-only usage/credit lookups
  // (lib/usage-store.js getRemaining, lib/credits.js getCreditsRemaining)
  // can reconcile stale reservations before computing "remaining", the same
  // way reserve() already does before opening a new one. See the file
  // header's "Phase 4D.25.3" note below reserve() is no longer the only
  // caller of this. Deliberately NOT exporting reconcileOne or any other
  // lower-level primitive -- this is the one safe, complete entry point.
  reconcileStaleReservations,
};
