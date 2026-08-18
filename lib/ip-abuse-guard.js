// Secondary, IP-based ceiling on FREE-tier design generations, on top of the
// per-customer 2-design limit. Exists specifically to blunt the easiest form
// of abuse: signing up with a new email to get a fresh set of free designs.
// A determined person switching networks defeats this, but it stops the
// common lazy case (same device/wifi, new account) without adding friction
// for legitimate multi-person households sharing one connection.
//
// AI+ subscribers are NOT subject to this — they're already paying, and
// shouldn't be limited by how many free-tier visitors happen to share their IP.
//
// Fails OPEN by design: this is an anti-abuse heuristic, not the primary
// entitlement check (that's still the per-customer limit + signed token) —
// a KV hiccup here should not take down free-tier access for everyone on a
// shared connection.

const { kv } = require('@vercel/kv');

const WINDOW_SECONDS = parseInt(process.env.IP_FREE_LIMIT_WINDOW_SECONDS || String(7 * 24 * 60 * 60), 10); // 7 days
const IP_FREE_DESIGN_LIMIT = parseInt(process.env.IP_FREE_DESIGN_LIMIT || '8', 10);

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function ipKey(ip) {
  return `ipfreeuse:${ip}`;
}

async function isIpOverFreeLimit(req) {
  try {
    const ip = getClientIp(req);
    if (ip === 'unknown') return false; // can't track it — don't block on it
    const used = (await kv.get(ipKey(ip))) || 0;
    return used >= IP_FREE_DESIGN_LIMIT;
  } catch (err) {
    console.error('isIpOverFreeLimit check failed, failing open', err);
    return false;
  }
}

async function recordIpFreeUse(req) {
  try {
    const ip = getClientIp(req);
    if (ip === 'unknown') return;
    const key = ipKey(ip);
    const count = await kv.incr(key);
    if (count === 1) {
      await kv.expire(key, WINDOW_SECONDS);
    }
  } catch (err) {
    console.error('recordIpFreeUse failed (non-fatal)', err);
  }
}

module.exports = { isIpOverFreeLimit, recordIpFreeUse, IP_FREE_DESIGN_LIMIT };
