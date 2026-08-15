const { applyCors } = require('../lib/cors');
const { getToolUsageStats } = require('../lib/tool-usage');

// GET /api/tool-usage-stats?key=YOUR_SECRET
// A simple private dashboard-of-one: visit this URL (with the secret you set
// in STATS_SECRET) any time to see how many times each AI tool has been used,
// in total and today. Not linked anywhere in the storefront.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const providedKey = String(req.query.key || '');
  if (!process.env.STATS_SECRET || providedKey !== process.env.STATS_SECRET) {
    // Deliberately vague — don't reveal whether the secret is merely wrong
    // or not configured at all.
    res.status(404).json({ error: 'Not found.' });
    return;
  }

  try {
    const stats = await getToolUsageStats();
    res.status(200).json(stats);
  } catch (err) {
    console.error('tool-usage-stats failed', err);
    res.status(500).json({ error: 'Could not load usage stats right now.' });
  }
};
