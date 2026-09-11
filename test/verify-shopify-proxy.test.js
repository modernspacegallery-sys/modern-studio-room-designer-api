// Tests for lib/verify-shopify-proxy.js — the sole gate between an
// unsigned/forgeable query parameter and a trusted customer identity.
// Uses an obviously-fake Client Secret; never a real credential.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSignedQuery } = require('./sign-helper');

const SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

function nowTs() {
  return String(Math.floor(Date.now() / 1000));
}

function freshParams(overrides = {}) {
  return {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: nowTs(),
    logged_in_customer_id: '123456789',
    ...overrides,
  };
}

test('4D.15-A. a validly signed, fresh, logged-in request is accepted with the correct customer ID', () => {
  delete require.cache[require.resolve('../lib/verify-shopify-proxy')];
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(SECRET, freshParams());
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, true);
  assert.equal(result.customerId, '123456789');
});

test('4D.15-B. a validly signed, fresh, logged-OUT request is accepted with a null customer ID (not an error)', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const params = freshParams();
  delete params.logged_in_customer_id;
  const query = buildSignedQuery(SECRET, params);
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, true);
  assert.equal(result.customerId, null);
});

test('4D.15-C. missing signature is rejected', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = freshParams(); // no signature key at all
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('4D.15-D. wrong signature (valid hex, wrong value) is rejected', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(SECRET, freshParams());
  query.signature = 'a'.repeat(query.signature.length); // same length, wrong value
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('4D.15-E. malformed signature (garbage, wrong length) is rejected', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(SECRET, freshParams());
  query.signature = 'not-a-real-signature';
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('4D.15-F. customer ID altered after signing is rejected (signature covers it)', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(SECRET, freshParams({ logged_in_customer_id: '123456789' }));
  query.logged_in_customer_id = '999999999'; // tamper AFTER signing
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('4D.15-G. timestamp altered after signing is rejected (signature covers it)', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(SECRET, freshParams());
  query.timestamp = String(parseInt(query.timestamp, 10) - 5); // tamper AFTER signing
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});

test('4D.15-H. a signature-valid but STALE timestamp is rejected', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const staleTs = String(Math.floor(Date.now() / 1000) - 999999);
  const query = buildSignedQuery(SECRET, freshParams({ timestamp: staleTs }));
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'stale_timestamp');
});

test('4D.15-I. a signature-valid but far-FUTURE timestamp (beyond clock skew) is rejected', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const futureTs = String(Math.floor(Date.now() / 1000) + 999999);
  const query = buildSignedQuery(SECRET, freshParams({ timestamp: futureTs }));
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'future_timestamp');
});

test('4D.15-J. a malformed (non-numeric) timestamp is rejected even before freshness is considered', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  // Sign a query whose timestamp value literally is the non-numeric string,
  // so this exercises the malformed-timestamp path specifically rather than
  // just tripping the signature check.
  const query = buildSignedQuery(SECRET, freshParams({ timestamp: '20xx-not-a-number' }));
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'malformed_timestamp');
});

test('4D.15-K. a repeated query key is canonicalized as a comma-joined value (matches Shopify contract)', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const params = freshParams({ extra: ['a', 'b'] });
  const query = buildSignedQuery(SECRET, params);
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, true);
});

test('4D.15-L. missing SHOPIFY_STUDIO_PROXY_CLIENT_SECRET fails closed, not open', () => {
  const original = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;
  delete process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;
  delete require.cache[require.resolve('../lib/verify-shopify-proxy')];
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  const query = buildSignedQuery(original, freshParams());
  const result = verifyShopifyProxyRequest(query);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not_configured');
  // restore for subsequent tests/files
  process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = original;
  delete require.cache[require.resolve('../lib/verify-shopify-proxy')];
});

test('4D.15-M. DIRECT-VERCEL BYPASS: an unsigned request carrying an arbitrary logged_in_customer_id must never authenticate', () => {
  const { verifyShopifyProxyRequest } = require('../lib/verify-shopify-proxy');
  // Simulates an attacker calling the Vercel URL directly, skipping Shopify
  // entirely, and just setting the field they want to be trusted.
  const forged = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: nowTs(),
    logged_in_customer_id: '1', // attacker's target victim ID
    signature: 'deadbeef'.repeat(8),
  };
  const result = verifyShopifyProxyRequest(forged);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid_signature');
});
