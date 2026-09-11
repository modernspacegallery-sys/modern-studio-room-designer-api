// Route-level tests for api/proxy/account-status.js and a regression check
// that the legacy api/entitlement.js route is completely untouched by this
// phase. Uses the same Module._load substitution technique as the
// 4D.10-4D.11.1 Projects test suite, so the actual production files run
// unmodified against an in-memory fake KV — no real credentials needed.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.CUSTOMER_TOKEN_SECRET = 'test-legacy-secret-not-real';

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

const proxyAccountStatusHandler = require('../api/proxy/account-status');
const legacyEntitlementHandler = require('../api/entitlement');

const PROXY_SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

function mockReq({ method = 'GET', query = {}, headers = {} } = {}) {
  return { method, query, headers, socket: { remoteAddress: '127.0.0.1' } };
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

test('4D.15-N. a validly signed, logged-in proxy request returns the free-tier contract unchanged', async () => {
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: '555000111' }) });
  const res = mockRes();
  await proxyAccountStatusHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tier: 'free' });
});

test('4D.15-O. a validly signed, logged-in proxy request for an AI+ customer preserves the exact existing credits contract', async () => {
  const customerId = '555000222';
  const periodAnchor = new Date().toISOString();
  await fakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor });

  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: customerId }) });
  const res = mockRes();
  await proxyAccountStatusHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'ai_plus');
  assert.equal(typeof res.body.credits.remaining, 'number');
  assert.equal(typeof res.body.credits.total, 'number');
  assert.equal(typeof res.body.credits.renewsOn, 'string');
});

test('4D.15-P. LOGGED-OUT CONTRACT: a validly signed request with no logged_in_customer_id returns 401 not_authenticated, never a free-tier success', async () => {
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: null }) });
  const res = mockRes();
  await proxyAccountStatusHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.15-Q. DIRECT-VERCEL BYPASS at the route level: an unsigned request with a forged logged_in_customer_id is rejected, never authenticated', async () => {
  const req = mockReq({
    query: {
      shop: 'modernspacegallery.myshopify.com',
      path_prefix: '/apps/modern-studio',
      timestamp: String(Math.floor(Date.now() / 1000)),
      logged_in_customer_id: '1', // attacker's target victim ID, no valid signature
      signature: '0'.repeat(64),
    },
  });
  const res = mockRes();
  await proxyAccountStatusHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.15-R. non-GET methods are rejected on the proxy route', async () => {
  const req = mockReq({ method: 'POST', query: freshSignedQuery() });
  const res = mockRes();
  await proxyAccountStatusHandler(req, res);
  assert.equal(res.statusCode, 405);
});

test('4D.15-S. LEGACY REGRESSION: api/entitlement.js still requires and honors the OLD theme-HMAC token unchanged', async () => {
  const crypto = require('crypto');
  const customerId = '555000333';
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const legacySecret = process.env.CUSTOMER_TOKEN_SECRET;
  const token = crypto.createHmac('sha256', legacySecret).update(`${customerId}.${issuedAt}`).digest('hex');

  const req = mockReq({ query: { customerId, issuedAt, token } });
  const res = mockRes();
  await legacyEntitlementHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { tier: 'free' });
});

test('4D.15-T. LEGACY REGRESSION: api/entitlement.js still rejects a request with no valid legacy token (proxy secret does not leak into it)', async () => {
  const req = mockReq({ query: { customerId: '555000333', issuedAt: '1', token: 'bad' } });
  const res = mockRes();
  await legacyEntitlementHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test.after(() => {
  Module._load = originalLoad;
});
