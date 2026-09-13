-- Phase 5C V1: Homes and Projects, the two durable relations approved in the
-- Phase 5B spec (Section B/C). No Room, DesignPreferences, RoomDesigner
-- output storage, or Home Blueprint tables — those remain out of V1 scope by
-- explicit instruction.
--
-- Ownership model: every row is scoped by customer_id, which is ALWAYS
-- server-derived from a verified Shopify App Proxy request (see
-- lib/verify-shopify-proxy.js) and never accepted from a client. Every query
-- in lib/repositories/*.js filters on customer_id in the same statement as
-- the read or write — see Phase 5B Section E, "Customer-Isolation Threat
-- Model," which this schema exists to make structurally enforceable rather
-- than reliant on application discipline alone.
--
-- Soft deletion: deleted_at is nullable; a non-null value means the row is
-- logically deleted but retained for the 30-day recovery window described in
-- Phase 5B Section H. Hard purge past that window is a separate, later job —
-- not implemented in this migration.
--
-- Optimistic concurrency: version starts at 1 on insert and is incremented by
-- exactly 1 on every successful mutating write (including soft delete). Every
-- UPDATE in the data-access layer is conditioned on a caller-supplied
-- expected version in the same WHERE clause as the ownership check.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS homes (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      TEXT NOT NULL,
  client_legacy_id TEXT,
  name             TEXT NOT NULL,
  schema_version   INTEGER NOT NULL DEFAULT 1,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT homes_customer_legacy_unique UNIQUE (customer_id, client_legacy_id)
);

-- Partial index: the only access pattern V1 needs is "this customer's
-- non-deleted homes," so the index excludes soft-deleted rows entirely
-- rather than requiring every query to filter a large, ever-growing table.
CREATE INDEX IF NOT EXISTS homes_customer_id_active_idx
  ON homes (customer_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id      TEXT NOT NULL,
  client_legacy_id TEXT,
  home_id          UUID REFERENCES homes(id),
  room_id          UUID, -- reserved for Phase 3's Room table; always NULL in V1, never settable by the client
  name             TEXT NOT NULL,
  room             TEXT NOT NULL,
  room_label       TEXT,
  mood_board       JSONB,
  space_plan       JSONB,
  schema_version   INTEGER NOT NULL DEFAULT 1,
  version          INTEGER NOT NULL DEFAULT 1,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at       TIMESTAMPTZ,
  CONSTRAINT projects_customer_legacy_unique UNIQUE (customer_id, client_legacy_id)
);

CREATE INDEX IF NOT EXISTS projects_customer_id_active_idx
  ON projects (customer_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS projects_home_id_active_idx
  ON projects (home_id)
  WHERE deleted_at IS NULL;
