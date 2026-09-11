// GET /api/proxy/usage
//
// Reached ONLY through the Shopify App Proxy — on the storefront this is the
// same-origin path /apps/modern-studio/usage, under the same prefix already
// configured for Account Status, Entitlement, and Mood Board. Shopify
// appends shop, path_prefix, timestamp, logged_in_customer_id (if any) and
// signature before forwarding here.
//
// Phase 4D.23, Stage A: this is the THIRD Room Designer-adjacent caller
// migrated to the App Proxy trust path, and specifically the read-only
// "how many designs do I have left" check that runs on page load. It is a
// NEW, additive route. It does not replace, modify, or remove api/usage.js
// or lib/verify-customer-token.js — the legacy theme-HMAC path keeps
// working completely unchanged, because /api/redesign (the credit-spending
// generation call) is NOT migrated in this phase and still depends on it.
// Room Designer therefore runs a deliberate, temporary MIXED-AUTH state:
// usage lookups via this route (App Proxy identity), generation via the
// legacy signed-token route (see Phase 4D.22 audit for why the redesign
// migration is staged separately — it touches a non-atomic credit spend).
//
// Trust boundary: identical to api/proxy/entitlement.js and
// api/proxy/account-status.js — this route reads NO identity from
// req.query.customerId, req.body, headers, or anything else. The only
// source of truth for "who is this" is whatever verifyShopifyProxyRequest
// hands back after checking the Shopify signature. A request that fails
// that check is treated as unauthenticated, full stop, regardless of what
// it claims. A browser-supplied customerId, issuedAt, or token — even a
// validly-signed LEGACY one — has no bearing here; this route does not
// import or call verify-customer-token.js at all.
//
// Rate-limit bucket: deliberately reuses the SAME 'usage' bucket name as
// the legacy api/usage.js route (both are keyed per-IP, so this is a shared
// per-IP budget across the legacy and proxied paths for the same underlying
// operation — not a new, separate allowance).
//
// Strictly read-only: this route calls getRemaining/getCreditsRemaining
// only. It never calls recordGeneration, spendCredits, or anything else
// that mutates KV usage/credit state, and it never calls OpenAI or any
// image-generation code path. That logic stays exclusively in
// api/redesign.js until its own later migration phase.
//
// No CORS handling here on purpose: the App Proxy path is same-origin from
// the storefront's perspective, so there is no preflight to answer and no
// Access-Control-* header to set. (The legacy /api/usage route keeps its
// existing CORS handling untouched, for the caller still using it.)

const { getRemaining, FREE_LIMIT } = require('../../lib/usage-store');
const {
  getCreditsRemaining,
  computePeriodStart,
  computeNextReset,
  AI_PLUS_MONTHLY_CREDITS,
} = require('../../lib/credits');
const { checkRateLimit } = require('../../lib/rate-limit');
const { getEntitlement } = require('../../lib/entitlement');
const { verifyShopifyProxyRequest } = require('../../lib/verify-shopify-proxy');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Per-IP throttling, same mechanism and reasoning as the legacy route's
  // rate limit — a safety net against scripted abuse, not the primary
  // authorization check, and keyed on server-observed IP rather than any
  // browser-supplied identity value. Shares the legacy route's bucket name
  // on purpose (see file header).
  const allowed = await checkRateLimit(req, 'usage');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const verification = verifyShopifyProxyRequest(req.query);

  if (!verification.ok || !verification.customerId) {
    // Two distinct failure shapes collapse to the same response on purpose:
    // an invalid/missing/stale signature, and a validly-signed request from
    // a logged-out visitor, are both "not authenticated" from the caller's
    // perspective. (They remain distinguishable internally via
    // verification.reason for logging/monitoring, just not exposed to the
    // client.)
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }

  const customerId = verification.customerId;

  try {
    // Identical logic to api/usage.js from this point on — the goal of this
    // migration is to replace identity verification, not usage/credit
    // accounting behavior. Response shapes match exactly:
    //   free tier -> { remaining, tier }
    //   AI+ tier  -> { remaining, tier, total, renewsOn }
    const { tier, periodAnchor } = await getEntitlement(customerId);

    if (tier === 'ai_plus' && periodAnchor) {
      const periodStart = computePeriodStart(periodAnchor);
      const remaining = await getCreditsRemaining(customerId, periodStart);
      res.status(200).json({
        remaining,
        tier,
        total: AI_PLUS_MONTHLY_CREDITS,
        renewsOn: computeNextReset(periodStart),
      });
      return;
    }

    const remaining = await getRemaining(customerId, FREE_LIMIT);
    res.status(200).json({ remaining, tier: 'free' });
  } catch (err) {
    console.error('proxy usage lookup failed', err);
    res.status(500).json({ error: 'Could not check usage right now.' });
  }
};
