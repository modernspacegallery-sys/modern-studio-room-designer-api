// Phase 6B (decision D21): run the import route against a REAL Postgres
// engine, so behavior that depends on the real UNIQUE (customer_id,
// client_legacy_id) constraint -- which also covers soft-deleted rows -- is
// OBSERVED rather than inferred from the SQL.
//
// Uses the real lib/db/pool.js and repositories; only KV (rate limit /
// entitlement cache) is faked. Requires POSTGRES_URL pointing at a
// disposable database (never production). Self-skips when it is not set.

process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET = 'test-proxy-client-secret-not-real';
process.env.STUDIO_CLOUD_PROJECTS_ENABLED = 'true';
process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED = 'true';
process.env.RATE_LIMIT_PER_MINUTE = '100000';

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.POSTGRES_URL) {
  test('real-postgres 6B import suite skipped (POSTGRES_URL not set)', (t) => t.skip());
} else {
  const Module = require('module');
  const { createFakeKv } = require('../fake-kv');
  const { buildSignedQuery } = require('../sign-helper');
  const fakeKv = createFakeKv();
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === '@vercel/kv') return { kv: fakeKv };
    return originalLoad.apply(this, arguments);
  };

  const { runMigrations } = require('../../migrations/run-migrations');
  const db = require('../../lib/db/pool');
  const importHandler = require('../../api/proxy/projects-import');
  const homesHandler = require('../../api/proxy/homes');

  const NOW = Date.UTC(2026, 8, 25, 17, 0, 0);
  importHandler._setClockForTests(() => NOW);

  const q = (c) => buildSignedQuery(process.env.SHOPIFY_STUDIO_PROXY_CLIENT_SECRET, {
    shop: 'modernspacegallery.myshopify.com', path_prefix: '/apps/modern-studio',
    timestamp: String(Math.floor(Date.now() / 1000)), logged_in_customer_id: c,
  });
  const mockRes = () => ({ statusCode: 200, body: undefined, status(x) { this.statusCode = x; return this; }, json(p) { this.body = p; return this; }, setHeader() {}, end() { return this; } });
  async function call(handler, c, method, body) {
    const res = mockRes();
    await handler({ method, query: q(c), body, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res;
  }
  const post = (c, body) => call(importHandler, c, 'POST', body);
  const dry = (c, body) => post(c, Object.assign({ dryRun: true }, body));

  async function counts(c) {
    const h = await db.query({ text: 'SELECT count(*)::int AS n FROM homes WHERE customer_id = $1', values: [c] });
    const p = await db.query({ text: 'SELECT count(*)::int AS n FROM projects WHERE customer_id = $1', values: [c] });
    return { homes: h.rows[0].n, projects: p.rows[0].n };
  }
  // Fingerprint of EVERY row in both tables (all customers, deleted rows
  // included, every column incl. version/updated_at/xmin). Any INSERT,
  // UPDATE or DELETE anywhere changes it.
  async function totalWritesCommitted() {
    const { rows } = await db.query({
      text: `SELECT md5(coalesce((SELECT string_agg(t::text || xmin::text, '|' ORDER BY id) FROM homes t), '') || '#' ||
                        coalesce((SELECT string_agg(t::text || xmin::text, '|' ORDER BY id) FROM projects t), '')) AS f`,
    });
    return rows[0].f;
  }

  let seq = 0;
  async function customer() {
    const c = String(960000 + (++seq));
    await fakeKv.set(`entitlement:${c}`, { tier: 'ai_plus', periodAnchor: new Date().toISOString() });
    return c;
  }
  async function importThenDeleteHome(c, home) {
    await post(c, { homes: [home], projects: [] });
    const h = (await call(homesHandler, c, 'GET', {})).body.homes.find((x) => x.clientLegacyId === home.id);
    const del = await call(homesHandler, c, 'POST', { op: 'delete', id: h.id, version: h.version });
    assert.equal(del.statusCode, 200);
  }

  const H1 = { id: 'home_1787900000000_42', name: 'Lake House' };
  const P = (id, homeId, extra) => Object.assign({ id, name: 'Room ' + id, room: 'bedroom', homeId }, extra || {});

  test.before(async () => {
    await runMigrations({ connectionString: process.env.POSTGRES_URL, logger: { log: () => {} } });
    await db.query({ text: 'TRUNCATE projects, homes RESTART IDENTITY' });
  });

  test('PG-1 (V6 observed) raw repo: re-importing a soft-deleted Home conflicts and inserts nothing', async () => {
    const c = await customer();
    await importThenDeleteHome(c, H1);
    const { createHomesRepo } = require('../../lib/repositories/homes-repo');
    const repo = createHomesRepo(db);
    const row = await repo.importHome(c, { name: 'Again' }, H1.id);
    assert.equal(row, null, 'real Postgres: ON CONFLICT DO NOTHING on the soft-deleted row');
    assert.equal(await repo.getHomeByClientLegacyId(c, H1.id), null, 'active lookup excludes the deleted row');
    assert.equal((await counts(c)).homes, 1);
  });

  test('PG-2 (B-P6) preview with a previously deleted planned Home: previously_deleted + home_unavailable/deleted, no writes', async () => {
    const c = await customer();
    await importThenDeleteHome(c, H1);
    const before = await counts(c);
    const w0 = await totalWritesCommitted();
    const r = await dry(c, { plannedHomes: [H1], homes: [], projects: [P('p1', H1.id)] });
    assert.equal(r.statusCode, 200);
    assert.equal(r.body.plannedHomes[0].status, 'previously_deleted');
    assert.equal(r.body.projects[0].status, 'home_unavailable');
    assert.equal(r.body.projects[0].homeReason, 'deleted');
    assert.deepEqual(await counts(c), before);
    assert.equal(await totalWritesCommitted(), w0);
  });

  test('PG-3 (B-P1) linked Project previews before its Home exists; zero rows, zero write counters', async () => {
    const c = await customer();
    const w0 = await totalWritesCommitted();
    const r = await dry(c, { plannedHomes: [H1], homes: [], projects: [P('p1', H1.id)] });
    assert.equal(r.body.projects[0].homeLink, 'would_link_planned');
    assert.deepEqual(await counts(c), { homes: 0, projects: 0 });
    assert.equal(await totalWritesCommitted(), w0);
  });

  test('PG-4 (B-P8) real import refuses an unresolved non-null homeId', async () => {
    const c = await customer();
    const r = await post(c, { homes: [], projects: [P('p1', H1.id)] });
    assert.equal(r.body.projects[0].status, 'home_unavailable');
    assert.equal((await counts(c)).projects, 0);
  });

  test('PG-5 (B-P10 / B-H1) Home batch then Projects-only batch: linked by the real scoped lookup', async () => {
    const c = await customer();
    const r1 = await post(c, { homes: [H1], projects: [] });
    const r2 = await post(c, { homes: [], projects: [P('p1', H1.id), P('p2', H1.id)] });
    assert.deepEqual(r2.body.projects.map((x) => x.homeLink), ['linked', 'linked']);
    const { rows } = await db.query({ text: 'SELECT home_id FROM projects WHERE customer_id = $1', values: [c] });
    assert.ok(rows.every((x) => x.home_id === r1.body.homes[0].id));
  });

  test('PG-6 (B-H5) deleted Home resent with its Project: previously_deleted, not re-created; Project not inserted', async () => {
    const c = await customer();
    await importThenDeleteHome(c, H1);
    const r = await post(c, { homes: [H1], projects: [P('p1', H1.id)] });
    assert.equal(r.body.homes[0].status, 'previously_deleted');
    assert.equal(r.body.projects[0].status, 'home_unavailable');
    assert.deepEqual(await counts(c), { homes: 1, projects: 0 });
  });

  test('PG-7 imported then deleted Project: previously_deleted in preview and import, not resurrected', async () => {
    const c = await customer();
    await post(c, { homes: [], projects: [P('p1', null)] });
    await db.query({ text: `UPDATE projects SET deleted_at = now(), version = version + 1 WHERE customer_id = $1`, values: [c] });
    const d = await dry(c, { homes: [], projects: [P('p1', null)] });
    const r = await post(c, { homes: [], projects: [P('p1', null)] });
    assert.equal(d.body.projects[0].status, 'previously_deleted');
    assert.equal(r.body.projects[0].status, 'previously_deleted');
    const { rows } = await db.query({ text: 'SELECT count(*)::int AS n FROM projects WHERE customer_id = $1 AND deleted_at IS NULL', values: [c] });
    assert.equal(rows[0].n, 0);
  });

  test('PG-8 dates: Band B date and id-recovered date are stored exactly (timestamptz, ms precision)', async () => {
    const c = await customer();
    const r = await post(c, { homes: [], projects: [
      P('pb', null, { createdAt: Date.UTC(2024, 2, 3), updatedAt: Date.UTC(2024, 2, 4) }),
      P('proj_1787900000000_12', null, { createdAt: 'x' }),
    ] });
    assert.deepEqual(r.body.projects.map((x) => x.status), ['imported', 'imported']);
    const { rows } = await db.query({ text: `SELECT client_legacy_id, created_at, updated_at FROM projects WHERE customer_id = $1 ORDER BY client_legacy_id`, values: [c] });
    const byId = Object.fromEntries(rows.map((x) => [x.client_legacy_id, x]));
    assert.equal(byId.pb.created_at.getTime(), Date.UTC(2024, 2, 3));
    assert.equal(byId.pb.updated_at.getTime(), Date.UTC(2024, 2, 4));
    assert.equal(byId.proj_1787900000000_12.created_at.getTime(), 1787900000000);
  });

  test('PG-9 isolation with the real ANY($2::text[]) lookup: another customer\'s Home never resolves', async () => {
    const a = await customer();
    const b = await customer();
    await post(a, { homes: [{ id: 'hx', name: 'A' }], projects: [] });
    const d = await dry(b, { homes: [], projects: [P('p1', 'hx')] });
    const r = await post(b, { homes: [], projects: [P('p1', 'hx')] });
    assert.equal(d.body.projects[0].homeReason, 'not_found');
    assert.equal(r.body.projects[0].homeReason, 'not_found');
    assert.equal((await counts(b)).projects, 0);
  });

  test('PG-10 concurrent identical Home imports: exactly one row, both report a success status', async () => {
    const c = await customer();
    const [a, b] = await Promise.all([post(c, { homes: [H1], projects: [] }), post(c, { homes: [H1], projects: [] })]);
    const statuses = [a.body.homes[0].status, b.body.homes[0].status].sort();
    assert.ok(statuses.every((s) => s === 'imported' || s === 'already_imported'), statuses.join(','));
    assert.ok(statuses.includes('imported'));
    assert.equal((await counts(c)).homes, 1);
  });

  test.after(async () => {
    await db.getPool().end();
  });
}
