// Route-level tests for api/proxy/entitlement.js — the Mood Board App Proxy
// migration (Phase 4D.17A) — plus a regression check that the legacy
// api/entitlement.js route is completely untouched by this phase. Uses the
// same Module._load substitution technique as the 4D.15 Account Status
// proxy test suite, so the actual production files run unmodified against
// an in-memory fake KV — no real credentials needed.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.CUSTOMER_TOKEN_SECRET = 'test-legacy-secret-not-real';
process.env.RATE_LIMIT_PER_MINUTE = '3';

const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeKv } = require('./fake-kv');
const { buildSignedQuery } = require('./sign-helper');

const fakeKv = createFakeKv();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@vercel/kv') {
    return { kv: fakeKv };
  }
  return originalLoad.apply(this, arguments);
};

const proxyEntitlementHandler = require('../api/proxy/entitlement');
const legacyEntitlementHandler = require('../api/entitlement');

const PROXY_SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

function mockReq({ method = 'GET', query = {}, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  return { method, query, headers, socket: { remoteAddress } };
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end() {
      return this;
    },
  };
  return res;
}

function freshSignedQuery(overrides = {}) {
  const params = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '555000111',
    ...overrides,
  };
  if (overrides.logged_in_customer_id === null) delete params.logged_in_customer_id;
  return buildSignedQuery(PROXY_SECRET, params);
}

test.beforeEach(() => {
  fakeKv.reset();
});

test('4D.17A-A. a validly signed, logged-in proxy request returns the free-tier contract unchanged', async () => {
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: '555000111' }), remoteAddress: '10.0.0.1' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tier: 'free' });
});

test('4D.17A-B. a validly signed, logged-in proxy request for an AI+ customer preserves the exact existing credits contract', async () => {
  const customerId = '555000222';
  const periodAnchor = new Date().toISOString();
  await fakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor });

  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: customerId }), remoteAddress: '10.0.0.2' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'ai_plus');
  assert.equal(typeof res.body.credits.remaining, 'number');
  assert.equal(typeof res.body.credits.total, 'number');
  assert.equal(typeof res.body.credits.renewsOn, 'string');
});

test('4D.17A-C. a validly signed, LOGGED-OUT request returns 401 not_authenticated', async () => {
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: null }), remoteAddress: '10.0.0.3' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-D. missing signature is rejected with 401', async () => {
  const params = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '555000111',
  };
  const req = mockReq({ query: params, remoteAddress: '10.0.0.4' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-E. FORGED/direct-Vercel-bypass signature is rejected with 401, never authenticated', async () => {
  const req = mockReq({
    query: {
      shop: 'modernspacegallery.myshopify.com',
      path_prefix: '/apps/modern-studio',
      timestamp: String(Math.floor(Date.now() / 1000)),
      logged_in_customer_id: '1', // attacker's target victim ID
      signature: '0'.repeat(64),
    },
    remoteAddress: '10.0.0.5',
  });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-F. customer ID altered after signing is rejected with 401 (signature covers it)', async () => {
  const query = freshSignedQuery({ logged_in_customer_id: '555000111' });
  query.logged_in_customer_id = '999999999'; // tamper AFTER signing
  const req = mockReq({ query, remoteAddress: '10.0.0.6' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-G. a signature-valid but STALE timestamp is rejected with 401', async () => {
  const staleTs = String(Math.floor(Date.now() / 1000) - 999999);
  const req = mockReq({ query: freshSignedQuery({ timestamp: staleTs }), remoteAddress: '10.0.0.7' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-H. a signature-valid but far-FUTURE timestamp (beyond clock skew) is rejected with 401', async () => {
  const futureTs = String(Math.floor(Date.now() / 1000) + 999999);
  const req = mockReq({ query: freshSignedQuery({ timestamp: futureTs }), remoteAddress: '10.0.0.8' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.17A-I. non-GET methods are rejected with 405', async () => {
  const req = mockReq({ method: 'POST', query: freshSignedQuery(), remoteAddress: '10.0.0.9' });
  const res = mockRes();
  await proxyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 405);
});

test('4D.17A-J. rate-limit denial returns 429 (RATE_LIMIT_PER_MINUTE=3 for this test run)', async () => {
  const ip = '10.0.0.10';
  let lastRes;
  for (let i = 0; i < 4; i++) {
    const req = mockReq({ query: freshSigndQuery(), remoteAddress: ip });
    lastRes = mockRes();
    await proxyEntitlementHandler(req, lastRes);
  }
  assert.equal(lastRes.statusCode, 429);
  assert.deepEqual(lastRes.body, { error: 'Too many requests. Please try again shortly.' });
});

test('4D.17A-K. missing SHOPIFY_STUDIO_PROXY_CLIENT_SECRET fails closed, not open', async () => {
  const original = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;
  delete process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;
  delete require.cache[require.resolve('../lib/verify-shopify-proxy')];
  delete require.cache[require.resolve('../api/proxy/entitlement')];
  const handler = require('../api/proxy/entitlement');

  const query = buildSignedQuery(original, {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '555000111',
  });
  const req = mockReq({ query, remoteAddress: '10.0.0.11' });
  const res = mockRes();
  await handler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });

  // restore for subsequent tests/files
  process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = original;
  delete require.cache[require.resolve('../lib/verify-shopify-proxy')];
  delete require.cache[require.resolve('../api/proxy/entitlement')];
});

test('4D.17A-L. LEGACY REGRESSION: api/entitlement.js still requires and honors the OLD theme-HMAC token unchanged', async () => {
  const crypto = require('crypto');
  const customerId = '555000333';
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const legacySecret = process.env.CUSTOMER_TOKEN_SECRET;
  const token = crypto.createHmac('sha256', legacySecret).update(`${customerId}.${issuedAt}`).digest('hex');

  const req = mockReq({ query: { customerId, issuedAt, token }, remoteAddress: '10.0.0.12' });
  const res = mockRes();
  await legacyEntitlementHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tier: 'free' });
});

test('4D.17A-M. LEGACY REGRESSION: api/entitlement.js still rejects a request with no valid legacy token (proxy secret does not leak into it)', async () => {
  const req = mockReq({ query: { customerId: '555000333', issuedAt: '1', token: 'bad' }, remoteAddress: '10.0.0.13' });
  const res = mockRes();
  await legacyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test.after(() => {
  Module._load = originalLoad;
});
