// Basic per-IP rate limiting, on top of the per-customer usage limit.
// This exists to blunt scripted abuse (e.g. hammering the endpoint with
// randomized customerId values) — it is a safety net, not the primary
// entitlement check.

const { kv } = require('@vercel/kv');

const WINDOW_SECONDS = 60;
const MAX_REQUESTS_PER_WINDOW = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '10', 10);

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

/**
 * @returns {Promise<boolean>} true if the request is allowed, false if it
 *   should be rejected with 429.
 */
async function checkRateLimit(req, bucket) {
  const ip = getClientIp(req);
  const key = `ratelimit:${bucket}:${ip}`;
  const count = await kv.incr(key);
  if (count === 1) {
    await kv.expire(key, WINDOW_SECONDS);
  }
  return count <= MAX_REQUESTS_PER_WINDOW;
}

module.exports = { checkRateLimit };
