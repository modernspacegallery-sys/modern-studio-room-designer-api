const { applyCors } = require('../lib/cors');
const { getEntitlement } = require('../lib/entitlement');
const { checkRateLimit } = require('../lib/rate-limit');

// GET /api/entitlement?customerId=123456789
// -> { tier: 'free' | 'ai_plus' }
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const customerId = String(req.query.customerId || '').trim();
  if (!/^[0-9]{1,30}$/.test(customerId)) {
    res.status(400).json({ error: 'Invalid customerId.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'entitlement');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  try {
    const tier = await getEntitlement(customerId);
    res.status(200).json({ tier });
  } catch (err) {
    console.error('entitlement check failed', err);
    res.status(500).json({ error: 'Could not check subscription status right now.' });
  }
};
