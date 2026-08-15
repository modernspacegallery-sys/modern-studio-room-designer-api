const { applyCors } = require('../lib/cors');
const { checkRateLimit } = require('../lib/rate-limit');
const { recordToolUse, VALID_TOOLS } = require('../lib/tool-usage');

// POST /api/track  { tool: 'room-designer' | 'mood-board' }
// A tiny best-effort usage beacon — used by the Mood Board Generator (which
// has no other backend call) to record that someone generated a board.
// Room Designer usage is recorded server-side directly in api/redesign.js
// on a successful generation, so it doesn't need to call this endpoint.
module.exports = async function handler(req, res) {
  if (applyCors(req, res)) return;

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const { tool } = req.body || {};
  if (!VALID_TOOLS.has(tool)) {
    res.status(400).json({ error: 'Invalid tool.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'track');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests.' });
    return;
  }

  try {
    await recordToolUse(tool);
  } catch (err) {
    console.error('track failed', err);
    // Fall through to a 200 regardless — a tracking beacon should never
    // surface an error to the customer-facing UI.
  }
  res.status(200).json({ ok: true });
};
