const { applyCors } = require('../lib/cors');
const { getRemaining, FREE_LIMIT, AI_PLUS_LIMIT } = require('../lib/usage-store');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');
const { customerExists } = require('../lib/customer-verify');

// GET /api/usage?customerId=123456789
// Matches the contract expected by assets/studio-room-designer.js:
//   fetch(API_BASE + '/api/usage?customerId=' + customerId)
//     -> { remaining: <number> }
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const customerId = String(req.query.customerId || '').trim();
  if (!/^[0-9]{1,30}$/.test(customerId)) {
    // Shopify's customer.id renders as a plain integer in Liquid. Anything
    // else isn't a value the theme would legitimately send.
    res.status(400).json({ error: 'Invalid customerId.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'usage');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const isRealCustomer = await customerExists(customerId);
  if (!isRealCustomer) {
    res.status(400).json({ error: 'Invalid customerId.' });
    return;
  }

  try {
    const tier = await getEntitlement(customerId);
    const limit = tier === 'ai_plus' ? AI_PLUS_LIMIT : FREE_LIMIT;
    const remaining = await getRemaining(customerId, limit);
    res.status(200).json({ remaining, tier });
  } catch (err) {
    console.error('usage lookup failed', err);
    res.status(500).json({ error: 'Could not check usage right now.' });
  }
};
