// Shared request-gating for every Projects/Homes cloud route: dark-launch
// flag, then App Proxy identity verification, in that order. Deliberately a
// single helper so every route applies both checks the same way -- see
// Phase 5C Section 6 ("App Proxy identity only") and Section 10 ("dark
// launch").
//
// This module NEVER reads customerId from anything other than
// verifyShopifyProxyRequest's return value. There is no code path here that
// accepts a client-supplied identity of any kind, and the legacy
// customer-token HMAC path (lib/verify-customer-token.js) is never imported
// here -- these routes support only the App Proxy identity path, per Phase
// 5C Section 6 and Phase 5B's "Legacy Authentication Interaction" section.

const { verifyShopifyProxyRequest } = require('./verify-shopify-proxy');
const { isStudioCloudProjectsEnabled } = require('./studio-cloud-flag');

/**
 * @returns {{ ok: true, customerId: string } | { ok: false }} - on false,
 *   the response has already been written; the caller should just return.
 */
function gate(req, res) {
  if (!isStudioCloudProjectsEnabled()) {
    // Flag off: behave as if the route does not exist. This is a dark
    // launch -- there is no legitimate caller yet, so there is nothing to
    // be helpful to, and no reason to distinguish "disabled" from
    // "unknown route" for anyone probing it.
    res.status(404).json({ error: 'not_found' });
    return { ok: false };
  }

  const verification = verifyShopifyProxyRequest(req.query);
  if (!verification.ok || !verification.customerId) {
    // Same collapse as every other proxy route in this codebase: an invalid
    // signature and a valid-but-logged-out request both read as
    // "not authenticated" to the caller.
    res.status(401).json({ error: 'not_authenticated' });
    return { ok: false };
  }

  return { ok: true, customerId: verification.customerId };
}

module.exports = { gate };
