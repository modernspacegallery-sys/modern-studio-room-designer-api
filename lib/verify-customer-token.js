// Verifies a customer identity token that Shopify signed server-side (via
// Liquid's hmac_sha256 filter) at page-render time. This is the actual fix
// for the trust gap documented in usage-store.js and entitlement.js: a raw
// client-supplied customerId can be edited in devtools, but a visitor can
// never produce a valid signature for someone else's ID without knowing
// this secret, which never reaches the browser.

const crypto = require('crypto');

const SECRET = process.env.CUSTOMER_TOKEN_SECRET;
const MAX_AGE_SECONDS = 300; // 5 minutes — long enough for a normal page visit, short enough that a captured token can't be replayed indefinitely

function verifyCustomerToken(customerId, issuedAt, token) {
  if (!SECRET) {
    console.error('CUSTOMER_TOKEN_SECRET is not set — failing closed, rejecting all tokens.');
    return false;
  }
  if (!customerId || !issuedAt || !token) return false;

  const issuedAtNum = parseInt(issuedAt, 10);
  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAtNum;
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > MAX_AGE_SECONDS) {
    return false;
  }

  const payload = `${customerId}.${issuedAt}`;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');

  const expectedBuf = Buffer.from(expected);
  const tokenBuf = Buffer.from(String(token));
  if (expectedBuf.length !== tokenBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, tokenBuf);
}

module.exports = { verifyCustomerToken };
