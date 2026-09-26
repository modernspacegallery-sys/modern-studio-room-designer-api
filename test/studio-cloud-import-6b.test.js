// Phase 6B contract tests for POST /api/proxy/projects-import
// (approved design rev3 + corrections: plannedHomes validated with the real
// Home import rules; fixed server clock for date-equivalence tests).
//
// Runs the real route + repositories against test/fake-postgres.js (with the
// F7 fix: the unique constraint covers soft-deleted rows, as in Postgres).
// The deleted-Home cases are ALSO run against a real Postgres engine in
// test/integration/real-postgres-6b.test.js.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
process.env.RATE_LIMIT_PER_MINUTE = '100000';

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

const ROUTE = require.resolve('../api/proxy/projects-import');
let importHandler = require(ROUTE);
const projectsHandler = require('../api/proxy/projects');
const homesHandler = require('../api/proxy/homes');

// Fixed server clock: 2026-09-25T17:00:00Z.
const NOW = Date.UTC(2026, 8, 25, 17, 0, 0);
importHandler._setClockForTests(() => NOW);

const WRITE_QUERY = /insert|update|delete|clear|assign/i;

function q(customerId) {
  return buildSignedQuery(process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET, {
    shop: 'modernspacegallery.myshopify.com',
    path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)),
    logged_in_customer_id: customerId,
  });
}
function mockRes() {
  return { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() { return this; } };
}
async function call(handler, customerId, method, body) {
  const res = mockRes();
  await handler({ method, query: q(customerId), body, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
  return res;
}
const post = (c, body) => call(importHandler, c, 'POST', body);
const dry = (c, body) => post(c, Object.assign({ dryRun: true }, body));
async function asAiPlus(c) { await fakeKv.set(`entitlement:${c}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() }); }
let custSeq = 7000;
async function newCustomer() { const c = String(custSeq++); await asAiPlus(c); return c; }

function rowsFor(c) {
  const all = fakePg.allRows();
  return {
    homes: all.homes.filter((r) => r.customer_id === c),
    projects: all.projects.filter((r) => r.customer_id === c),
  };
}
function snapshotAll() { return JSON.stringify(fakePg.allRows()); }
function writesSince(mark) { return fakePg.queryLog.slice(mark).filter((n) => WRITE_QUERY.test(n)); }
function byId(list) { const m = {}; for (const r of list) m[r.legacyId] = r; return m; }

const H1 = { id: 'home_1787900000000_42', name: 'Lake House' };
const P = (id, homeId, extra) => Object.assign({ id, name: 'Room ' + id, room: 'bedroom' }, homeId === undefined ? {} : { homeId }, extra || {});

// Asserts a dry run wrote nothing: no write-shaped query and identical rows.
async function dryNoWrites(c, body) {
  const before = snapshotAll();
  const mark = fakePg.queryLog.length;
  const res = await dry(c, body);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(writesSince(mark), [], 'dry run issued a write query');
  assert.equal(snapshotAll(), before, 'dry run changed stored rows');
  return res;
}

// ---------------------------------------------------------------------------
// B-P: preview of Home links (no server memory, no writes)
// ---------------------------------------------------------------------------

test('B-P1 linked Project previews as movable before its Home exists; zero rows written', async () => {
  const c = await newCustomer();
  const res = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [P('proj_1787900100000_7', H1.id)] });
  const p = res.body.projects[0];
  assert.equal(p.status, 'would_import');
  assert.equal(p.homeLink, 'would_link_planned');
  assert.equal(res.body.plannedHomes[0].status, 'would_import');
  assert.equal(rowsFor(c).homes.length + rowsFor(c).projects.length, 0);
});

test('B-P2 cross-batch preview: Home previewed in batch 1, Project in batch 2 after a module reload (no server memory)', async () => {
  const c = await newCustomer();
  const homes = Array.from({ length: 200 }, (_, i) => ({ id: 'hh' + i, name: 'H' + i }));
  homes[0] = H1;
  const r1 = await dryNoWrites(c, { homes, projects: [] });
  assert.ok(r1.body.homes.every((h) => h.status === 'would_import'));
  // Fresh module instance: nothing from request 1 can be carried in memory.
  delete require.cache[ROUTE];
  importHandler = require(ROUTE);
  importHandler._setClockForTests(() => NOW);
  const r2 = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [P('proj_1787900100000_8', H1.id)] });
  assert.equal(r2.body.projects[0].status, 'would_import');
  assert.equal(r2.body.projects[0].homeLink, 'would_link_planned');
  assert.equal(rowsFor(c).homes.length + rowsFor(c).projects.length, 0);
});

test('B-P3 Home neither planned nor imported -> home_unavailable / not_found', async () => {
  const c = await newCustomer();
  const res = await dryNoWrites(c, { homes: [], projects: [P('p1', 'h-missing')] });
  assert.equal(res.body.projects[0].status, 'home_unavailable');
  assert.equal(res.body.projects[0].homeReason, 'not_found');
});

test('B-P4 planned Home with an invalid name -> Home invalid, Project home_unavailable / invalid', async () => {
  const c = await newCustomer();
  const res = await dryNoWrites(c, { plannedHomes: [{ id: 'h1', name: '   ' }], homes: [], projects: [P('p1', 'h1')] });
  assert.deepEqual(res.body.plannedHomes[0], { legacyId: 'h1', status: 'invalid', field: 'name' });
  assert.equal(res.body.projects[0].status, 'home_unavailable');
  assert.equal(res.body.projects[0].homeReason, 'invalid');
});

test('B-P5 Home already imported -> would_link_existing (no plannedHomes needed)', async () => {
  const c = await newCustomer();
  await post(c, { homes: [H1], projects: [] });
  const res = await dryNoWrites(c, { homes: [], projects: [P('p1', H1.id)] });
  assert.equal(res.body.projects[0].status, 'would_import');
  assert.equal(res.body.projects[0].homeLink, 'would_link_existing');
});

async function importThenDeleteHome(c, home) {
  await post(c, { homes: [home], projects: [] });
  const list = (await call(homesHandler, c, 'GET', {})).body.homes;
  const h = list.find((x) => x.clientLegacyId === home.id);
  const del = await call(homesHandler, c, 'POST', { op: 'delete', id: h.id, version: h.version });
  assert.equal(del.statusCode, 200);
}

test('B-P6 planned Home previously deleted -> previously_deleted; Project home_unavailable / deleted', async () => {
  const c = await newCustomer();
  await importThenDeleteHome(c, H1);
  const res = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [P('p1', H1.id)] });
  assert.equal(res.body.plannedHomes[0].status, 'previously_deleted');
  assert.equal(res.body.projects[0].status, 'home_unavailable');
  assert.equal(res.body.projects[0].homeReason, 'deleted');
});

test('B-P7 same Project with homeId:null -> would_import, homeLink none', async () => {
  const c = await newCustomer();
  await importThenDeleteHome(c, H1);
  const res = await dryNoWrites(c, { homes: [], projects: [P('p1', null)] });
  assert.equal(res.body.projects[0].status, 'would_import');
  assert.equal(res.body.projects[0].homeLink, 'none');
});

test('B-P8 real import refuses an unresolved non-null homeId (Home only planned, never imported): 0 rows', async () => {
  const c = await newCustomer();
  const res = await post(c, { homes: [], projects: [P('p1', H1.id)] });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.projects[0].status, 'home_unavailable');
  assert.equal(res.body.projects[0].homeReason, 'not_found');
  assert.equal(rowsFor(c).projects.length, 0);
});

test('B-P9 plannedHomes on a real import -> 400 and nothing inserted', async () => {
  const c = await newCustomer();
  const res = await post(c, { plannedHomes: [H1], homes: [H1], projects: [P('p1', H1.id)] });
  assert.equal(res.statusCode, 400);
  assert.equal(rowsFor(c).homes.length + rowsFor(c).projects.length, 0);
});

test('B-P10 real Home batch, then real Project batch -> linked to the Home server id', async () => {
  const c = await newCustomer();
  const r1 = await post(c, { homes: [H1], projects: [] });
  assert.equal(r1.body.homes[0].status, 'imported');
  const r2 = await post(c, { homes: [], projects: [P('p1', H1.id)] });
  assert.equal(r2.body.projects[0].status, 'imported');
  assert.equal(r2.body.projects[0].homeLink, 'linked');
  const row = rowsFor(c).projects[0];
  assert.equal(row.home_id, r1.body.homes[0].id);
});

test('B-P11 preview predicts the real import (fixed clock): statuses, links and dates agree', async () => {
  const c = await newCustomer();
  const proj = P('proj_1787900100000_7', H1.id, { createdAt: Date.UTC(2026, 7, 28), updatedAt: Date.UTC(2026, 8, 3) });
  const d = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [proj] });
  const i1 = await post(c, { homes: [H1], projects: [] });
  const i2 = await post(c, { homes: [], projects: [proj] });
  assert.equal(d.body.plannedHomes[0].status, 'would_import');
  assert.equal(i1.body.homes[0].status, 'imported');
  assert.equal(d.body.projects[0].status, 'would_import');
  assert.equal(i2.body.projects[0].status, 'imported');
  assert.equal(d.body.projects[0].homeLink, 'would_link_planned');
  assert.equal(i2.body.projects[0].homeLink, 'linked');
  assert.deepEqual(d.body.projects[0].dates, i2.body.projects[0].dates);
  assert.deepEqual(d.body.plannedHomes[0].dates, i1.body.homes[0].dates);
});

test('B-P12 structural limits: 201 plannedHomes, duplicate ids, or plannedHomes without dryRun -> 400, 0 rows', async () => {
  const c = await newCustomer();
  const many = Array.from({ length: 201 }, (_, i) => ({ id: 'h' + i, name: 'H' + i }));
  assert.equal((await dry(c, { plannedHomes: many, homes: [], projects: [] })).statusCode, 400);
  assert.equal((await dry(c, { plannedHomes: [H1, H1], homes: [], projects: [] })).statusCode, 400);
  assert.equal((await post(c, { dryRun: false, plannedHomes: [H1], homes: [], projects: [] })).statusCode, 400);
  assert.equal(rowsFor(c).homes.length + rowsFor(c).projects.length, 0);
});

test('B-P13 isolation: customer B cannot preview a link to customer A\'s Home', async () => {
  const a = await newCustomer();
  const b = await newCustomer();
  await post(a, { homes: [{ id: 'hx', name: 'A Home' }], projects: [] });
  const res = await dryNoWrites(b, { homes: [], projects: [P('p1', 'hx')] });
  assert.equal(res.body.projects[0].status, 'home_unavailable');
  assert.equal(res.body.projects[0].homeReason, 'not_found');
});

test('B-P14 race: previewed as would_link_planned, Home then imported+deleted elsewhere -> real Home batch reports previously_deleted', async () => {
  const c = await newCustomer();
  const d = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [P('p1', H1.id)] });
  assert.equal(d.body.projects[0].homeLink, 'would_link_planned');
  await importThenDeleteHome(c, H1);
  const i1 = await post(c, { homes: [H1], projects: [] });
  assert.equal(i1.body.homes[0].status, 'previously_deleted');
  const i2 = await post(c, { homes: [], projects: [P('p1', H1.id)] });
  assert.equal(i2.body.projects[0].status, 'home_unavailable');
  assert.equal(i2.body.projects[0].homeReason, 'deleted');
  assert.equal(rowsFor(c).projects.length, 0);
  assert.equal(rowsFor(c).homes.length, 1, 'deleted Home is not re-created');
});

// ---------------------------------------------------------------------------
// Correction 1: plannedHomes use exactly the real Home import rules
// ---------------------------------------------------------------------------

const HOME_CASES = [
  ['valid', { id: 'hv', name: 'Lake House' }],
  ['name padded (trimmed on import)', { id: 'hp', name: '  Lake House  ' }],
  ['blank name', { id: 'hb', name: '   ' }],
  ['missing name', { id: 'hm' }],
  ['non-string name', { id: 'hn', name: 42 }],
  ['name 200 chars', { id: 'h200', name: 'x'.repeat(200) }],
  ['name 201 chars', { id: 'h201', name: 'x'.repeat(201) }],
  ['id 200 chars', { id: 'i'.repeat(200), name: 'Ok' }],
  ['id 201 chars', { id: 'j'.repeat(201), name: 'Ok' }],
  ['blank id', { id: '  ', name: 'Ok' }],
  ['numeric id', { id: 12345, name: 'Ok' }],
  ['bad datePreference', { id: 'hd', name: 'Ok', datePreference: 'yesterday' }],
];

test('B-V1 every plannedHomes case gets the same verdict as a real Home import (would_import <-> imported)', async () => {
  for (const [label, home] of HOME_CASES) {
    const c = await newCustomer();
    const d = await dryNoWrites(c, { plannedHomes: [home], homes: [], projects: [] });
    const real = await post(c, { homes: [home], projects: [] });
    const dv = d.body.plannedHomes[0];
    const rv = real.body.homes[0];
    const expected = dv.status === 'would_import' ? 'imported' : dv.status;
    assert.equal(rv.status, expected, `${label}: preview ${dv.status} vs import ${rv.status}`);
    assert.equal(rv.field, dv.field, `${label}: field differs`);
  }
});

test('B-V2 a plannedHome and a `homes` entry for the same input get the same preview verdict', async () => {
  for (const [label, home] of HOME_CASES) {
    const c = await newCustomer();
    const d = await dryNoWrites(c, { plannedHomes: [home], homes: [home], projects: [] });
    assert.deepEqual(d.body.plannedHomes[0], d.body.homes[0], label);
  }
});

test('B-V3 a padded planned name previews as movable and is stored trimmed by the import', async () => {
  const c = await newCustomer();
  const home = { id: 'hp', name: '  Lake House  ' };
  const d = await dryNoWrites(c, { plannedHomes: [home], homes: [], projects: [P('p1', 'hp')] });
  assert.equal(d.body.projects[0].homeLink, 'would_link_planned');
  await post(c, { homes: [home], projects: [] });
  assert.equal(rowsFor(c).homes[0].name, 'Lake House');
});

// ---------------------------------------------------------------------------
// B-H: Homes during the real import
// ---------------------------------------------------------------------------

test('B-H1 cross-batch real import: Projects-only batch links to a Home from an earlier batch', async () => {
  const c = await newCustomer();
  await post(c, { homes: [H1], projects: [P('p1', H1.id)] });
  const r2 = await post(c, { homes: [], projects: [P('p2', H1.id)] });
  assert.equal(r2.body.projects[0].homeLink, 'linked');
  const rows = rowsFor(c);
  assert.ok(rows.projects.every((p) => p.home_id === rows.homes[0].id));
});

test('B-H2 Homes-only batch, interrupted, then Projects-only batch: all linked, no duplicate Homes', async () => {
  const c = await newCustomer();
  await post(c, { homes: [{ id: 'h1', name: 'A' }, { id: 'h2', name: 'B' }], projects: [] });
  const r = await post(c, { homes: [], projects: [P('p1', 'h1'), P('p2', 'h2')] });
  assert.deepEqual(r.body.projects.map((x) => x.homeLink), ['linked', 'linked']);
  assert.equal(rowsFor(c).homes.length, 2);
});

test('B-H3 unexpected error on the 3rd Home -> 500, Homes 1-2 kept, NO Project; retry completes and links', async () => {
  const c = await newCustomer();
  const homes = [1, 2, 3, 4, 5].map((i) => ({ id: 'h' + i, name: 'H' + i }));
  const projects = [P('p1', 'h1'), P('p3', 'h3'), P('p5', 'h5')];
  fakePg.injectFault('homes_import_insert', 2);
  const r = await post(c, { homes, projects });
  assert.equal(r.statusCode, 500);
  assert.equal(rowsFor(c).homes.length, 2);
  assert.equal(rowsFor(c).projects.length, 0);
  const retry = await post(c, { homes, projects });
  assert.equal(retry.statusCode, 200);
  assert.deepEqual(retry.body.homes.map((h) => h.status), ['already_imported', 'already_imported', 'imported', 'imported', 'imported']);
  assert.deepEqual(retry.body.projects.map((p) => p.homeLink), ['linked', 'linked', 'linked']);
});

test('B-H4 unexpected error on a Project -> 500 (retry-safe), earlier Projects kept, no duplicates on retry', async () => {
  const c = await newCustomer();
  const projects = [P('p1', null), P('p2', null), P('p3', null)];
  fakePg.injectFault('projects_import_insert', 1);
  const r = await post(c, { homes: [], projects });
  assert.equal(r.statusCode, 500);
  assert.equal(rowsFor(c).projects.length, 1);
  const retry = await post(c, { homes: [], projects });
  assert.deepEqual(retry.body.projects.map((p) => p.status), ['already_imported', 'imported', 'imported']);
  assert.equal(rowsFor(c).projects.length, 3);
});

test('B-H5 Home imported then deleted: resent Home is previously_deleted (no new row); Project home_unavailable / deleted', async () => {
  const c = await newCustomer();
  await importThenDeleteHome(c, H1);
  const r = await post(c, { homes: [H1], projects: [P('p1', H1.id)] });
  assert.equal(r.body.homes[0].status, 'previously_deleted');
  assert.equal(r.body.projects[0].status, 'home_unavailable');
  assert.equal(r.body.projects[0].homeReason, 'deleted');
  assert.equal(rowsFor(c).homes.length, 1);
  assert.equal(rowsFor(c).projects.length, 0);
});

test('B-H6 homeId:null imports ungrouped', async () => {
  const c = await newCustomer();
  const r = await post(c, { homes: [], projects: [P('p1', null)] });
  assert.equal(r.body.projects[0].homeLink, 'none');
  assert.equal(rowsFor(c).projects[0].home_id, null);
});

test('B-H7 isolation on real import: customer B cannot link to customer A\'s Home', async () => {
  const a = await newCustomer();
  const b = await newCustomer();
  await post(a, { homes: [{ id: 'hx', name: 'A' }], projects: [] });
  const r = await post(b, { homes: [], projects: [P('p1', 'hx')] });
  assert.equal(r.body.projects[0].status, 'home_unavailable');
  assert.equal(rowsFor(b).projects.length, 0);
});

test('B-H8 already-imported Project without a Home is never changed by a retry that includes its Home', async () => {
  const c = await newCustomer();
  await post(c, { homes: [], projects: [P('p1', null)] });
  const before = rowsFor(c).projects[0];
  const r = await post(c, { homes: [H1], projects: [P('p1', H1.id)] });
  assert.equal(r.body.projects[0].status, 'already_imported');
  const after = rowsFor(c).projects[0];
  assert.equal(after.home_id, null);
  assert.equal(after.version, before.version);
});

test('B-H9 invalid Home in the same request -> Home invalid; its Project home_unavailable / invalid, not inserted', async () => {
  const c = await newCustomer();
  const r = await post(c, { homes: [{ id: 'hb', name: '' }], projects: [P('p1', 'hb')] });
  assert.equal(r.body.homes[0].status, 'invalid');
  assert.equal(r.body.projects[0].status, 'home_unavailable');
  assert.equal(r.body.projects[0].homeReason, 'invalid');
  assert.equal(rowsFor(c).homes.length + rowsFor(c).projects.length, 0);
});

// ---------------------------------------------------------------------------
// B-D: deleted vs invalid vs already imported
// ---------------------------------------------------------------------------

test('B-D1..D3 statuses are distinct and counts match', async () => {
  const c = await newCustomer();
  await post(c, { homes: [], projects: [P('pd', null), P('pa', null)] });
  const pd = rowsFor(c).projects.find((r) => r.client_legacy_id === 'pd');
  await call(projectsHandler, c, 'POST', { op: 'delete', id: pd.id, version: pd.version });
  const body = { homes: [], projects: [P('pd', null), P('pa', null), P('pn', null), { id: 'pi', homeId: null, name: 'Bad', room: 'nope' }] };
  const d = await dryNoWrites(c, body);
  const r = await post(c, body);
  const ds = byId(d.body.projects);
  const rs = byId(r.body.projects);
  assert.equal(ds.pd.status, 'previously_deleted');
  assert.equal(ds.pa.status, 'already_imported');
  assert.equal(ds.pn.status, 'would_import');
  assert.equal(ds.pi.status, 'invalid');
  assert.equal(ds.pi.field, 'room');
  assert.equal(rs.pd.status, 'previously_deleted');
  assert.equal(rs.pa.status, 'already_imported');
  assert.equal(rs.pn.status, 'imported');
  assert.equal(rs.pi.status, 'invalid');
  assert.equal(r.body.importedProjects, 1);
  assert.equal(r.body.skippedProjects, 3);
  assert.equal(rowsFor(c).projects.filter((x) => !x.deleted_at).length, 2, 'deleted Project not resurrected');
});

test('B-D4 writes flag OFF -> dry run 404 with zero database calls', async () => {
  const c = await newCustomer();
  process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'false';
  const mark = fakePg.queryLog.length;
  try {
    const r = await dry(c, { plannedHomes: [H1], homes: [], projects: [] });
    assert.equal(r.statusCode, 404);
    assert.deepEqual(r.body, { error: 'not_found' });
    assert.equal(fakePg.queryLog.length, mark);
  } finally {
    process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
  }
});

// ---------------------------------------------------------------------------
// B-T: dates (fixed clock NOW = 2026-09-25T17:00:00Z)
// ---------------------------------------------------------------------------

const D = (y, m, d, h = 0, mi = 0, s = 0, ms = 0) => Date.UTC(y, m - 1, d, h, mi, s, ms);
const ID_0828 = 'proj_1787900000000_12'; // 2026-08-28T06:53:20Z

async function importOne(c, project) {
  const r = await post(c, { homes: [], projects: [project] });
  assert.equal(r.body.projects[0].status, 'imported', JSON.stringify(r.body.projects[0]));
  const row = rowsFor(c).projects.find((x) => x.client_legacy_id === project.id);
  return { res: r.body.projects[0], row };
}

const DATE_CASES = [
  ['B-T1 Band A kept', P('t1', null, { createdAt: D(2026, 8, 28, 6, 53, 20), updatedAt: D(2026, 9, 3) }),
    { c: [D(2026, 8, 28, 6, 53, 20), 'record', undefined], u: [D(2026, 9, 3), 'record', undefined] }],
  ['B-T2 exactly 2026-08-01 kept, no note', P('t2', null, { createdAt: D(2026, 8, 1), updatedAt: D(2026, 8, 1) }),
    { c: [D(2026, 8, 1), 'record', undefined] }],
  ['B-T3 2024-03-03 KEPT with note', P('t3', null, { createdAt: D(2024, 3, 3), updatedAt: D(2024, 3, 3) }),
    { c: [D(2024, 3, 3), 'record', 'earlier_than_expected'] }],
  ['B-T4 exactly 2008-01-01 kept with note', P('t4', null, { createdAt: D(2008, 1, 1), updatedAt: D(2008, 1, 1) }),
    { c: [D(2008, 1, 1), 'record', 'earlier_than_expected'] }],
  ['B-T5 2007-12-31T23:59:59.999Z -> id timestamp', P(ID_0828, null, { createdAt: D(2007, 12, 31, 23, 59, 59, 999) }),
    { c: [1787900000000, 'id', undefined] }],
  ['B-T6 0 with id 0 -> import time', P('proj_0000000000000_1', null, { createdAt: 0 }),
    { c: [NOW, 'import', undefined] }],
  ['B-T7 future, id future -> import time', P('proj_1800000000000_1', null, { createdAt: NOW + 86400000 }),
    { c: [NOW, 'import', undefined], cReason: 'future' }],
  ['B-T8 string createdAt, valid id -> id', P(ID_0828.replace('_12', '_13'), null, { createdAt: '2026-08-28' }),
    { c: [1787900000000, 'id', undefined] }],
  ['B-T9 updatedAt < createdAt -> order fixed', P('t9', null, { createdAt: D(2026, 9, 1), updatedAt: D(2026, 8, 20) }),
    { u: [D(2026, 9, 1), 'created', undefined], uReason: 'order_fixed' }],
  ['B-T10 updatedAt missing -> latest saved date', P('t10', null, {
    createdAt: D(2026, 8, 28),
    moodBoard: { room: 'bedroom-collection', style: 'modern', colors: ['#1C1C1E'], inspiration: [], savedAt: D(2026, 9, 3) },
    spacePlan: { collection: 'bedroom-collection', roomLabel: 'Bedroom', length: 12, width: 10, bedSize: 'queen', ownedItems: [], savedAt: D(2026, 9, 5) },
  }), { u: [D(2026, 9, 5), 'saved_date', undefined] }],
];

test('B-T1..T10 date rules on the real import (fixed clock), stored values match the response', async () => {
  for (const [label, project, exp] of DATE_CASES) {
    const c = await newCustomer();
    const { res, row } = await importOne(c, project);
    if (exp.c) {
      assert.equal(res.dates.createdAt.value, exp.c[0], label + ' created value');
      assert.equal(res.dates.createdAt.source, exp.c[1], label + ' created source');
      assert.equal(res.dates.createdAt.note, exp.c[2], label + ' created note');
      assert.equal(new Date(row.created_at).getTime(), exp.c[0], label + ' stored created_at');
    }
    if (exp.cReason) assert.equal(res.dates.createdAt.reason, exp.cReason, label);
    if (exp.u) {
      assert.equal(res.dates.updatedAt.value, exp.u[0], label + ' updated value');
      assert.equal(res.dates.updatedAt.source, exp.u[1], label + ' updated source');
      assert.equal(new Date(row.updated_at).getTime(), exp.u[0], label + ' stored updated_at');
    }
    if (exp.uReason) assert.equal(res.dates.updatedAt.reason, exp.uReason, label);
  }
});

test('B-T11 board savedAt in the future (2036) -> replaced by resolved updatedAt; Project still imported', async () => {
  const c = await newCustomer();
  const board = { room: 'bedroom-collection', style: 'modern', colors: ['#1C1C1E'], inspiration: [], savedAt: D(2036, 1, 1) };
  const { res, row } = await importOne(c, P('t11', null, { createdAt: D(2026, 8, 28), updatedAt: D(2026, 9, 5), moodBoard: board }));
  assert.equal(res.dates.boardSavedAt.source, 'fallback');
  assert.equal(res.dates.boardSavedAt.reason, 'future');
  assert.equal(row.mood_board.savedAt, D(2026, 9, 5));
});

test('B-T11b unreadable board savedAt ("abc") never makes the Project invalid', async () => {
  const c = await newCustomer();
  const board = { room: 'bedroom-collection', style: 'modern', colors: ['#1C1C1E'], inspiration: [], savedAt: 'abc' };
  const { res, row } = await importOne(c, P('t11b', null, { createdAt: D(2026, 8, 28), updatedAt: D(2026, 9, 5), moodBoard: board }));
  assert.equal(res.dates.boardSavedAt.reason, 'unreadable');
  assert.equal(row.mood_board.savedAt, D(2026, 9, 5));
});

test('B-T12 Band B with datePreference import_time -> import time for both, source customer_choice', async () => {
  const c = await newCustomer();
  const { res, row } = await importOne(c, P('t12', null, { createdAt: D(2024, 3, 3), updatedAt: D(2024, 3, 3), datePreference: 'import_time' }));
  assert.equal(res.dates.createdAt.source, 'customer_choice');
  assert.equal(new Date(row.created_at).getTime(), NOW);
  assert.equal(new Date(row.updated_at).getTime(), NOW);
});

test('B-T13 fixed clock: every date case resolves identically in preview and real import (Homes and Projects)', async () => {
  for (const [label, project] of DATE_CASES) {
    const c = await newCustomer();
    const d = await dryNoWrites(c, { homes: [], projects: [project] });
    const r = await post(c, { homes: [], projects: [project] });
    assert.deepEqual(d.body.projects[0].dates, r.body.projects[0].dates, label);
  }
  const c = await newCustomer();
  const home = { id: 'home_1787900000000_5', name: 'H', createdAt: 'x', updatedAt: D(2024, 3, 3) };
  const d = await dryNoWrites(c, { plannedHomes: [home], homes: [], projects: [] });
  const r = await post(c, { homes: [home], projects: [] });
  assert.deepEqual(d.body.plannedHomes[0].dates, r.body.homes[0].dates);
  assert.equal(r.body.homes[0].dates.createdAt.source, 'id');
});

test('B-T14 without a fixed clock, an import-time fallback can differ between preview and import (documented, not promised)', async () => {
  const c = await newCustomer();
  const project = P('proj_0000000000000_2', null, { createdAt: 0 });
  importHandler._setClockForTests(() => NOW);
  const d = await dry(c, { homes: [], projects: [project] });
  importHandler._setClockForTests(() => NOW + 60000);
  const r = await post(c, { homes: [], projects: [project] });
  importHandler._setClockForTests(() => NOW);
  assert.equal(d.body.projects[0].dates.createdAt.source, 'import');
  assert.equal(r.body.projects[0].dates.createdAt.source, 'import');
  assert.notEqual(d.body.projects[0].dates.createdAt.value, r.body.projects[0].dates.createdAt.value);
});

// ---------------------------------------------------------------------------
// B-F7: fake database fidelity
// ---------------------------------------------------------------------------

test('B-F7 fake-postgres: the unique constraint covers soft-deleted Homes (as in real Postgres)', async () => {
  const c = await newCustomer();
  await importThenDeleteHome(c, { id: 'hf', name: 'F' });
  const r = await fakePg.query({ name: 'homes_import_insert', text: '', values: [c, 'hf', 'F again', null, null] });
  assert.deepEqual(r.rows, []);
  assert.equal(rowsFor(c).homes.length, 1);
});

test('response never echoes submitted field values in `field`, and never contains customerId', async () => {
  const c = await newCustomer();
  const r = await post(c, { homes: [{ id: 'h', name: 'SECRET-NAME'.repeat(30) }], projects: [] });
  const text = JSON.stringify(r.body);
  assert.ok(!text.includes('SECRET-NAME'));
  assert.ok(!/customer_?id/i.test(text));
});

// ---------------------------------------------------------------------------
// B-H: homeId is a REQUIRED property (a local Home id or explicit null)
// ---------------------------------------------------------------------------

test('B-H1 preview: omitted homeId -> that entry invalid (field homeId); the rest of the batch previews normally; zero writes', async () => {
  const c = await newCustomer();
  const omitted = { id: 'p-omit', name: 'No key', room: 'bedroom' };
  const res = await dryNoWrites(c, { plannedHomes: [H1], homes: [], projects: [P('p-null', null), omitted, P('p-link', H1.id)] });
  const r = byId(res.body.projects);
  assert.equal(r['p-omit'].status, 'invalid');
  assert.equal(r['p-omit'].field, 'homeId');
  assert.equal(r['p-null'].status, 'would_import');
  assert.equal(r['p-null'].homeLink, 'none');
  assert.equal(r['p-link'].status, 'would_import');
  assert.equal(r['p-link'].homeLink, 'would_link_planned');
  assert.equal(res.body.projects.length, 3);
});

test('B-H2 real import: omitted homeId -> invalid, nothing inserted for it; explicit null and linked entries still import', async () => {
  const c = await newCustomer();
  const omitted = { id: 'p-omit', name: 'No key', room: 'bedroom' };
  const res = await post(c, { homes: [H1], projects: [P('p-null', null), omitted, P('p-link', H1.id)] });
  assert.equal(res.statusCode, 200);
  const r = byId(res.body.projects);
  assert.equal(r['p-omit'].status, 'invalid');
  assert.equal(r['p-omit'].field, 'homeId');
  assert.equal(r['p-null'].status, 'imported');
  assert.equal(r['p-link'].status, 'imported');
  assert.equal(res.body.importedProjects, 2);
  assert.equal(res.body.skippedProjects, 1);
  const rows = rowsFor(c);
  assert.equal(rows.projects.length, 2);
  assert.ok(!rows.projects.some((p) => p.client_legacy_id === 'p-omit'), 'omitted-homeId entry must not be inserted');
  const home = rows.homes.find((h) => h.client_legacy_id === H1.id);
  assert.equal(rows.projects.find((p) => p.client_legacy_id === 'p-null').home_id, null);
  assert.equal(rows.projects.find((p) => p.client_legacy_id === 'p-link').home_id, home.id);
});

test('B-H3 omitted homeId is invalid even when the Project was imported before (validation runs first; no silent success)', async () => {
  const c = await newCustomer();
  await post(c, { homes: [], projects: [P('p1', null)] });
  const d = await dryNoWrites(c, { homes: [], projects: [{ id: 'p1', name: 'Room p1', room: 'bedroom' }] });
  assert.equal(d.body.projects[0].status, 'invalid');
  assert.equal(d.body.projects[0].field, 'homeId');
  const r = await post(c, { homes: [], projects: [{ id: 'p1', name: 'Room p1', room: 'bedroom' }] });
  assert.equal(r.body.projects[0].status, 'invalid');
  assert.equal(rowsFor(c).projects.length, 1, 'still exactly one row');
});

test('B-H4 homeId present but not a string or null (number, empty string) -> invalid homeId; explicit null is valid', async () => {
  const c = await newCustomer();
  const res = await dryNoWrites(c, { homes: [], projects: [
    { id: 'p-num', homeId: 7, name: 'A', room: 'bedroom' },
    { id: 'p-empty', homeId: '', name: 'B', room: 'bedroom' },
    { id: 'p-null', homeId: null, name: 'C', room: 'bedroom' },
  ] });
  const r = byId(res.body.projects);
  assert.equal(r['p-num'].status, 'invalid'); assert.equal(r['p-num'].field, 'homeId');
  assert.equal(r['p-empty'].status, 'invalid'); assert.equal(r['p-empty'].field, 'homeId');
  assert.equal(r['p-null'].status, 'would_import');
});
