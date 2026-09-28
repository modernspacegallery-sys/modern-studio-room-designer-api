// Phase 6B #3: the Projects and Homes list replies report whether account
// saving is on (`writesEnabled`), so the theme can keep new work on the device
// while writes are off. Real, unmodified route files against in-memory fakes
// (same technique as studio-cloud-write-rollout.test.js).

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
delete process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;

const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeKv } = require('./fake-kv');
const { createFakePostgres } = require('./fake-postgres');
const { buildSignedQuery } = require('./sign-helper');

const fakeKv = createFakeKv();
const fakePg = createFakePostgres();
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === '@vercel/kv') return { kv: fakeKv };
  if (request === '../db/pool') return fakePg;
  return originalLoad.apply(this, arguments);
};

const projectsHandler = require('../api/proxy/projects');
const homesHandler = require('../api/proxy/homes');

const CUSTOMER = '5550001';

function q(customerId, extra) {
  return buildSignedQuery(process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET, Object.assign({
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: customerId,
  }, extra || {}));
}
function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() { return this; } };
}
async function call(handler, method, body, extra) {
  const res = mockRes();
  await handler({ method, query: q(CUSTOMER, extra), body: body || {}, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
async function withWrites(value, fn) {
  const before = process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  if (value === undefined) delete process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  else process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = value;
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
    else process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = before;
  }
}

test.beforeEach(async () => {
  fakeKv.reset();
  fakePg.reset();
  await fakeKv.set(`entitlement:${CUSTOMER}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() });
});

for (const [label, value, expected] of [['"true"', 'true', true], ['"false"', 'false', false], ['absent', undefined, false], ['"TRUE" (not the literal)', 'TRUE', false], ['"1"', '1', false]]) {
  test(`list replies report writesEnabled=${expected} when the writes flag is ${label}`, async () => {
    await withWrites(value, async () => {
      const p = await call(projectsHandler, 'GET');
      const h = await call(homesHandler, 'GET');
      assert.equal(p.statusCode, 200);
      assert.equal(h.statusCode, 200);
      assert.deepEqual(Object.keys(p.body).sort(), ['projects', 'writesEnabled']);
      assert.deepEqual(Object.keys(h.body).sort(), ['homes', 'writesEnabled']);
      assert.equal(p.body.writesEnabled, expected);
      assert.equal(h.body.writesEnabled, expected);
      assert.deepEqual(p.body.projects, []);
      assert.deepEqual(h.body.homes, []);
    });
  });
}

test('the status agrees with what a write actually does', async () => {
  await withWrites('true', async () => {
    const list = await call(homesHandler, 'GET');
    const w = await call(homesHandler, 'POST', { op: 'create', name: 'Status Home' });
    assert.equal(list.body.writesEnabled, true);
    assert.equal(w.statusCode, 200);
  });
  await withWrites('false', async () => {
    const list = await call(homesHandler, 'GET');
    const w = await call(homesHandler, 'POST', { op: 'create', name: 'Blocked Home' });
    assert.equal(list.body.writesEnabled, false);
    assert.equal(w.statusCode, 404);
  });
});

test('single-record reads are unchanged (no writesEnabled field)', async () => {
  await withWrites('true', async () => {
    const created = await call(homesHandler, 'POST', { op: 'create', name: 'One Home' });
    const one = await call(homesHandler, 'GET', null, { id: created.body.home.id });
    assert.equal(one.statusCode, 200);
    assert.deepEqual(Object.keys(one.body), ['home']);
  });
});

test('master flag off: list stays a plain 404 (no status disclosed)', async () => {
  const before = process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'false';
  try {
    await withWrites('true', async () => {
      const p = await call(projectsHandler, 'GET');
      const h = await call(homesHandler, 'GET');
      assert.equal(p.statusCode, 404);
      assert.equal(h.statusCode, 404);
      assert.equal(p.body.writesEnabled, undefined);
      assert.equal(h.body.writesEnabled, undefined);
    });
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_ENABLED = before;
  }
});

test('signed-out request: no status disclosed', async () => {
  await withWrites('true', async () => {
    const res = mockRes();
    await homesHandler({ method: 'GET', query: buildSignedQuery(process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET, {
      shop: 'modernspacegallery.myshopify.com', path_prefix: '/apps/modern-studio', timestamp: String(Math.floor(Date.now() / 1000)),
    }), body: {}, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    assert.notEqual(res.statusCode, 200);
    assert.equal(res.body && res.body.writesEnabled, undefined);
  });
});
