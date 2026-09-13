// Data-access layer for Projects. Every function requires customerId as an
// explicit parameter and every SQL statement filters on it in the SAME
// WHERE clause as the id/version condition -- see Phase 5B Section E: this
// is the one rule the entire customer-isolation threat model reduces to.
// Deliberately no getProjectById(id) followed by an ownership check
// (Phase 5C Section 5) -- that shape makes it possible for a future call
// site to forget the check. There is no function here that returns a row
// without customerId already having narrowed the query.
//
// Factory pattern: createProjectsRepo(db) returns the bound functions. `db`
// defaults to the real pool (lib/db/pool.js) so production call sites don't
// need to know this is injectable, but tests can pass a fake with the same
// { query, withTransaction } shape (see test/fake-postgres.js) without any
// module-loader monkey-patching.

const defaultDb = require('../db/pool');

function createProjectsRepo(db = defaultDb) {
  async function createProject(customerId, fields, { clientLegacyId = null } = {}) {
    const { rows } = await db.query({
      name: 'projects_insert',
      text: `
        INSERT INTO projects (customer_id, client_legacy_id, name, room, room_label, mood_board, space_plan)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        RETURNING *
      `,
      values: [
        customerId,
        clientLegacyId,
        fields.name,
        fields.room,
        fields.roomLabel || null,
        fields.moodBoard ? JSON.stringify(fields.moodBoard) : null,
        fields.spacePlan ? JSON.stringify(fields.spacePlan) : null,
      ],
    });
    return rows[0];
  }

  async function getProjectForCustomer(customerId, projectId) {
    const { rows } = await db.query({
      name: 'projects_get_for_customer',
      text: `SELECT * FROM projects WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
      values: [projectId, customerId],
    });
    return rows[0] || null;
  }

  async function listProjectsForCustomer(customerId) {
    const { rows } = await db.query({
      name: 'projects_list_for_customer',
      text: `SELECT * FROM projects WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY updated_at DESC`,
      values: [customerId],
    });
    return rows;
  }

  // Returns { status: 'ok', row } | { status: 'not_found' } | { status: 'version_conflict', current }
  async function updateProjectForCustomer(customerId, projectId, patch, expectedVersion) {
    const sets = [];
    const values = [projectId, customerId, expectedVersion];
    let i = values.length;

    if (patch.name !== undefined) { sets.push(`name = $${++i}`); values.push(patch.name); }
    if (patch.room !== undefined) { sets.push(`room = $${++i}`); values.push(patch.room); }
    if (patch.roomLabel !== undefined) { sets.push(`room_label = $${++i}`); values.push(patch.roomLabel); }
    if (patch.moodBoard !== undefined) { sets.push(`mood_board = $${++i}`); values.push(JSON.stringify(patch.moodBoard)); }
    if (patch.spacePlan !== undefined) { sets.push(`space_plan = $${++i}`); values.push(JSON.stringify(patch.spacePlan)); }

    if (sets.length === 0) {
      // Nothing to change -- treat as a no-op success against the current row.
      const current = await getProjectForCustomer(customerId, projectId);
      return current ? { status: 'ok', row: current } : { status: 'not_found' };
    }

    sets.push('version = version + 1', 'updated_at = now()');

    const { rows } = await db.query({
      // No `name` here deliberately: the SET clause shape varies per call
      // (only the fields actually present in the patch are updated), so a
      // fixed name would map to different SQL text across calls -- pg's
      // prepared-statement cache keys on name, and reusing one name for
      // different text errors on the connection. Unnamed queries just skip
      // server-side statement caching; correctness matters more here than
      // that optimization.
      text: `
        UPDATE projects SET ${sets.join(', ')}
        WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL AND version = $3
        RETURNING *
      `,
      values,
    });

    if (rows[0]) return { status: 'ok', row: rows[0] };

    // 0 rows: either not-found-for-this-customer (404, per Amendment 1 --
    // never distinguishable from "belongs to someone else") or a real
    // version conflict (409). Both checks below are customer-scoped, so a
    // wrong-owner projectId still resolves to not_found, never conflict.
    const current = await getProjectForCustomer(customerId, projectId);
    if (!current) return { status: 'not_found' };
    return { status: 'version_conflict', current };
  }

  // Returns { status: 'ok' } | { status: 'not_found' } | { status: 'version_conflict', current }
  async function softDeleteProjectForCustomer(customerId, projectId, expectedVersion) {
    const values = [projectId, customerId];
    let versionClause = '';
    if (expectedVersion !== undefined && expectedVersion !== null) {
      values.push(expectedVersion);
      versionClause = ' AND version = $3';
    }
    const { rows } = await db.query({
      name: expectedVersion !== undefined ? 'projects_soft_delete_versioned' : 'projects_soft_delete',
      text: `
        UPDATE projects SET deleted_at = now(), version = version + 1, updated_at = now()
        WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL${versionClause}
        RETURNING id
      `,
      values,
    });
    if (rows[0]) return { status: 'ok' };
    const current = await getProjectForCustomer(customerId, projectId);
    if (!current) return { status: 'not_found' };
    return { status: 'version_conflict', current };
  }

  // Assigns (homeId !== null) or unassigns (homeId === null) a Project to a
  // Home. When assigning, the Home must belong to the SAME customer -- this
  // is checked explicitly rather than trusted to the foreign key, because
  // the FK only proves the home row exists, not that this customer owns it.
  async function assignProjectHome(customerId, projectId, homeId, expectedVersion) {
    if (homeId !== null) {
      const { rows: homeRows } = await db.query({
        name: 'homes_get_for_customer_ownercheck',
        text: `SELECT id FROM homes WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`,
        values: [homeId, customerId],
      });
      if (!homeRows[0]) return { status: 'home_not_found' };
    }

    const { rows } = await db.query({
      name: 'projects_assign_home',
      text: `
        UPDATE projects SET home_id = $3, version = version + 1, updated_at = now()
        WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL AND version = $4
        RETURNING *
      `,
      values: [projectId, customerId, homeId, expectedVersion],
    });
    if (rows[0]) return { status: 'ok', row: rows[0] };
    const current = await getProjectForCustomer(customerId, projectId);
    if (!current) return { status: 'not_found' };
    return { status: 'version_conflict', current };
  }

  // Used by the import endpoint: insert-or-skip keyed on the
  // (customer_id, client_legacy_id) unique constraint, so a retried import
  // never creates a duplicate. Returns the row if inserted, null if skipped
  // as a duplicate.
  async function importProject(customerId, fields, clientLegacyId, homeId) {
    const { rows } = await db.query({
      name: 'projects_import_insert',
      text: `
        INSERT INTO projects (customer_id, client_legacy_id, home_id, name, room, room_label, mood_board, space_plan)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (customer_id, client_legacy_id) DO NOTHING
        RETURNING *
      `,
      values: [
        customerId,
        clientLegacyId,
        homeId || null,
        fields.name,
        fields.room,
        fields.roomLabel || null,
        fields.moodBoard ? JSON.stringify(fields.moodBoard) : null,
        fields.spacePlan ? JSON.stringify(fields.spacePlan) : null,
      ],
    });
    return rows[0] || null;
  }

  // Used when a Home is soft-deleted: clears home_id on every Project that
  // pointed to it, so a Project never references a deleted Home. Intended to
  // be called inside the same transaction as the Home's own soft delete
  // (see homes-repo.js softDeleteHomeForCustomer).
  async function clearHomeReference(customerId, homeId) {
    await db.query({
      name: 'projects_clear_home_reference',
      text: `UPDATE projects SET home_id = NULL, version = version + 1, updated_at = now() WHERE customer_id = $1 AND home_id = $2 AND deleted_at IS NULL`,
      values: [customerId, homeId],
    });
  }

  return {
    createProject,
    getProjectForCustomer,
    listProjectsForCustomer,
    updateProjectForCustomer,
    softDeleteProjectForCustomer,
    assignProjectHome,
    importProject,
    clearHomeReference,
  };
}

module.exports = { createProjectsRepo };
