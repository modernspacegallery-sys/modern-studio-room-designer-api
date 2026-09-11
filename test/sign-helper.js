// Test-only helper that signs a fake App Proxy query string the same way
// Shopify's documented algorithm does, so tests can construct both
// legitimately-signed and deliberately-tampered requests without
// duplicating the production canonicalization logic (which would risk the
// tests passing for the wrong reason if both copies drifted the same way).
// This intentionally reimplements the algorithm independently rather than
// importing lib/verify-shopify-proxy's internals, so the test is a genuine
// check against the documented contract, not a tautology.

const crypto = require('crypto');

function signQuery(secret, paramsWithoutSignature) {
  const canonical = Object.keys(paramsWithoutSignature)
    .sort()
    .map((key) => {
      const raw = paramsWithoutSignature[key];
      const value = Array.isArray(raw) ? raw.join(',') : raw;
      return `${key}=${value}`;
    })
    .join('');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

/**
 * Builds a fully-signed fake App Proxy query object.
 * @param {string} secret
 * @param {object} params - params WITHOUT `signature` (e.g. shop, path_prefix,
 *   timestamp, logged_in_customer_id).
 */
function buildSignedQuery(secret, params) {
  const signature = signQuery(secret, params);
  return { ...params, signature };
}

module.exports = { signQuery, buildSignedQuery };
