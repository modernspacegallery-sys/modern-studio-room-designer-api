// GET /api/proxy/account-status
//
// Reached ONLY through the Shopify App Proxy — on the storefront this is the
// same-origin path /apps/modern-studio/account-status (exact prefix/subpath
// is a Shopify app configuration choice, not this file's concern). Shopify
// appends shop, path_prefix, timestamp, logged_in_customer_id (if any) and
// signature before forwarding here.
//
// This is a NEW, additive route. It does not replace, modify, or remove
// api/entitlement.js or lib/verify-customer-token.js — the legacy
// theme-HMAC path keeps working unchanged for every tool until each one is
// individually migrated. This route exists to prove the App Proxy path for
// Account Status only.
//
// Trust boundary: this route reads NO identity from req.query.customerId,
// req.body, headers, or anything else — the only source of truth for "who
// is this" is whatever verifyShopifyProxyRequest hands back after checking
// the Shopify signature. A request that fails that check is treated as
// unauthenticated, full stop, regardless of what it claims.
//
// No CORS handling here on purpose: the App Proxy path is same-origin from
// the storefront's perspective, so there is no preflight to answer and no
// Access-Control-* header to set. (The legacy /api/entitlement route keeps
// its existing CORS handling untouched, for the tools still using it.)

const { getEntitlement } = require('../../lib/entitlement');
const {
  getCreditsRemaining,
  computePeriodStart,
  computeNextReset,
  AI_PLUS_MONTHLY_CREDITS,
} = require('../../lib/credits');
const { checkRateLimit } = require('../../lib/rate-limit');
const { verifyShopifyProxyRequest } = require('../../lib/verify-shopify-proxy');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Per-IP throttling, same mechanism and reasoning as the legacy route's
  // rate limit — a safety net against scripted abuse, not the primary
  // authorization check, and keyed on server-observed IP rather than any
  // browser-supplied identity value.
  const allowed = await checkRateLimit(req, 'proxy_account_status');
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
    // verification.reason for logging/monitoring — see item 10 of the
    // 4D.15 report — just not exposed to the client.)
    res.status(401).json({ error: 'not_authenticated' });
    return;
  }

  const customerId = verification.customerId;

  try {
    // Identical logic to api/entitlement.js from this point on — the goal
    // of this pilot is to replace identity verification, not entitlement.
    const { tier, periodAnchor } = await getEntitlement(customerId);
    if (tier === 'ai_plus' && periodAnchor) {
      const periodStart = computePeriodStart(periodAnchor);
      const remaining = await getCreditsRemaining(customerId, periodStart);
      res.status(200).json({
        tier,
        credits: { remaining, total: AI_PLUS_MONTHLY_CREDITS, renewsOn: computeNextReset(periodStart) },
      });
      return;
    }
    res.status(200).json({ tier });
  } catch (err) {
    console.error('proxy account-status entitlement check failed', err);
    res.status(500).json({ error: 'Could not check subscription status right now.' });
  }
};
