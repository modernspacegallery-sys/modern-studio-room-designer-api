const { applyCors } = require('../lib/cors');
const { getEntitlement } = require('../lib/entitlement');
const { checkRateLimit } = require('../lib/rate-limit');
const { getCreditsRemaining, computePeriodStart, AI_PLUS_MONTHLY_CREDITS } = require('../lib/credits');

// GET /api/entitlement?customerId=123456789
// -> { tier: 'free' } or { tier: 'ai_plus', credits: { remaining, total, periodStart } }
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
    const { tier, periodAnchor } = await getEntitlement(customerId);
    if (tier === 'ai_plus' && periodAnchor) {
      const periodStart = computePeriodStart(periodAnchor);
      const remaining = await getCreditsRemaining(customerId, periodStart);
      res.status(200).json({ tier, credits: { remaining, total: AI_PLUS_MONTHLY_CREDITS, periodStart } });
      return;
    }
    res.status(200).json({ tier });
  } catch (err) {
    console.error('entitlement check failed', err);
    res.status(500).json({ error: 'Could not check subscription status right now.' });
  }
};
