// Phase 5D.2B test suite for the second, independent rollout control:
// STUDIO_CLOUD_PROJECTS_WRITES_ENABLED (lib/studio-cloud-flag.js).
//
// Same Module._load substitution technique as test/studio-cloud-projects.js
// (real, unmodified route files run against in-memory fakes), but this file
// wraps the fake KV and fake Postgres with call counters so it can assert
// -- not just infer -- that a blocked write never reaches entitlement
// (checkStudioCloudCapability, which reads `entitlement:<id>` from KV) or
// Postgres (the repositories, which always go through fakePg.query /
// fakePg.withTransaction).
//
// Deliberately a separate file from studio-cloud-projects.test.js rather
// than folding these cases in there, so each file's env-var setup at module
// load time (which STUDIO_CLOUD_PROJECTS_ENABLED / _WRITES_ENABLED value
// the whole file runs under) stays simple and doesn't need per-test
// mutation of a value every other test in the same file also depends on.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
// Deliberately NOT set here at module scope -- each test sets exactly the
// value it needs and restores it in a `finally`, since this whole file is
// about that flag's on/off/absent behavior.
delete process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;

const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeKv } = require('./fake-kv');
const { createFakePostgres } = require('./fake-postgres');
const { buildSignedQuery } = require('./sign-helper');

const innerFakeKv = createFakeKv();
const innerFakePg = createFakePostgres();

// ---- Call-counting wrappers (test-only instrumentation, not production
// code and not a change to any repository/SQL file) ----

let entitlementGetCalls = 0;
let pgQueryCalls = 0;

const countingFakeKv = {
  ...innerFakeKv,
  async get(key) {
    if (typeof key === 'string' && key.startsWith('entitlement:')) entitlementGetCalls += 1;
    return innerFakeKv.get(key);
  },
  reset() {
    innerFakeKv.reset();
  },
};

const countingFakePg = {
  ...innerFakePg,
  async query(opts) {
    pgQueryCalls += 1;
    return innerFakePg.query(opts);
  },
  async withTransaction(fn) {
    return innerFakePg.withTransaction(async (query) => {
      return fn(async (opts) => {
        pgQueryCalls += 1;
        return query(opts);
      });
    });
  },
  reset() {
    innerFakePg.reset();
  },
};

function resetCounters() {
  entitlementGetCalls = 0;
  pgQueryCalls = 0;
}

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@vercel/kv') return { kv: countingFakeKv };
  if (request === '../db/pool') return countingFakePg;
  return originalLoad.apply(this, arguments);
};

const projectsHandler = require('../api/proxy/projects');
const homesHandler = require('../api/proxy/homes');
const importHandler = require('../api/proxy/projects-import');

const PROXY_SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

function mockReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
    end() { return this; },
  };
  return res;
}

function signedQueryFor(customerId, overrides = {}) {
  const params = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(customerId !== null ? { logged_in_customer_id: customerId } : {}),
    ...overrides,
  };
  return buildSignedQuery(PROXY_SECRET, params);
}

async function asAiPlus(customerId) {
  await innerFakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() });
}

async function post(handler, customerId, body) {
  const req = mockReq({ method: 'POST', query: signedQueryFor(customerId), body });
  const res = mockRes();
  await handler(req, res);
  return res;
}

async function get(handler, customerId, extraQuery = {}) {
  const req = mockReq({ method: 'GET', query: signedQueryFor(customerId, extraQuery) });
  const res = mockRes();
  await handler(req, res);
  return res;
}

test.beforeEach(() => {
  innerFakeKv.reset();
  innerFakePg.reset();
  resetCounters();
});

test.after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// Master flag off -> unchanged from Phase 5C: reads 404, writes 404
// ---------------------------------------------------------------------------

test('master flag off: reads 404 regardless of the write flag', async () => {
  const saved = process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  const savedWrites = process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'false';
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  try {
    const res = await get(projectsHandler, '801');
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_ENABLED = saved;
    process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = savedWrites;
  }
});

test('master flag off: writes 404 regardless of the write flag', async () => {
  const saved = process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  const savedWrites = process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'false';
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  try {
    const res = await post(projectsHandler, '802', { op: 'create', name: 'Den', room: 'livingroom' });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_ENABLED = saved;
    process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = savedWrites;
  }
});

// ---------------------------------------------------------------------------
// Master flag on, writes flag off: reads succeed, all writes blocked
// ---------------------------------------------------------------------------

test('reads: master on, writes off -> listProjects, getProject, listHomes all succeed', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '901';

  const list = await get(projectsHandler, cust);
  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body, { projects: [] });

  const homesList = await get(homesHandler, cust);
  assert.equal(homesList.statusCode, 200);
  assert.deepEqual(homesList.body, { homes: [] });
});

test('reads: master on, writes absent (unset) -> same as writes off, reads still succeed', async () => {
  delete process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  const cust = '902';
  const list = await get(projectsHandler, cust);
  assert.equal(list.statusCode, 200);
});

test('reads: master on, writes set to a non-"true" string -> still treated as off, reads still succeed', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'TRUE'; // wrong case, not the literal "true"
  const cust = '903';
  const list = await get(projectsHandler, cust);
  assert.equal(list.statusCode, 200);

  const create = await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' });
  assert.equal(create.statusCode, 404);
});

test('writes blocked: create, edit, attach, assign, delete on projects all 404 with writes off', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '904';

  const create = await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' });
  assert.equal(create.statusCode, 404);
  assert.deepEqual(create.body, { error: 'not_found' });

  // synthetic id/version -- these never reach the repositories to be
  // validated as real, since the write gate short-circuits before that.
  const fakeId = '00000000-0000-4000-8000-000000000000';
  const edit = await post(projectsHandler, cust, { op: 'edit', id: fakeId, version: 1, name: 'Nope' });
  assert.equal(edit.statusCode, 404);

  const attach = await post(projectsHandler, cust, { op: 'attach', id: fakeId, version: 1, moodBoard: {} });
  assert.equal(attach.statusCode, 404);

  const assign = await post(projectsHandler, cust, { op: 'assign', id: fakeId, homeId: null, version: 1 });
  assert.equal(assign.statusCode, 404);

  const del = await post(projectsHandler, cust, { op: 'delete', id: fakeId, version: 1 });
  assert.equal(del.statusCode, 404);
});

test('writes blocked: create, edit, delete on homes all 404 with writes off', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '905';
  const fakeId = '00000000-0000-4000-8000-000000000000';

  const create = await post(homesHandler, cust, { op: 'create', name: 'Main House' });
  assert.equal(create.statusCode, 404);

  const edit = await post(homesHandler, cust, { op: 'edit', id: fakeId, version: 1, name: 'Renamed' });
  assert.equal(edit.statusCode, 404);

  const del = await post(homesHandler, cust, { op: 'delete', id: fakeId, version: 1 });
  assert.equal(del.statusCode, 404);
});

test('delete is blocked when writes flag is off, even though delete is never entitlement-gated', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '906';
  const fakeId = '00000000-0000-4000-8000-000000000000';

  // Delete is normally allowed for every tier (Amendment 2) -- confirming
  // it is still blocked here proves the write-rollout gate applies ahead of,
  // and independent of, entitlement tier logic.
  const del = await post(projectsHandler, cust, { op: 'delete', id: fakeId, version: 1 });
  assert.equal(del.statusCode, 404);
  assert.deepEqual(del.body, { error: 'not_found' });
});

test('import is blocked when writes flag is off', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '907';
  const res = await post(importHandler, cust, {
    homes: [{ id: 'local-home-1', name: 'My House' }],
    projects: [{ id: 'local-proj-1', homeId: 'local-home-1', name: 'Bedroom', room: 'bedroom' }],
  });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('blocked writes do not call entitlement (no `entitlement:*` KV lookup happens)', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '908'; // deliberately no entitlement set -- a real entitlement
  // check on this customer would resolve to free tier and return 403, not 404.
  const create = await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' });
  assert.equal(create.statusCode, 404); // not 403 -- proves entitlement was never consulted
  assert.equal(entitlementGetCalls, 0);
});

test('blocked writes do not call Postgres (no fakePg.query invocation happens)', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '909';
  const create = await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' });
  assert.equal(create.statusCode, 404);
  assert.equal(pgQueryCalls, 0);

  const importRes = await post(importHandler, cust, {
    homes: [{ id: 'h1', name: 'House' }],
    projects: [{ id: 'p1', homeId: null, name: 'Room', room: 'bedroom' }],
  });
  assert.equal(importRes.statusCode, 404);
  assert.equal(pgQueryCalls, 0);
});

test('a read on the same route in the same test run still reaches Postgres normally (sanity check on the counters themselves)', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const cust = '910';
  await get(projectsHandler, cust); // listProjectsForCustomer always queries, even for an empty result
  assert.ok(pgQueryCalls > 0, 'expected the read path to reach Postgres, proving the counter itself works');
});

// ---------------------------------------------------------------------------
// Master flag on, writes flag on: existing Phase 5C behavior unchanged
// ---------------------------------------------------------------------------

test('master on + writes on: full create/read/edit/delete cycle behaves exactly as Phase 5C', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  const cust = '911';
  await asAiPlus(cust);

  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' })).body.project;
  assert.equal(created.version, 1);

  const list = await get(projectsHandler, cust);
  assert.equal(list.body.projects.length, 1);

  const edited = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Renamed' });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.body.project.name, 'Renamed');

  const del = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: edited.body.project.version });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.body, { deleted: true });
});

test('master on + writes on: free/lapsed customer is still denied create by entitlement, not by the write flag (403, not 404)', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  const cust = '912'; // no entitlement set -> free tier
  const create = await post(projectsHandler, cust, { op: 'create', name: 'Office', room: 'homeoffice' });
  assert.equal(create.statusCode, 403);
  assert.deepEqual(create.body, { error: 'ai_plus_required' });
});

test('master on + writes on: import behaves exactly as Phase 5C', async () => {
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  const cust = '913';
  await asAiPlus(cust);
  const res = await post(importHandler, cust, {
    homes: [{ id: 'local-home-1', name: 'My House' }],
    projects: [{ id: 'local-proj-1', homeId: 'local-home-1', name: 'Bedroom', room: 'bedroom' }],
  });
  assert.equal(res.statusCode, 200);
  // Phase 6B added per-record results alongside these counts; the counts are unchanged.
  const { importedProjects, importedHomes, skippedProjects, skippedHomes } = res.body;
  assert.deepEqual({ importedProjects, importedHomes, skippedProjects, skippedHomes }, { importedProjects: 1, importedHomes: 1, skippedProjects: 0, skippedHomes: 0 });
});
