// Phase 5C route-level test suite for the Projects/Homes cloud persistence
// API: api/proxy/projects.js, api/proxy/homes.js, api/proxy/projects-import.js.
//
// Same technique as test/account-status-proxy.test.js: Module._load
// substitution swaps in an in-memory fake KV and fake Postgres, and the
// actual, unmodified production route files run against them. `pg` itself
// is never touched -- the fake stands in for lib/db/pool.js, one level
// higher, so the repositories' real SQL-shaping code still runs.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
// Phase 5D.2B added a second, independent write-rollout flag (see
// lib/studio-cloud-flag.js). This suite predates it and exercises full
// Phase 5C read+write behavior, so it turns writes on here to keep that
// behavior asserted unchanged. The write-rollout flag's own on/off/absent
// semantics are covered separately in test/studio-cloud-write-rollout.test.js.
process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';

const Module = require('module');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFakeKv } = require('./fake-kv');
const { createFakePostgres } = require('./fake-postgres');
const { buildSignedQuery } = require('./sign-helper');

const fakeKv = createFakeKv();
const fakePg = createFakePostgres();

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@vercel/kv') return { kv: fakeKv };
  if (request === '../db/pool') return fakePg;
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
  await fakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() });
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
  fakeKv.reset();
  fakePg.reset();
});

test.after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

test('auth: a validly-signed AI+ request can create a Project', async () => {
  const cust = '111';
  await asAiPlus(cust);
  const res = await post(projectsHandler, cust, { op: 'create', name: 'Living Room', room: 'livingroom' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.project.name, 'Living Room');
});

test('auth: unsigned request (bad signature) is rejected 401, never authenticated', async () => {
  const req = mockReq({
    method: 'GET',
    query: {
      shop: 'modernspacegallery.myshopify.com',
      path_prefix: '/apps/modern-studio',
      timestamp: String(Math.floor(Date.now() / 1000)),
      logged_in_customer_id: '999',
      signature: '0'.repeat(64),
    },
  });
  const res = mockRes();
  await projectsHandler(req, res);
  assert.equal(res.statusCode, 401);
  assert.deepEqual(res.body, { error: 'not_authenticated' });
});

test('auth: stale timestamp is rejected 401', async () => {
  const cust = '111';
  const params = {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000) - 999),
    logged_in_customer_id: cust,
  };
  const req = mockReq({ query: buildSignedQuery(PROXY_SECRET, params) });
  const res = mockRes();
  await projectsHandler(req, res);
  assert.equal(res.statusCode, 401);
});

test('auth: logged-out (no logged_in_customer_id) but validly signed request is 401, never a free pass', async () => {
  const res = await get(projectsHandler, null);
  assert.equal(res.statusCode, 401);
});

// ---------------------------------------------------------------------------
// Isolation (Phase 5B Section E threat model)
// ---------------------------------------------------------------------------

test('isolation: customer A cannot read customer B\'s project (404, not 403)', async () => {
  const a = '201', b = '202';
  await asAiPlus(a); await asAiPlus(b);
  const created = await post(projectsHandler, a, { op: 'create', name: 'A Room', room: 'bedroom' });
  const projectId = created.body.project.id;

  const res = await get(projectsHandler, b, { id: projectId });
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: 'not_found' });
});

test('isolation: customer A cannot edit customer B\'s project (404, not 403)', async () => {
  const a = '203', b = '204';
  await asAiPlus(a); await asAiPlus(b);
  const created = await post(projectsHandler, a, { op: 'create', name: 'A Room', room: 'bedroom' });
  const { id, version } = created.body.project;

  const res = await post(projectsHandler, b, { op: 'edit', id, version, name: 'Hijacked' });
  assert.equal(res.statusCode, 404);
});

test('isolation: customer A cannot delete customer B\'s project (404, not 403)', async () => {
  const a = '205', b = '206';
  await asAiPlus(a);
  const created = await post(projectsHandler, a, { op: 'create', name: 'A Room', room: 'bedroom' });
  const { id } = created.body.project;

  const res = await post(projectsHandler, b, { op: 'delete', id });
  assert.equal(res.statusCode, 404);

  // and it still exists for A
  const still = await get(projectsHandler, a, { id });
  assert.equal(still.statusCode, 200);
});

test('isolation: customer A cannot assign customer B\'s project to A\'s own home', async () => {
  const a = '207', b = '208';
  await asAiPlus(a); await asAiPlus(b);
  const bProject = (await post(projectsHandler, b, { op: 'create', name: 'B Room', room: 'kitchen' })).body.project;
  const aHome = (await post(homesHandler, a, { op: 'create', name: 'A Home' })).body.home;

  const res = await post(projectsHandler, a, { op: 'assign', id: bProject.id, homeId: aHome.id, version: bProject.version });
  assert.equal(res.statusCode, 404);
});

test('isolation: assigning to a homeId owned by someone else 404s, never leaks existence', async () => {
  const a = '209', b = '210';
  await asAiPlus(a); await asAiPlus(b);
  const aProject = (await post(projectsHandler, a, { op: 'create', name: 'A Room', room: 'kitchen' })).body.project;
  const bHome = (await post(homesHandler, b, { op: 'create', name: 'B Home' })).body.home;

  const res = await post(projectsHandler, a, { op: 'assign', id: aProject.id, homeId: bHome.id, version: aProject.version });
  assert.equal(res.statusCode, 404);
});

test('isolation: wrong-owner homeId in GET also 404s', async () => {
  const a = '211', b = '212';
  await asAiPlus(a); await asAiPlus(b);
  const bHome = (await post(homesHandler, b, { op: 'create', name: 'B Home' })).body.home;
  const res = await get(homesHandler, a, { id: bHome.id });
  assert.equal(res.statusCode, 404);
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('projects: create, list, attach mood board + space plan, version increments', async () => {
  const cust = '301';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' })).body.project;
  assert.equal(created.version, 1);

  const list = await get(projectsHandler, cust);
  assert.equal(list.body.projects.length, 1);

  const attached = await post(projectsHandler, cust, {
    op: 'attach',
    id: created.id,
    version: created.version,
    moodBoard: { style: 'Coastal', colors: ['#AABBCC'] },
  });
  assert.equal(attached.statusCode, 200);
  assert.equal(attached.body.project.version, 2);
  assert.deepEqual(attached.body.project.moodBoard.colors, ['#AABBCC']);

  const attachedPlan = await post(projectsHandler, cust, {
    op: 'attach',
    id: created.id,
    version: attached.body.project.version,
    spacePlan: { roomWidthIn: 120, roomLengthIn: 96 },
  });
  assert.equal(attachedPlan.statusCode, 200);
  assert.equal(attachedPlan.body.project.spacePlan.roomWidthIn, 120);
});

test('projects: version conflict returns 409 with the current row, and does not apply the stale write', async () => {
  const cust = '302';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' })).body.project;

  const res = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version + 5, name: 'New Name' });
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.error, 'version_conflict');
  assert.equal(res.body.current.name, 'Den');
});

test('projects: soft delete then cannot be read, cannot be resurrected by retrying delete (404, not re-deleted)', async () => {
  const cust = '303';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'livingroom' })).body.project;

  const del = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: created.version });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.body, { deleted: true });

  const readBack = await get(projectsHandler, cust, { id: created.id });
  assert.equal(readBack.statusCode, 404);

  const retryDelete = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: created.version });
  assert.equal(retryDelete.statusCode, 404);
});

test('projects: invalid room is rejected 400 against the verified Room Designer room list', async () => {
  const cust = '304';
  await asAiPlus(cust);
  const res = await post(projectsHandler, cust, { op: 'create', name: 'Den', room: 'not-a-real-room' });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.field, 'room');
});

// ---------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------

test('homes: create, list, assign a project, remove (unassign), delete', async () => {
  const cust = '401';
  await asAiPlus(cust);
  const home = (await post(homesHandler, cust, { op: 'create', name: 'Main House' })).body.home;
  const project = (await post(projectsHandler, cust, { op: 'create', name: 'Kitchen', room: 'kitchen' })).body.project;

  const assigned = await post(projectsHandler, cust, { op: 'assign', id: project.id, homeId: home.id, version: project.version });
  assert.equal(assigned.statusCode, 200);
  assert.equal(assigned.body.project.homeId, home.id);

  const unassigned = await post(projectsHandler, cust, { op: 'assign', id: project.id, homeId: null, version: assigned.body.project.version });
  assert.equal(unassigned.statusCode, 200);
  assert.equal(unassigned.body.project.homeId, null);

  const list = await get(homesHandler, cust);
  assert.equal(list.body.homes.length, 1);

  const del = await post(homesHandler, cust, { op: 'delete', id: home.id, version: home.version });
  assert.equal(del.statusCode, 200);
});

test('homes: deleting a Home clears home_id on Projects that pointed to it, ownership consistency preserved', async () => {
  const cust = '402';
  await asAiPlus(cust);
  const home = (await post(homesHandler, cust, { op: 'create', name: 'Main House' })).body.home;
  const project = (await post(projectsHandler, cust, { op: 'create', name: 'Bath', room: 'bathroom' })).body.project;
  const assigned = (await post(projectsHandler, cust, { op: 'assign', id: project.id, homeId: home.id, version: project.version })).body.project;

  const del = await post(homesHandler, cust, { op: 'delete', id: home.id, version: home.version });
  assert.equal(del.statusCode, 200);

  const readBack = await get(projectsHandler, cust, { id: project.id });
  assert.equal(readBack.statusCode, 200);
  assert.equal(readBack.body.project.homeId, null);
  assert.equal(readBack.body.project.version, assigned.version + 1); // clearing the reference bumps version
});

// ---------------------------------------------------------------------------
// Entitlement (Phase 5C Amendment 2)
// ---------------------------------------------------------------------------

test('entitlement: AI+ write (create) succeeds', async () => {
  const cust = '501';
  await asAiPlus(cust);
  const res = await post(projectsHandler, cust, { op: 'create', name: 'Office', room: 'homeoffice' });
  assert.equal(res.statusCode, 200);
});

test('entitlement: free/lapsed customer cannot create, edit, or import', async () => {
  const cust = '502'; // no entitlement set -> getEntitlement falls through to free tier
  const create = await post(projectsHandler, cust, { op: 'create', name: 'Office', room: 'homeoffice' });
  assert.equal(create.statusCode, 403);
  assert.deepEqual(create.body, { error: 'ai_plus_required' });

  const importRes = await post(importHandler, cust, { homes: [], projects: [] });
  assert.equal(importRes.statusCode, 403);
});

test('entitlement: free/lapsed customer CAN still read their existing rows (created while on AI+)', async () => {
  const cust = '503';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Legacy Room', room: 'bedroom' })).body.project;

  // subscription lapses
  await fakeKv.set(`entitlement:${cust}`, { tier: 'free', periodAnchor: null });

  const res = await get(projectsHandler, cust, { id: created.id });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.project.id, created.id);

  const list = await get(projectsHandler, cust);
  assert.equal(list.statusCode, 200);
  assert.equal(list.body.projects.length, 1);
});

test('entitlement: free/lapsed customer CAN delete their own existing rows (Amendment 2 -- never require resubscription to delete)', async () => {
  const cust = '504';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Legacy Room', room: 'bedroom' })).body.project;
  await fakeKv.set(`entitlement:${cust}`, { tier: 'free', periodAnchor: null });

  const del = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: created.version });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.body, { deleted: true });
});

test('entitlement: resubscription immediately restores write capability against the same existing record', async () => {
  const cust = '505';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Room', room: 'bedroom' })).body.project;
  await fakeKv.set(`entitlement:${cust}`, { tier: 'free', periodAnchor: null });

  const deniedEdit = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Nope' });
  assert.equal(deniedEdit.statusCode, 403);

  await asAiPlus(cust); // resubscribes
  const allowedEdit = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Renamed' });
  assert.equal(allowedEdit.statusCode, 200);
  assert.equal(allowedEdit.body.project.name, 'Renamed');
});

test('entitlement: entitlement-service failure denies AI+-required writes (fails closed)', async () => {
  const cust = '506';
  // Simulate a Shopify Admin API outage: no SHOPIFY_ADMIN_ACCESS_TOKEN means
  // lib/entitlement.js's fetch path itself short-circuits to free tier --
  // the existing, unmodified fail-closed behavior this phase relies on.
  const savedToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  try {
    const res = await post(projectsHandler, cust, { op: 'create', name: 'Room', room: 'bedroom' });
    assert.equal(res.statusCode, 403);
  } finally {
    if (savedToken !== undefined) process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = savedToken;
  }
});

test('entitlement: entitlement-service failure does NOT block reads (reads never call it)', async () => {
  const cust = '507';
  await asAiPlus(cust);
  const created = (await post(projectsHandler, cust, { op: 'create', name: 'Room', room: 'bedroom' })).body.project;

  const savedToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  delete process.env.SHOPIFY_ADMIN_ACCESS_TOKEN;
  try {
    const res = await get(projectsHandler, cust, { id: created.id });
    assert.equal(res.statusCode, 200);
  } finally {
    if (savedToken !== undefined) process.env.SHOPIFY_ADMIN_ACCESS_TOKEN = savedToken;
  }
});

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

test('import: first import creates homes and projects, resolving homeId references', async () => {
  const cust = '601';
  await asAiPlus(cust);
  const res = await post(importHandler, cust, {
    homes: [{ id: 'local-home-1', name: 'My House' }],
    projects: [{ id: 'local-proj-1', homeId: 'local-home-1', name: 'Bedroom', room: 'bedroom' }],
  });
  assert.equal(res.statusCode, 200);
  // Phase 6B added per-record results alongside these counts; the counts are unchanged.
  const { importedProjects, importedHomes, skippedProjects, skippedHomes } = res.body;
  assert.deepEqual({ importedProjects, importedHomes, skippedProjects, skippedHomes }, { importedProjects: 1, importedHomes: 1, skippedProjects: 0, skippedHomes: 0 });

  const projects = (await get(projectsHandler, cust)).body.projects;
  assert.equal(projects.length, 1);
  assert.notEqual(projects[0].homeId, null);
});

test('import: retrying the identical import reports 0 imported, N skipped, no duplicates', async () => {
  const cust = '602';
  await asAiPlus(cust);
  const payload = {
    homes: [{ id: 'local-home-1', name: 'My House' }],
    projects: [{ id: 'local-proj-1', homeId: 'local-home-1', name: 'Bedroom', room: 'bedroom' }],
  };
  await post(importHandler, cust, payload);
  const second = await post(importHandler, cust, payload);
  // Phase 6B added per-record results alongside these counts; the counts are unchanged.
  const { importedProjects, importedHomes, skippedProjects, skippedHomes } = second.body;
  assert.deepEqual({ importedProjects, importedHomes, skippedProjects, skippedHomes }, { importedProjects: 0, importedHomes: 0, skippedProjects: 1, skippedHomes: 1 });
  assert.deepEqual(second.body.projects.map((r) => r.status), ['already_imported']);
  assert.deepEqual(second.body.homes.map((r) => r.status), ['already_imported']);

  const projects = (await get(projectsHandler, cust)).body.projects;
  assert.equal(projects.length, 1); // still just the one, no duplicate
});

test('import: one malformed entry among valid ones is skipped, valid ones still commit (partial success)', async () => {
  const cust = '603';
  await asAiPlus(cust);
  const res = await post(importHandler, cust, {
    homes: [],
    projects: [
      { id: 'good-1', homeId: null, name: 'Good Room', room: 'bedroom' },
      { id: 'bad-1', homeId: null, name: 'Bad Room', room: 'not-a-real-room' }, // invalid room
      { id: 'good-2', homeId: null, name: 'Good Room 2', room: 'kitchen' },
    ],
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.importedProjects, 2);
  assert.equal(res.body.skippedProjects, 1);
});

test('import: isolation -- importing as customer A never creates rows visible to customer B', async () => {
  const a = '604', b = '605';
  await asAiPlus(a); await asAiPlus(b);
  const imp = await post(importHandler, a, { homes: [], projects: [{ id: 'p1', homeId: null, name: 'Room', room: 'bedroom' }] });
  assert.equal(imp.body.importedProjects, 1, 'the import itself must succeed for this check to mean anything');
  const aList = await get(projectsHandler, a);
  assert.equal(aList.body.projects.length, 1);
  const bList = await get(projectsHandler, b);
  assert.equal(bList.body.projects.length, 0);
});

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

test('feature flag: off (explicitly) -> route behaves as not_found even for a valid request', async () => {
  const saved = process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'false';
  try {
    const res = await get(projectsHandler, '701');
    assert.equal(res.statusCode, 404);
    assert.deepEqual(res.body, { error: 'not_found' });
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_ENABLED = saved;
  }
});

test('feature flag: missing entirely -> defaults to OFF (fail closed)', async () => {
  const saved = process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  delete process.env.STUDIO_CLOUD_PROJECTS_ENABLED;
  try {
    const res = await get(projectsHandler, '702');
    assert.equal(res.statusCode, 404);
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_ENABLED = saved;
  }
});

test('feature flag: on -> route behaves normally', async () => {
  const res = await get(projectsHandler, '703');
  assert.equal(res.statusCode, 200); // authenticated, flag on, empty list
  assert.deepEqual(res.body, { projects: [] });
});
