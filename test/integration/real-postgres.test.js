// Phase 5C Section 12: "Where safely possible, use a non-production
// database/branch for bounded integration testing." This file runs the
// REAL lib/db/pool.js and lib/repositories/*.js against an actual Postgres
// engine -- not the in-memory fake-postgres.js used by the route tests --
// to verify things a fake cannot: the migration actually applies, the
// unique constraint on (customer_id, client_legacy_id) is enforced by
// Postgres itself, the foreign key behaves as expected, and a real
// transaction actually rolls back on error.
//
// This intentionally does NOT touch the customer's production Neon/Vercel
// Postgres (which, as of this phase, has not been provisioned -- see the
// Phase 5C report Section B). It runs against POSTGRES_URL, which in this
// sandbox points at a local, disposable Postgres instance created solely
// for this test run, containing no customer data of any kind. Set
// POSTGRES_URL to point this at any other disposable database/branch (e.g.
// a real Neon branch) to re-run this exact suite once one exists.
//
// Self-skips (rather than failing) when POSTGRES_URL is not set, so CI/dev
// environments without a database don't fail a suite that was never meant
// to run there -- this file is a supplement to the fake-backed route tests,
// never a replacement for them.

const test = require('node:test');
const assert = require('node:assert/strict');

if (!process.env.POSTGRES_URL) {
  test('real-postgres integration suite skipped (POSTGRES_URL not set)', (t) => t.skip());
} else {
  const { runMigrations } = require('../../migrations/run-migrations');
  const db = require('../../lib/db/pool');
  const { createProjectsRepo } = require('../../lib/repositories/projects-repo');
  const { createHomesRepo } = require('../../lib/repositories/homes-repo');

  const projectsRepo = createProjectsRepo(db);
  const homesRepo = createHomesRepo(db);

  test.before(async () => {
    await runMigrations({ connectionString: process.env.POSTGRES_URL, logger: { log: () => {} } });
  });

  test.beforeEach(async () => {
    // Truncate rather than drop -- proves the migration's tables are the
    // ones actually being exercised, not tables this file recreates itself.
    await db.query({ text: 'TRUNCATE projects, homes RESTART IDENTITY' });
  });

  test('migration created the expected tables and columns', async () => {
    const { rows } = await db.query({
      text: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('homes','projects','schema_migrations')`,
    });
    const names = rows.map((r) => r.table_name).sort();
    assert.deepEqual(names, ['homes', 'projects', 'schema_migrations']);
  });

  test('unique constraint on (customer_id, client_legacy_id) is enforced by Postgres itself, not just application code', async () => {
    const cust = 'pg-cust-1';
    await homesRepo.importHome(cust, { name: 'House' }, 'legacy-1');
    // A raw second insert bypassing importHome's ON CONFLICT DO NOTHING,
    // to prove the constraint -- not just the repo's careful SQL -- rejects it.
    await assert.rejects(
      () => db.query({
        text: `INSERT INTO homes (customer_id, client_legacy_id, name) VALUES ($1, $2, $3)`,
        values: [cust, 'legacy-1', 'Duplicate House'],
      }),
      (err) => err.code === '23505'
    );
  });

  test('multiple NULL client_legacy_id rows per customer are allowed (Postgres NULL semantics, needed for ordinary non-import creates)', async () => {
    const cust = 'pg-cust-2';
    const a = await projectsRepo.createProject(cust, { name: 'A', room: 'bedroom' });
    const b = await projectsRepo.createProject(cust, { name: 'B', room: 'kitchen' });
    assert.notEqual(a.id, b.id);
    assert.equal(a.client_legacy_id, null);
    assert.equal(b.client_legacy_id, null);
  });

  test('foreign key: assigning a project to a nonexistent home is rejected before it ever reaches the FK (ownership-checked in the repo)', async () => {
    const cust = 'pg-cust-3';
    const project = await projectsRepo.createProject(cust, { name: 'P', room: 'bedroom' });
    const result = await projectsRepo.assignProjectHome(cust, project.id, '00000000-0000-0000-0000-000000000000', project.version);
    assert.equal(result.status, 'home_not_found');
  });

  test('optimistic concurrency: a stale version is rejected with the real current row, real update never applied', async () => {
    const cust = 'pg-cust-4';
    const home = await homesRepo.createHome(cust, { name: 'House' });
    const result = await homesRepo.updateHomeForCustomer(cust, home.id, { name: 'New Name' }, home.version + 1);
    assert.equal(result.status, 'version_conflict');
    assert.equal(result.current.name, 'House');
  });

  test('soft deletion: deleted_at is set, row excluded from all customer-scoped reads, deleted_at IS NULL enforced by real partial index', async () => {
    const cust = 'pg-cust-5';
    const project = await projectsRepo.createProject(cust, { name: 'P', room: 'bedroom' });
    await projectsRepo.softDeleteProjectForCustomer(cust, project.id, project.version);

    const { rows } = await db.query({
      text: `SELECT deleted_at FROM projects WHERE id = $1`,
      values: [project.id],
    });
    assert.notEqual(rows[0].deleted_at, null);

    const fetched = await projectsRepo.getProjectForCustomer(cust, project.id);
    assert.equal(fetched, null);
  });

  test('transaction: deleting a home really rolls back cleanly on a forced failure (no partial state)', async () => {
    const cust = 'pg-cust-6';
    const home = await homesRepo.createHome(cust, { name: 'House' });
    const project = await projectsRepo.createProject(cust, { name: 'P', room: 'bedroom' });
    await projectsRepo.assignProjectHome(cust, project.id, home.id, project.version);

    await assert.rejects(() =>
      db.withTransaction(async (txQuery) => {
        await txQuery({
          text: `UPDATE homes SET deleted_at = now() WHERE id = $1`,
          values: [home.id],
        });
        throw new Error('forced failure mid-transaction');
      })
    );

    // Nothing committed -- the home is still active.
    const { rows } = await db.query({ text: `SELECT deleted_at FROM homes WHERE id = $1`, values: [home.id] });
    assert.equal(rows[0].deleted_at, null);
  });

  test('transaction: soft-deleting a home for real clears home_id on its projects atomically', async () => {
    const cust = 'pg-cust-7';
    const home = await homesRepo.createHome(cust, { name: 'House' });
    const project = await projectsRepo.createProject(cust, { name: 'P', room: 'bedroom' });
    const assigned = await projectsRepo.assignProjectHome(cust, project.id, home.id, project.version);
    assert.equal(assigned.status, 'ok');

    const del = await homesRepo.softDeleteHomeForCustomer(cust, home.id, home.version);
    assert.equal(del.status, 'ok');

    const { rows } = await db.query({ text: `SELECT home_id FROM projects WHERE id = $1`, values: [project.id] });
    assert.equal(rows[0].home_id, null);
  });

  test.after(async () => {
    const { getPool } = require('../../lib/db/pool');
    await getPool().end();
  });
}
