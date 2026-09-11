// Verifies a Shopify App Proxy request's signature and freshness, and — only
// after that verification succeeds — returns the customer identity Shopify
// itself is vouching for.
//
// Trust model (see Phase 4D.13/4D.14 audit): this module is the ONLY thing
// that may turn a `logged_in_customer_id` query parameter into a trusted
// identity. Shopify appends `shop`, `path_prefix`, `timestamp`,
// `logged_in_customer_id` (when a customer is logged in) and `signature` to
// every request it forwards through an App Proxy. A request that reaches us
// WITHOUT going through Shopify's proxy can set any of those fields to
// anything it likes — `signature` is what makes that forgery detectable,
// because it can only be produced by someone holding this app's Shopify
// Client Secret, which never reaches the browser or the theme.
//
// This deliberately does NOT depend on CUSTOMER_TOKEN_SECRET (the legacy
// theme-HMAC secret) in any way — this is a separate, additive trust path,
// not a replacement wired into the old one. The two mechanisms coexist until
// every Studio caller has migrated (see Phase 4D.13/4D.14 migration plan).
//
// Canonicalization contract (per Shopify's documented App Proxy
// authentication algorithm — re-confirmed against Shopify's current official
// docs as of Phase 4D.14.1/4D.15, not implemted from memory):
//   1. Take every query parameter EXCEPT `signature`.
//   2. Sort the remaining parameters alphabetically by key.
//   3. A key that appears more than once has its values joined with `,`
//      into a single value.
//   4. Each pair is written as `key=value` and all pairs are concatenated
//      with NO delimiter between them (this is the detail most homegrown
//      verifiers get wrong by inserting `&`).
//   5. Compute HMAC-SHA256 of that string, keyed with the app's Client
//      Secret, hex-encoded.
//   6. Compare to the `signature` parameter using a constant-time
//      comparison.

const crypto = require('crypto');

const CLIENT_SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

// Freshness is a SEPARATE, configurable policy from signature correctness.
// A signature failure always rejects regardless of this value. This default
// is a conservative starting point for local/pilot use, not a number chosen
// from production latency data — the real value should be set via
// SHOPIFY_PROXY_MAX_AGE_SECONDS once actual Shopify -> Vercel proxy latency
// has been observed during the pilot (see Phase 4D.14 item 6 / 4D.15 item 4).
const DEFAULT_MAX_AGE_SECONDS = 60;

function resolveMaxAgeSeconds() {
  const raw = process.env.SHOPIFY_PROXY_MAX_AGE_SECONDS;
  if (raw === undefined || raw === '') return DEFAULT_MAX_AGE_SECONDS;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_AGE_SECONDS;
}

// Small allowance for clock skew between Shopify's servers and Vercel's,
// applied only to timestamps that appear to be in the future. A signed
// request timestamped a few seconds ahead of our clock isn't suspicious;
// one far in the future is.
const CLOCK_SKEW_SECONDS = 5;

/**
 * Recomputes the Shopify App Proxy signature over `query` and compares it,
 * constant-time, to the `signature` parameter already in `query`.
 * @param {Record<string, string|string[]>} query
 * @returns {boolean}
 */
function verifySignature(query) {
  if (!CLIENT_SECRET) return false;

  const signature = query.signature;
  if (!signature || typeof signature !== 'string') return false;

  const canonical = Object.keys(query)
    .filter((key) => key !== 'signature')
    .sort()
    .map((key) => {
      const rawValue = query[key];
      const value = Array.isArray(rawValue) ? rawValue.join(',') : rawValue;
      return `${key}=${value}`;
    })
    .join('');

  const expected = crypto.createHmac('sha256', CLIENT_SECRET).update(canonical).digest('hex');

  const expectedBuf = Buffer.from(expected, 'utf8');
  const signatureBuf = Buffer.from(signature, 'utf8');
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}

/**
 * @param {unknown} rawTimestamp
 * @returns {{ ok: true } | { ok: false, reason: 'malformed_timestamp'|'stale_timestamp'|'future_timestamp' }}
 */
function checkTimestamp(rawTimestamp) {
  if (typeof rawTimestamp !== 'string' || !/^[0-9]+$/.test(rawTimestamp)) {
    return { ok: false, reason: 'malformed_timestamp' };
  }
  const ts = parseInt(rawTimestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = now - ts;

  if (ageSeconds > resolveMaxAgeSeconds()) {
    return { ok: false, reason: 'stale_timestamp' };
  }
  if (ageSeconds < -CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: 'future_timestamp' };
  }
  return { ok: true };
}

/**
 * Verifies a Shopify App Proxy request end-to-end: signature first (which
 * transitively covers every signed parameter, including timestamp and
 * logged_in_customer_id — so altering either after signing is caught here,
 * not by a separate check), then freshness, then extracts the trusted
 * customer identity if any.
 *
 * @param {Record<string, string|string[]>} query - the request's query
 *   parameters, exactly as Shopify forwarded them.
 * @returns {{ ok: true, customerId: string|null } | { ok: false, reason: string }}
 *   customerId is null when the signature is valid but no customer is
 *   logged in (a legitimate, distinct state — never treat this as "free
 *   authenticated customer").
 */
function verifyShopifyProxyRequest(query) {
  if (!CLIENT_SECRET) {
    console.error('SHOPIFY_STUDIO_PROXY_CLIENT_SECRET is not set — failing closed, rejecting all proxy requests.');
    return { ok: false, reason: 'not_configured' };
  }
  if (!query || typeof query !== 'object') {
    return { ok: false, reason: 'invalid_request' };
  }

  if (!verifySignature(query)) {
    return { ok: false, reason: 'invalid_signature' };
  }

  const timestampCheck = checkTimestamp(query.timestamp);
  if (!timestampCheck.ok) {
    return { ok: false, reason: timestampCheck.reason };
  }

  const rawCustomerId = query.logged_in_customer_id;
  if (rawCustomerId === undefined || rawCustomerId === null || rawCustomerId === '') {
    // Signature is valid, but nobody is logged in. This is NOT an error —
    // it's a legitimate, distinct state callers must handle explicitly.
    return { ok: true, customerId: null };
  }
  if (typeof rawCustomerId !== 'string' || !/^[0-9]+$/.test(rawCustomerId)) {
    return { ok: false, reason: 'invalid_customer_id' };
  }

  return { ok: true, customerId: rawCustomerId };
}

module.exports = {
  verifyShopifyProxyRequest,
  // Exported for tests only — not part of the intended external API.
  _internal: { verifySignature, checkTimestamp, resolveMaxAgeSeconds },
};
