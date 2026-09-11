// GET /api/proxy/redesign-token
//
// Reached ONLY through the Shopify App Proxy -- on the storefront this is
// the same-origin path /apps/modern-studio/redesign-token, under the same
// prefix already configured for Account Status, Entitlement, and the Room
// Designer usage route. Shopify appends shop, path_prefix, timestamp,
// logged_in_customer_id (if any) and signature before forwarding here.
//
// Phase 4D.26: this route is an IDENTITY BRIDGE ONLY. It verifies who the
// customer is (via the same Shopify App Proxy signature check every other
// proxy route in this project already uses) and, if that succeeds, mints a
// short-lived, single-use, cryptographically signed "redesign token" that
// the browser can later present directly to Vercel's POST /api/redesign,
// eventually replacing the legacy customerId + issuedAt + token HMAC
// construction built from Liquid.
//
// THIS PHASE DOES NOT CUT OVER /api/redesign. api/redesign.js is completely
// unmodified and has no knowledge this route exists; it still only accepts
// the legacy verifyCustomerToken() flow. Wiring /api/redesign to accept
// (and consume) this token is a later phase's job. Minting a token here has
// zero effect on usage/credit accounting, entitlement, or anything in
// lib/reservation-ledger.js -- this route never imports any of that.
//
// Authentication != entitlement (an explicit design decision for this
// phase): this route mints a token for ANY authenticated customer, free or
// AI+ -- it does not call getEntitlement() or consult credits/usage at all.
// Free-tier customers use Room Designer too. Deciding free vs AI+,
// remaining usage, IP abuse guarding, and the credit reservation itself all
// stay exclusively in /api/redesign today, and in whatever later phase
// eventually consumes this token.
//
// Trust boundary: identical to the other proxy routes -- this route reads
// NO identity from req.query.customerId, req.body, headers, or anything
// else. The only source of truth for "who is this" is whatever
// verifyShopifyProxyRequest hands back after checking the Shopify
// signature. A request that fails that check is treated as
// unauthenticated, full stop, regardless of what it claims.
//
// Check order: method, then rate limit, then the App Proxy signature --
// matching the established order in every other proxy route in this
// project (api/proxy/usage.js, api/proxy/entitlement.js,
// api/proxy/account-status.js), rather than rate-limiting only after
// signature verification. Signature verification is cheap (one HMAC
// compute, no KV), so the ordering has no real security effect either way
// -- this simply keeps the flow consistent with the rest of the codebase.
//
// Rate-limit bucket: a DEDICATED 'redesign_token' bucket -- distinct from
// 'usage' (the read-only usage-check bucket both api/usage.js and
// api/proxy/usage.js share) and distinct from whatever bucket the actual
// /api/redesign generation call uses. Minting a token is cheap, but a
// shared bucket here could either let token-minting abuse quietly borrow
// budget that should be throttling expensive image generation, or let
// legitimate token requests get starved by unrelated traffic on a busier
// shared bucket.
//
// No CORS handling here on purpose: the App Proxy path is same-origin from
// the storefront's perspective, so there is no preflight to answer and no
// Access-Control-* header to set.
//
// Transport: the returned token is meant to travel from the browser
// directly to Vercel's POST /api/redesign (a later phase's job) -- the
// image body itself is NOT migrated through the App Proxy by this route or
// this phase; App Proxy request bodies have their own size/latency
// characteristics that are a separate concern from this identity bridge.

const { verifyShopifyProxyRequest } = require('../../lib/verify-shopify-proxy');
const { checkRateLimit } = require('../../lib/rate-limit');
const { mintRedesignToken } = require('../../lib/redesign-token');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Per-IP throttling, same mechanism and reasoning as every other proxy
  // route's rate limit -- a safety net against scripted abuse, not the
  // primary authorization check, and keyed on server-observed IP rather
  // than any browser-supplied identity value. See the file header for why
  // this uses its OWN 'redesign_token' bucket rather than sharing one.
  const allowed = await checkRateLimit(req, 'redesign_token');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const verification = verifyShopifyProxyRequest(req.query);

  if (!verification.ok || !verification.customerId) {
    // Two distinct failure shapes collapse to the same response on
    // purpose: an invalid/missing/forged/stale/future signature, and a
    // validly-signed request from a logged-out visitor, are both "not
    // authenticated" from the caller's perspective. (They remain
    // distinguishable internally via verification.reason for
    // logging/monitoring, just not exposed to the client.)
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }

  try {
    const { token, expiresIn } = mintRedesignToken(verification.customerId);
    // Deliberately minimal response shape -- no customer HMAC token, no
    // App Proxy secret, no CUSTOMER_TOKEN_SECRET, no raw KV key ever
    // appears here.
    res.status(200).json({ token, expiresIn });
  } catch (err) {
    // Covers a missing ROOM_DESIGNER_REDESIGN_TOKEN_SECRET (a
    // configuration bug) and any other unexpected mint failure -- the
    // storefront caller never learns why, only that it failed.
    console.error('redesign-token mint failed', err);
    res.status(500).json({ error: 'Could not issue a redesign token right now.' });
  }
};
