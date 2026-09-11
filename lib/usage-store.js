// Tracks how many AI Room Designer generations each customer has used.
//
// IMPORTANT — known limitation (inherited from the existing theme code):
// `customerId` here is whatever value the browser sends, taken from Shopify's
// `customer.id` Liquid object with no signature or session token attached.
// That means a technically-savvy visitor could edit the request in devtools
// and pass an arbitrary/fake customerId to get a "fresh" set of free designs,
// or to read another customer's remaining count. This file adds IP-based rate
// limiting (see rate-limit.js) as a partial mitigation, but the real fix is to
// have the theme pass a verifiable identifier — e.g. a Shopify Customer
// Account API access token this backend can validate, or an Shopify App Proxy
// signed request — instead of a raw client-supplied ID. Flagging this clearly
// rather than silently shipping it as if it were secure.

const { kv } = require('@vercel/kv');
const ledger = require('./reservation-ledger');

const FREE_LIMIT = parseInt(process.env.FREE_DESIGN_LIMIT || '2', 10);
// Effectively unlimited for AI+ subscribers, but still tracked (and still a
// real ceiling, via env var) rather than hard-coding true infinite usage.
const AI_PLUS_LIMIT = parseInt(process.env.AI_PLUS_DESIGN_LIMIT || '999999', 10);

function usageKey(customerId) {
  return `rd:used:${customerId}`;
}

// Phase 4D.25.3 -- reconcile any stale (abandoned-past-lease) reservations
// for this customer BEFORE reading the counter. Without this, a reservation
// that consumed the customer's last unit and then went abandoned (its
// invoking request died before commit/release) would never get discovered:
// this read-only check was the ONLY call this customer's browser makes on
// page load, and reconciliation used to run solely from reserve() --
// which never runs if the UI is already showing "0 remaining". See
// reservation-ledger.js's file header for the full explanation. This adds
// at most an SMEMBERS + one HGETALL per still-open reservation (structurally
// small -- see that file) and never mutates a live, non-expired reservation
// or a committed one.
async function getRemaining(customerId, limit = FREE_LIMIT) {
  await ledger.reconcileStaleReservations(customerId);
  const used = (await kv.get(usageKey(customerId))) || 0;
  return Math.max(0, limit - used);
}

// Kept in place (unused by the redesign flow as of Phase 4D.25, which
// spends via reserveFreeGeneration/commitFreeReservation below instead) --
// getRemaining() above is still relied on read-only by api/usage.js and
// api/proxy/usage.js, and removing recordGeneration wasn't necessary.
async function recordGeneration(customerId, limit = FREE_LIMIT) {
  const used = await kv.incr(usageKey(customerId));
  return Math.max(0, limit - used);
}

// Phase 4D.25 — atomic reserve-before-generate primitives for the free
// tier, backed by the same lifetime counter key as getRemaining() above so
// its read-only view stays accurate at every point (reserved-but-not-yet-
// committed units already count against "remaining").
async function reserveFreeGeneration(customerId, limit = FREE_LIMIT) {
  return ledger.reserve({ customerId, counterKey: usageKey(customerId), amount: 1, limit });
}
async function commitFreeReservation(customerId, reservationId) {
  return ledger.commit(customerId, reservationId);
}
async function releaseFreeReservation(customerId, reservationId) {
  return ledger.release(customerId, reservationId);
}
// Phase 4D.25.2 — for a request that supplied a requestId, use these
// instead: they commit/release AND resolve the requestId record in one
// atomic step (see reservation-ledger.js / reservation-scripts.js).
async function commitFreeReservationWithRequest(customerId, reservationId, requestId, extra) {
  return ledger.commitWithRequestCompletion(customerId, reservationId, requestId, extra);
}
async function releaseFreeReservationWithRequest(customerId, reservationId, requestId) {
  return ledger.releaseWithRequestFailure(customerId, reservationId, requestId);
}

module.exports = {
  getRemaining,
  recordGeneration,
  FREE_LIMIT,
  AI_PLUS_LIMIT,
  reserveFreeGeneration,
  commitFreeReservation,
  releaseFreeReservation,
  commitFreeReservationWithRequest,
  releaseFreeReservationWithRequest,
};
