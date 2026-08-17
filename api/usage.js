const { applyCors } = require('../lib/cors');
const { getRemaining, FREE_LIMIT } = require('../lib/usage-store');
const { getCreditsRemaining, computePeriodStart, computeNextReset, AI_PLUS_MONTHLY_CREDITS } = require('../lib/credits');
const { checkRateLimit } = require('../lib/rate-limit');
const { getEntitlement } = require('../lib/entitlement');
const { verifyCustomerToken } = require('../lib/verify-customer-token');

// GET /api/usage?customerId=123456789&issuedAt=...&token=...
// -> { remaining, tier } for free tier
// -> { remaining, tier, total, renewsOn } for AI+
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
    const { tier, periodAnchor } = await getEntitlement(cleanCustomerId);

    if (tier === 'ai_plus' && periodAnchor) {
      const periodStart = computePeriodStart(periodAnchor);
      const remaining = await getCreditsRemaining(cleanCustomerId, periodStart);
      res.status(200).json({
        remaining,
        tier,
        total: AI_PLUS_MONTHLY_CREDITS,
        renewsOn: computeNextReset(periodStart),
      });
      return;
    }

    const remaining = await getRemaining(cleanCustomerId, FREE_LIMIT);
    res.status(200).json({ remaining, tier: 'free' });
  } catch (err) {
    console.error('usage lookup failed', err);
    res.status(500).json({ error: 'Could not check usage right now.' });
  }
};
