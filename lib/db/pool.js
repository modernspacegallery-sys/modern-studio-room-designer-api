// Thin, lazy Postgres connection pool. Deliberately NOT a heavyweight ORM —
// see Phase 5C report Section D for why `pg` (node-postgres) was chosen over
// an ORM or the `@vercel/postgres` package: `pg` is the underlying driver
// both of those wrap, has no framework opinions baked in, and works
// identically against any Postgres provider (Neon via Vercel today, anything
// else later) as long as a standard connection string is supplied — which
// avoids coupling the data-access layer to one marketplace integration's
// client library.
//
// Lazy by design: requiring this module must never throw just because
// POSTGRES_URL isn't set yet (e.g. at import time in a test file that mocks
// the whole module) — the connection is only attempted the first time a
// query actually runs.

const { Pool } = require('pg');

let pool = null;

function connectionStringFromEnv() {
  // Accept both names — see migrations/run-migrations.js for why.
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || null;
}

function getPool() {
  if (pool) return pool;
  const connectionString = connectionStringFromEnv();
  if (!connectionString) {
    throw new Error(
      'No Postgres connection string configured (POSTGRES_URL / DATABASE_URL). Cloud Projects/Homes cannot run without it.'
    );
  }
  pool = new Pool({ connectionString, max: 5 });
  return pool;
}

/**
 * Real Postgres-backed query client. Matches the shape repositories expect:
 * query({ name, text, values }) -> Promise<{ rows }>.
 * `name` is passed straight through to `pg`, which uses it for server-side
 * prepared-statement caching when present — a free performance benefit of
 * this design, not something added for its own sake.
 */
async function query({ name, text, values }) {
  const client = getPool();
  return client.query({ name, text, values });
}

/**
 * Runs `fn` with a client bound to a single transaction (BEGIN/COMMIT, with
 * ROLLBACK on any thrown error). Needed for the handful of operations that
 * touch more than one row atomically (e.g. soft-deleting a Home also clears
 * home_id on the Projects that pointed to it).
 */
async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const txQuery = async ({ name, text, values }) => client.query({ name, text, values });
    const result = await fn(txQuery);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { query, withTransaction, getPool };
