// Data-access layer for Homes. Same customer-scoping discipline as
// projects-repo.js -- see that file's header comment, which applies here
// unchanged.

const defaultDb = require('../db/pool');

function createHomesRepo(db = defaultDb) {
  async function createHome(customerId, fields, { clientLegacyId = null } = {}) {
    const { rows } = await db.query({
      name: 'homes_insert',
      text: `
        INSERT INTO homes (customer_id, client_legacy_id, name)
        VALUES ($1, $2, $3)
        RETURNING *
      `,
      values: [customerId, clientLegacyId, fields.name],
    });
    return rows[0];
  }

  async function getHomeForCustomer(customerId, homeId) {
    const { rows } = await db.query({
      name: 'homes_get_for_customer',
      text: `SELECT * FROM homes WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
      values: [homeId, customerId],
    });
    return rows[0] || null;
  }

  async function listHomesForCustomer(customerId) {
    const { rows } = await db.query({
      name: 'homes_list_for_customer',
      text: `SELECT * FROM homes WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      values: [customerId],
    });
    return rows;
  }

  async function updateHomeForCustomer(customerId, homeId, patch, expectedVersion) {
    if (patch.name === undefined) {
      const current = await getHomeForCustomer(customerId, homeId);
      return current ? { status: 'ok', row: current } : { status: 'not_found' };
    }
    const { rows } = await db.query({
      name: 'homes_update_name',
      text: `
        UPDATE homes SET name = $4, version = version + 1, updated_at = now()
        WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL AND version = $3
        RETURNING *
      `,
      values: [homeId, customerId, expectedVersion, patch.name],
    });
    if (rows[0]) return { status: 'ok', row: rows[0] };
    const current = await getHomeForCustomer(customerId, homeId);
    if (!current) return { status: 'not_found' };
    return { status: 'version_conflict', current };
  }

  // Soft-deletes the Home and, in the same transaction, clears home_id on
  // every Project that referenced it -- a deleted Home never leaves a
  // dangling reference a client could still read as "this project's home."
  async function softDeleteHomeForCustomer(customerId, homeId, expectedVersion) {
    return db.withTransaction(async (txQuery) => {
      const values = [homeId, customerId];
      let versionClause = '';
      if (expectedVersion !== undefined && expectedVersion !== null) {
        values.push(expectedVersion);
        versionClause = ' AND version = $3';
      }
      const { rows } = await txQuery({
        name: expectedVersion !== undefined ? 'homes_soft_delete_versioned' : 'homes_soft_delete',
        text: `
          UPDATE homes SET deleted_at = now(), version = version + 1, updated_at = now()
          WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL${versionClause}
          RETURNING id
        `,
        values,
      });
      if (!rows[0]) {
        const { rows: currentRows } = await txQuery({
          name: 'homes_get_for_customer_in_tx',
          text: `SELECT * FROM homes WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
          values: [homeId, customerId],
        });
        if (!currentRows[0]) return { status: 'not_found' };
        return { status: 'version_conflict', current: currentRows[0] };
      }
      await txQuery({
        name: 'projects_clear_home_reference_in_tx',
        text: `UPDATE projects SET home_id = NULL, version = version + 1, updated_at = now() WHERE customer_id = $1 AND home_id = $2 AND deleted_at IS NULL`,
        values: [customerId, homeId],
      });
      return { status: 'ok' };
    });
  }

  // Phase 6B: `dates` ({ createdAt, updatedAt } as Date objects, already
  // resolved by lib/validation/import-dates.js) are optional; when absent the
  // database defaults (now()) apply, exactly as before.
  async function importHome(customerId, fields, clientLegacyId, dates = {}) {
    const { rows } = await db.query({
      name: 'homes_import_insert',
      text: `
        INSERT INTO homes (customer_id, client_legacy_id, name, created_at, updated_at)
        VALUES ($1, $2, $3, COALESCE($4::timestamptz, now()), COALESCE($5::timestamptz, now()))
        ON CONFLICT (customer_id, client_legacy_id) DO NOTHING
        RETURNING *
      `,
      values: [customerId, clientLegacyId, fields.name, dates.createdAt || null, dates.updatedAt || null],
    });
    return rows[0] || null;
  }

  // Looks up an existing home by its clientLegacyId, for import de-dup /
  // reference resolution when a re-run import references a home created on
  // a previous, partially-completed import call.
  async function getHomeByClientLegacyId(customerId, clientLegacyId) {
    if (!clientLegacyId) return null;
    const { rows } = await db.query({
      name: 'homes_get_by_client_legacy_id',
      text: `SELECT * FROM homes WHERE customer_id = $1 AND client_legacy_id = $2 AND deleted_at IS NULL`,
      values: [customerId, clientLegacyId],
    });
    return rows[0] || null;
  }

  // Phase 6B: read-only lookup used ONLY by the import route to choose a
  // per-record status. Scoped to the customer; INCLUDES soft-deleted rows so
  // "previously deleted" can be told apart from "never imported". Never
  // returns another customer's row, and nothing here writes.
  async function findHomesByClientLegacyIds(customerId, clientLegacyIds) {
    if (!clientLegacyIds || !clientLegacyIds.length) return [];
    const { rows } = await db.query({
      name: 'homes_find_by_client_legacy_ids',
      text: `SELECT id, client_legacy_id, deleted_at FROM homes WHERE customer_id = $1 AND client_legacy_id = ANY($2::text[])`,
      values: [customerId, clientLegacyIds],
    });
    return rows;
  }

  return {
    findHomesByClientLegacyIds,
    createHome,
    getHomeForCustomer,
    listHomesForCustomer,
    updateHomeForCustomer,
    softDeleteHomeForCustomer,
    importHome,
    getHomeByClientLegacyId,
  };
}

module.exports = { createHomesRepo };
