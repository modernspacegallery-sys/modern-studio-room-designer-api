// Shared CORS handling for all API routes.
//
// The Shopify theme calls this API cross-origin (from modernspacegallery.com
// to this Vercel project's domain) using plain fetch() with a JSON body, which
// triggers a CORS preflight (OPTIONS) request on POST. Every handler must call
// applyCors() first and return early on preflight requests.

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://modernspacegallery.com,https://www.modernspacegallery.com'
)
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

/**
 * Applies CORS headers and handles OPTIONS preflight.
 * @returns {boolean} true if the request was a preflight request and has
 *   already been fully handled (caller should return immediately).
 */
function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }
  return false;
}

module.exports = { applyCors, ALLOWED_ORIGINS };
