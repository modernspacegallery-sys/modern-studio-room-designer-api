#!/usr/bin/env node
// Ordered, reproducible Postgres migration runner.
//
// Why hand-rolled instead of a migration framework: this project has exactly
// one migration today, no ORM, and a stated preference (Phase 5C Section 4)
// for a thin access layer over a heavyweight dependency. The contract this
// script guarantees is the same one any migration tool provides:
//   - migrations run in ascending filename order
//   - each migration runs at most once, tracked in schema_migrations
//   - each migration runs inside its own transaction (all-or-nothing)
//   - re-running this script is always safe (already-applied files are
//     skipped, not re-executed)
// If this schema grows past a handful of migrations, adopt a real migration
// tool at that point rather than extending this script further — see the
// Phase 5C report, Section D, for that trade-off explicitly.
//
// Usage:
//   POSTGRES_URL=postgres://... node migrations/run-migrations.js
//
// Never run manually-edited ALTER/CREATE statements directly against
// production — every schema change must be a new, numbered file in this
// directory so schema_migrations stays the single source of truth for what
// has actually been applied.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = __dirname;

function connectionStringFromEnv() {
  // Accept either name: Vercel's Postgres/Neon integration has used both
  // POSTGRES_URL and DATABASE_URL across different integration versions.
  // Verify the actual variable name provisioned before relying on this in
  // production — see Phase 5C report, Section B ("what is actually
  // provisioned"), which is why this checks both rather than assuming one.
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || null;
}

function listMigrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort(); // filenames are zero-padded numeric prefixes, so lexical sort is ordered execution
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function alreadyApplied(client) {
  const { rows } = await client.query('SELECT name FROM schema_migrations');
  return new Set(rows.map((r) => r.name));
}

async function runMigrations({ connectionString, logger = console } = {}) {
  const conn = connectionString || connectionStringFromEnv();
  if (!conn) {
    throw new Error(
      'No Postgres connection string found (checked POSTGRES_URL and DATABASE_URL). Refusing to run migrations against nothing.'
    );
  }

  const client = new Client({ connectionString: conn });
  await client.connect();

  const applied = [];
  try {
    await ensureMigrationsTable(client);
    const done = await alreadyApplied(client);
    const files = listMigrationFiles();

    for (const file of files) {
      if (done.has(file)) {
        logger.log(`skip (already applied): ${file}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      logger.log(`applying: ${file}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed and was rolled back: ${err.message}`);
      }
    }
  } finally {
    await client.end();
  }

  return { applied };
}

if (require.main === module) {
  runMigrations()
    .then(({ applied }) => {
      if (applied.length === 0) {
        console.log('No new migrations to apply.');
      } else {
        console.log(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
      }
      process.exit(0);
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}

module.exports = { runMigrations, listMigrationFiles };
