// Phase 6A-1: contract tests for the existing optimistic-concurrency
// (409 version_conflict) behavior of api/proxy/projects.js and
// api/proxy/homes.js.
//
// TESTS ONLY. Nothing under api/ or lib/ is changed by this file. These tests
// pin down the response shapes and "a conflicting write changes nothing"
// guarantees that the Phase 6A theme-side conflict recovery will rely on:
//
//   - every conflicting mutation answers 409 with exactly
//     { error: 'version_conflict', current: <serialized record> }
//   - a conflicting mutation writes nothing (record and version unchanged)
//   - a successful Home delete bumps the version of every member Project,
//     which is why an open Mood Board / Space Planner / My Projects page can
//     later receive a 409 without the customer editing that Project anywhere
//   - another customer's record answers 404, never 409 (no existence leak)
//   - with the write-rollout flag off, a stale-version write answers 404,
//     never 409, and still writes nothing
//
// Same harness as test/studio-cloud-projects.test.js: Module._load swaps in
// the in-memory fake KV and fake Postgres, and the real, unmodified route
// files run against them. Payloads use the exact shapes the dev theme sends
// (studio-mood-board.js / studio-space-planner.js), not synthetic ones.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
// Several scenarios need more than the default 10 requests/minute from the
// single mock IP. Same test-only precedent as
// test/redesign-quality-intelligence.test.js; node --test runs each test file
// in its own process, so this does not affect any other suite. Must be set
// before lib/rate-limit.js is first required (it reads the value at load).
process.env.RATE_LIMIT_PER_MINUTE = '1000';

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

const PROXY_SECRET = process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET;

// The exact key set lib/studio-cloud-serialize.js emits. If the serializer
// gains or loses a field, B11 fails on purpose so the theme adapter's
// normalizeProject()/normalizeHome() are reviewed alongside it.
const PROJECT_KEYS = ['clientLegacyId', 'createdAt', 'customerId', 'homeId', 'id', 'moodBoard', 'name', 'room',
  'roomId', 'roomLabel', 'schemaVersion', 'spacePlan', 'updatedAt', 'version'];
const HOME_KEYS = ['clientLegacyId', 'createdAt', 'customerId', 'id', 'name', 'schemaVersion', 'updatedAt', 'version'];

// Shapes copied from what the dev theme actually sends.
const MOOD_BOARD_A = { room: 'living-room-collection', style: 'japandi', colors: ['#EDE6DA', '#A9906F'], inspiration: [], savedAt: 1790000000000 };
const MOOD_BOARD_B = { room: 'living-room-collection', style: 'modern', colors: ['#1C1C1E', '#F5F3EF'], inspiration: [], savedAt: 1790000500000 };
const SPACE_PLAN_A = { collection: 'bedroom-collection', roomLabel: 'Bedroom', length: 12, width: 11, bedSize: 'queen',
  ownedItems: [{ name: 'Dresser', w: 60, d: 18 }], savedAt: 1790000000000 };
const SPACE_PLAN_B = { collection: 'bedroom-collection', roomLabel: 'Bedroom', length: 14, width: 12, bedSize: 'king', ownedItems: [], savedAt: 1790000500000 };

function mockReq({ method = 'GET', query = {}, body = {}, headers = {} } = {}) {
  return { method, query, body, headers, socket: { remoteAddress: '127.0.0.1' } };
}

function mockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
    setHeader() {},
    end() { return this; },
  };
}

function signedQueryFor(customerId, overrides = {}) {
  return buildSignedQuery(PROXY_SECRET, {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: customerId,
    ...overrides,
  });
}

async function asAiPlus(customerId) {
  await fakeKv.set(`entitlement:${customerId}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() });
}

async function post(handler, customerId, body) {
  const res = mockRes();
  await handler(mockReq({ method: 'POST', query: signedQueryFor(customerId), body }), res);
  return res;
}

async function get(handler, customerId, extraQuery = {}) {
  const res = mockRes();
  await handler(mockReq({ method: 'GET', query: signedQueryFor(customerId, extraQuery) }), res);
  return res;
}

async function readProject(customerId, id) {
  const res = await get(projectsHandler, customerId, { id });
  assert.equal(res.statusCode, 200, 'read-back of project should succeed');
  return res.body.project;
}

async function readHome(customerId, id) {
  const res = await get(homesHandler, customerId, { id });
  assert.equal(res.statusCode, 200, 'read-back of home should succeed');
  return res.body.home;
}

async function createProject(customerId, extra = {}) {
  const res = await post(projectsHandler, customerId, { op: 'create', name: 'Living Room Refresh', room: 'livingroom', roomLabel: 'Living Room', ...extra });
  assert.equal(res.statusCode, 200);
  return res.body.project;
}

async function createHome(customerId, name = 'Main House') {
  const res = await post(homesHandler, customerId, { op: 'create', name });
  assert.equal(res.statusCode, 200);
  return res.body.home;
}

// Asserts the exact 409 envelope: only `error` and `current`, nothing else.
function assertConflictEnvelope(res, keys) {
  assert.equal(res.statusCode, 409);
  assert.deepEqual(Object.keys(res.body).sort(), ['current', 'error']);
  assert.equal(res.body.error, 'version_conflict');
  assert.deepEqual(Object.keys(res.body.current).sort(), keys);
}

test.beforeEach(() => {
  fakeKv.reset();
  fakePg.reset();
});

test.after(() => {
  Module._load = originalLoad;
});

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

test('B1 attach moodBoard with a stale version: 409 with the current record; nothing written', async () => {
  const cust = '6101';
  await asAiPlus(cust);
  const created = await createProject(cust);
  const first = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_A });
  assert.equal(first.statusCode, 200);
  const before = await readProject(cust, created.id);

  // Same version the page loaded with (now stale) -- what a second tab sends.
  const res = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_B });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.id, created.id);
  assert.equal(res.body.current.version, before.version);
  assert.deepEqual(res.body.current.moodBoard, MOOD_BOARD_A);
  assert.deepEqual(await readProject(cust, created.id), before);
});

test('B2 attach spacePlan with a stale version: 409 with the current record; nothing written', async () => {
  const cust = '6102';
  await asAiPlus(cust);
  const created = await createProject(cust, { room: 'bedroom', roomLabel: 'Bedroom' });
  const first = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, spacePlan: SPACE_PLAN_A });
  assert.equal(first.statusCode, 200);
  const before = await readProject(cust, created.id);

  const res = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, spacePlan: SPACE_PLAN_B });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.version, before.version);
  assert.deepEqual(res.body.current.spacePlan, before.spacePlan);
  assert.equal(res.body.current.spacePlan.savedAt, SPACE_PLAN_A.savedAt, 'savedAt is stored exactly as sent');
  assert.deepEqual(await readProject(cust, created.id), before);
});

test('B3 assign with a stale version: 409; homeId and version unchanged', async () => {
  const cust = '6103';
  await asAiPlus(cust);
  const homeA = await createHome(cust, 'Main House');
  const homeB = await createHome(cust, 'Lake Cabin');
  const created = await createProject(cust);
  const assigned = await post(projectsHandler, cust, { op: 'assign', id: created.id, homeId: homeA.id, version: created.version });
  assert.equal(assigned.statusCode, 200);
  const before = await readProject(cust, created.id);

  const res = await post(projectsHandler, cust, { op: 'assign', id: created.id, homeId: homeB.id, version: created.version });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.homeId, homeA.id);
  assert.equal(res.body.current.version, before.version);
  assert.deepEqual(await readProject(cust, created.id), before);
});

test('B3b unassign (homeId null) with a stale version: 409; still assigned', async () => {
  const cust = '6113';
  await asAiPlus(cust);
  const home = await createHome(cust);
  const created = await createProject(cust);
  await post(projectsHandler, cust, { op: 'assign', id: created.id, homeId: home.id, version: created.version });
  const before = await readProject(cust, created.id);

  const res = await post(projectsHandler, cust, { op: 'assign', id: created.id, homeId: null, version: created.version });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.homeId, home.id);
  assert.deepEqual(await readProject(cust, created.id), before);
});

test('B4 project delete with a stale version: 409; project still readable and unchanged', async () => {
  const cust = '6104';
  await asAiPlus(cust);
  const created = await createProject(cust);
  await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_A });
  const before = await readProject(cust, created.id);

  const res = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: created.version });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.version, before.version);
  assert.deepEqual(await readProject(cust, created.id), before);
  const list = await get(projectsHandler, cust);
  assert.equal(list.body.projects.length, 1);
});

test('B4b project edit (rename) with a stale version: 409; name unchanged', async () => {
  const cust = '6114';
  await asAiPlus(cust);
  const created = await createProject(cust);
  const renamed = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Den' });
  assert.equal(renamed.statusCode, 200);
  const before = await readProject(cust, created.id);

  const res = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Family Room' });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.name, 'Den');
  assert.deepEqual(await readProject(cust, created.id), before);
});

// ---------------------------------------------------------------------------
// Homes
// ---------------------------------------------------------------------------

test('B5 home edit (rename) with a stale version: 409; name unchanged', async () => {
  const cust = '6105';
  await asAiPlus(cust);
  const home = await createHome(cust, 'Main House');
  const renamed = await post(homesHandler, cust, { op: 'edit', id: home.id, version: home.version, name: 'Our House' });
  assert.equal(renamed.statusCode, 200);
  const before = await readHome(cust, home.id);

  const res = await post(homesHandler, cust, { op: 'edit', id: home.id, version: home.version, name: 'Beach House' });

  assertConflictEnvelope(res, HOME_KEYS);
  assert.equal(res.body.current.name, 'Our House');
  assert.equal(res.body.current.version, before.version);
  assert.deepEqual(await readHome(cust, home.id), before);
});

test('B6 home delete with a stale version: 409; Home and member Projects untouched', async () => {
  const cust = '6106';
  await asAiPlus(cust);
  const home = await createHome(cust);
  await post(homesHandler, cust, { op: 'edit', id: home.id, version: home.version, name: 'Renamed Elsewhere' });
  const project = await createProject(cust);
  await post(projectsHandler, cust, { op: 'assign', id: project.id, homeId: home.id, version: project.version });
  const homeBefore = await readHome(cust, home.id);
  const projectBefore = await readProject(cust, project.id);

  const res = await post(homesHandler, cust, { op: 'delete', id: home.id, version: home.version });

  assertConflictEnvelope(res, HOME_KEYS);
  assert.equal(res.body.current.name, 'Renamed Elsewhere');
  assert.deepEqual(await readHome(cust, home.id), homeBefore);
  const projectAfter = await readProject(cust, project.id);
  assert.equal(projectAfter.homeId, home.id);
  assert.equal(projectAfter.version, projectBefore.version);
});

test('B7 successful home delete bumps every member Project version by exactly 1 and clears homeId; non-members untouched', async () => {
  const cust = '6107';
  await asAiPlus(cust);
  const home = await createHome(cust);
  const p1 = await createProject(cust, { name: 'Kitchen', room: 'kitchen', roomLabel: 'Kitchen' });
  const p2 = await createProject(cust, { name: 'Bath', room: 'bathroom', roomLabel: 'Bathroom' });
  const outsider = await createProject(cust, { name: 'Office', room: 'homeoffice', roomLabel: 'Home Office' });
  await post(projectsHandler, cust, { op: 'assign', id: p1.id, homeId: home.id, version: p1.version });
  await post(projectsHandler, cust, { op: 'assign', id: p2.id, homeId: home.id, version: p2.version });
  const p1Before = await readProject(cust, p1.id);
  const p2Before = await readProject(cust, p2.id);
  const outsiderBefore = await readProject(cust, outsider.id);

  const del = await post(homesHandler, cust, { op: 'delete', id: home.id, version: home.version });
  assert.equal(del.statusCode, 200);
  assert.deepEqual(del.body, { deleted: true });

  for (const [id, before] of [[p1.id, p1Before], [p2.id, p2Before]]) {
    const after = await readProject(cust, id);
    assert.equal(after.homeId, null);
    assert.equal(after.version, before.version + 1);
  }
  assert.deepEqual(await readProject(cust, outsider.id), outsiderBefore);
});

test('B8 a page holding a pre-Home-delete Project version gets 409 on attach, with homeId already cleared in current', async () => {
  const cust = '6108';
  await asAiPlus(cust);
  const home = await createHome(cust);
  const created = await createProject(cust);
  const assigned = (await post(projectsHandler, cust, { op: 'assign', id: created.id, homeId: home.id, version: created.version })).body.project;
  // The Mood Board page loaded `assigned` (version N). Meanwhile My Projects deletes the Home.
  await post(homesHandler, cust, { op: 'delete', id: home.id, version: home.version });

  const res = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: assigned.version, moodBoard: MOOD_BOARD_A });

  assertConflictEnvelope(res, PROJECT_KEYS);
  assert.equal(res.body.current.version, assigned.version + 1);
  assert.equal(res.body.current.homeId, null);
  assert.equal(res.body.current.moodBoard, null, 'the stale attach wrote nothing');

  // Retrying with current.version succeeds -- the one-retry path Phase 6A uses
  // when the field being written is unchanged.
  const retry = await post(projectsHandler, cust, { op: 'attach', id: created.id, version: res.body.current.version, moodBoard: MOOD_BOARD_A });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.body.project.moodBoard, MOOD_BOARD_A);
});

// ---------------------------------------------------------------------------
// Isolation and write-rollout gate
// ---------------------------------------------------------------------------

test('B9 another customer\'s record with a stale version answers 404, never 409, and leaks nothing', async () => {
  const owner = '6109';
  const other = '6119';
  await asAiPlus(owner);
  await asAiPlus(other);
  const created = await createProject(owner);
  await post(projectsHandler, owner, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_A });
  const home = await createHome(owner);
  await post(homesHandler, owner, { op: 'edit', id: home.id, version: home.version, name: 'Owner Renamed' });
  const projectBefore = await readProject(owner, created.id);
  const homeBefore = await readHome(owner, home.id);

  const attempts = [
    [projectsHandler, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_B }],
    [projectsHandler, { op: 'edit', id: created.id, version: created.version, name: 'Mine now' }],
    [projectsHandler, { op: 'assign', id: created.id, homeId: null, version: created.version }],
    [projectsHandler, { op: 'delete', id: created.id, version: created.version }],
    [homesHandler, { op: 'edit', id: home.id, version: home.version, name: 'Mine now' }],
    [homesHandler, { op: 'delete', id: home.id, version: home.version }],
  ];
  for (const [handler, body] of attempts) {
    const res = await post(handler, other, body);
    assert.equal(res.statusCode, 404, `${body.op} as another customer`);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
  assert.deepEqual(await readProject(owner, created.id), projectBefore);
  assert.deepEqual(await readHome(owner, home.id), homeBefore);
});

test('B10 with the write-rollout flag off, a stale-version write answers 404 (not 409) and writes nothing', async () => {
  const cust = '6110';
  await asAiPlus(cust);
  const created = await createProject(cust);
  await post(projectsHandler, cust, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_A });
  const home = await createHome(cust);
  const projectBefore = await readProject(cust, created.id);
  const homeBefore = await readHome(cust, home.id);

  const saved = process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED;
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  try {
    const attempts = [
      [projectsHandler, { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_B }],
      [projectsHandler, { op: 'assign', id: created.id, homeId: home.id, version: created.version }],
      [projectsHandler, { op: 'delete', id: created.id, version: created.version }],
      [homesHandler, { op: 'delete', id: home.id, version: home.version - 1 }],
    ];
    for (const [handler, body] of attempts) {
      const res = await post(handler, cust, body);
      assert.equal(res.statusCode, 404, `${body.op} with writes off`);
      assert.deepEqual(res.body, { error: 'not_found' });
    }
    // Reads stay available with writes off -- the theme's follow-up read
    // check after a write 404 depends on this.
    assert.deepEqual(await readProject(cust, created.id), projectBefore);
    assert.deepEqual(await readHome(cust, home.id), homeBefore);
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = saved;
  }
});

test('B11 409 `current` carries exactly the serializer\'s fields for Projects and Homes', async () => {
  const cust = '6111';
  await asAiPlus(cust);
  const created = await createProject(cust);
  await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'Den' });
  const home = await createHome(cust);
  await post(homesHandler, cust, { op: 'edit', id: home.id, version: home.version, name: 'Cabin' });

  const pRes = await post(projectsHandler, cust, { op: 'edit', id: created.id, version: created.version, name: 'X' });
  const hRes = await post(homesHandler, cust, { op: 'edit', id: home.id, version: home.version, name: 'Y' });

  assertConflictEnvelope(pRes, PROJECT_KEYS);
  assertConflictEnvelope(hRes, HOME_KEYS);
  // `current` is the same record a plain read returns.
  assert.deepEqual(pRes.body.current, await readProject(cust, created.id));
  assert.deepEqual(hRes.body.current, await readHome(cust, home.id));
});

test('B12 a deleted Project answers 404 (not 409) to any later write, even with its last version', async () => {
  const cust = '6112';
  await asAiPlus(cust);
  const created = await createProject(cust);
  const del = await post(projectsHandler, cust, { op: 'delete', id: created.id, version: created.version });
  assert.equal(del.statusCode, 200);

  for (const body of [
    { op: 'attach', id: created.id, version: created.version, moodBoard: MOOD_BOARD_A },
    { op: 'attach', id: created.id, version: created.version + 1, spacePlan: SPACE_PLAN_A },
    { op: 'assign', id: created.id, homeId: null, version: created.version + 1 },
    { op: 'delete', id: created.id, version: created.version + 1 },
  ]) {
    const res = await post(projectsHandler, cust, body);
    assert.equal(res.statusCode, 404, `${body.op} after delete`);
    assert.deepEqual(res.body, { error: 'not_found' });
  }
});
