const { applyCors } = require('../lib/cors');
const { getRemaining, FREE_LIMIT, AI_PLUS_LIMIT } = require('../lib/usage-store');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');
const { verifyCustomerToken } = require('../lib/verify-customer-token');

// GET /api/usage?customerId=123456789&issuedAt=...&token=...
// Matches the contract expected by assets/studio-room-designer.js.
//
// customerId is no longer trusted on its own — issuedAt + token are a
// signature Shopify computed server-side (via Liquid's hmac_sha256 filter)
// at page-render time. See lib/verify-customer-token.js.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { customerId, issuedAt, token } = req.query;
  const cleanCustomerId = String(customerId || '').trim();
  if (!/^[0-9]{1,30}$/.test(cleanCustomerId)) {
    res.status(400).json({ error: 'Invalid customerId.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'usage');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  if (!verifyCustomerToken(cleanCustomerId, issuedAt, token)) {
    res.status(401).json({ error: 'Could not verify your session. Please refresh the page and try again.' });
    return;
  }

  try {
    const tier = await getEntitlement(cleanCustomerId);
    const limit = tier === 'ai_plus' ? AI_PLUS_LIMIT : FREE_LIMIT;
    const remaining = await getRemaining(cleanCustomerId, limit);
    res.status(200).json({ remaining, tier });
  } catch (err) {
    console.error('usage lookup failed', err);
    res.status(500).json({ error: 'Could not check usage right now.' });
  }
};
