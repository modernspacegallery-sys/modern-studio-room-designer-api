// Route-level tests for api/proxy/usage.js — the Room Designer Stage A App
// Proxy migration (Phase 4D.23). Uses the same Module._load substitution
// technique as the 4D.15/4D.17A proxy test suites, so the actual production
// files run unmodified against an in-memory fake KV — no real credentials
// needed, and no real OpenAI/credit-spend call is ever reachable from here.

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

const proxyUsageHandler = require('../api/proxy/usage');
const legacyUsageHandler = require('../api/usage');

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

test('4D.23-A. missing signature is rejected with 401 not_authenticated', async () => {
  const params = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: '555000111',
  };
  const req = mockReq({ query: params, remoteAddress: '10.1.0.1' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-B. FORGED/direct-Vercel-bypass signature is rejected with 401, never authenticated', async () => {
  const req = mockReq({
    query: {
      shop: 'modernspacegallery.myshopify.com',
      path_prefix: '/apps/modern-studio',
      timestamp: String(Math.floor(Date.now() / 1000)),
      logged_in_customer_id: '1', // attacker's target victim ID
      signature: '0'.repeat(64),
    },
    remoteAddress: '10.1.0.2',
  });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-C. a signature-valid but STALE timestamp is rejected with 401', async () => {
  const staleTs = String(Math.floor(Date.now() / 1000) - 999999);
  const req = mockReq({ query: freshSignedQuery({ timestamp: staleTs }), remoteAddress: '10.1.0.3' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-D. a signature-valid but far-FUTURE timestamp (beyond clock skew) is rejected with 401', async () => {
  const futureTs = String(Math.floor(Date.now() / 1000) + 999999);
  const req = mockReq({ query: freshSignedQuery({ timestamp: futureTs }), remoteAddress: '10.1.0.4' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-E. a validly signed, LOGGED-OUT request returns 401 not_authenticated (distinct from an invalid signature, same response)', async () => {
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: null }), remoteAddress: '10.1.0.5' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-F. non-GET methods are rejected with 405', async () => {
  const req = mockReq({ method: 'POST', query: freshSignedQuery(), remoteAddress: '10.1.0.6' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 405);
});

test('4D.23-G. a valid FREE-tier customer gets { remaining, tier } matching the legacy /api/usage contract exactly', async () => {
  const customerId = '555000222';
  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: customerId }), remoteAddress: '10.1.0.7' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { remaining: 2, tier: 'free' });
});

test('4D.23-H. a valid AI+ customer gets { remaining, tier, total, renewsOn } matching the legacy /api/usage contract exactly', async () => {
  const customerId = '555000333';
  const periodAnchor = new Date().toISOString();
  await fakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor });

  const req = mockReq({ query: freshSignedQuery({ logged_in_customer_id: customerId }), remoteAddress: '10.1.0.8' });
  const res = mockRes();
  await proxyUsageHandler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.tier, 'ai_plus');
  assert.equal(typeof res.body.remaining, 'number');
  assert.equal(typeof res.body.total, 'number');
  assert.equal(typeof res.body.renewsOn, 'string');
});

test('4D.23-I. rate-limit denial returns 429 (RATE_LIMIT_PER_MINUTE=3 for this test run)', async () => {
  const ip = '10.1.0.9';
  let lastRes;
  for (let i = 0; i < 4; i++) {
    const req = mockReq({ query: freshSignedQuery(), remoteAddress: ip });
    lastRes = mockRes();
    await proxyUsageHandler(req, lastRes);
  }
  assert.equal(lastRes.statusCode, 429);
  assert.deepEqual(lastRes.body, { error: 'Too many requests. Please try again shortly.' });
});

test('4D.23-J. a customerId param in the request cannot override the Shopify-signed logged_in_customer_id', async () => {
  // The trusted identity is logged_in_customer_id=555000444 (free tier,
  // unused -> remaining 2). An extra customerId param points at a DIFFERENT
  // customer's usage record that has already been "used up". This param is
  // included in the signed canonical string (as it would have to be for the
  // signature to still validate — an attacker appending an unsigned extra
  // param would simply invalidate the signature and get 401, which is a
  // separate, already-covered case). The point of this test is the code
  // path: api/proxy/usage.js must key its lookup exclusively off
  // verification.customerId (from logged_in_customer_id) and never off
  // req.query.customerId, even when the latter is present and validly
  // signed.
  const signedCustomerId = '555000444';
  const spoofedCustomerId = '555000555';
  await fakeKv.set(`rd:used:${spoofedCustomerId}`, 2); // spoofed target has 0 remaining

  const query = buildSignedQuery(PROXY_SECRET, {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: signedCustomerId,
    customerId: spoofedCustomerId,
  });
  const req = mockReq({ query, remoteAddress: '10.1.0.10' });
  const res = mockRes();
  await proxyUsageHandler(req, res);

  assert.equal(res.statusCode, 200);
  // Reflects the SIGNED customer (fresh, unused -> remaining 2), not the
  // spoofed one's exhausted count.
  assert.deepEqual(res.body, { remaining: 2, tier: 'free' });
});

test('4D.23-K. a validly-signed LEGACY issuedAt/token pair cannot establish identity on its own (proxy signature is still required)', async () => {
  const crypto = require('crypto');
  const customerId = '555000666';
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const legacySecret = process.env.CUSTOMER_TOKEN_SECRET;
  const legacyToken = crypto.createHmac('sha256', legacySecret).update(`${customerId}.${issuedAt}`).digest('hex');

  // A request carrying a perfectly valid LEGACY token, but no App Proxy
  // signature at all, must still be rejected — this route never imports or
  // consults verify-customer-token.js.
  const req = mockReq({ query: { customerId, issuedAt, token: legacyToken }, remoteAddress: '10.1.0.11' });
  const res = mockRes();
  await proxyUsageHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('4D.23-L. the route is strictly read-only: a successful lookup never increments/mutates any usage or credit KV key', async () => {
  const customerId = '555000777';
  const usageKey = `rd:used:${customerId}`;
  const query = freshSignedQuery({ logged_in_customer_id: customerId });

  // Call it multiple times, same as a page that re-checks usage.
  for (let i = 0; i < 3; i++) {
    const req = mockReq({ query, remoteAddress: `10.1.0.${20 + i}` });
    const res = mockRes();
    await proxyUsageHandler(req, res);
    assert.equal(res.statusCode, 200);
  }

  // No usage key should have been created/incremented by a read-only route.
  assert.equal(fakeKv._store.has(usageKey), false);
  // Sanity: the KEY SPACE this route is allowed to touch (rate-limit
  // counters) is the only thing that changed.
  const touchedNonRateLimitKeys = Array.from(fakeKv._store.keys()).filter(
    (k) => !k.startsWith('ratelimit:') && !k.startsWith('entitlement:')
  );
  assert.deepEqual(touchedNonRateLimitKeys, []);
});

test.after(() => {
  Module._load = originalLoad;
});
