// In-memory fake for lib/db/pool.js's { query, withTransaction } interface,
// mirroring the existing test/fake-kv.js pattern: real route and repository
// files run completely unmodified against this fake, so what's under test
// is actual production code, not a reimplementation of it.
//
// This fake does NOT parse SQL. It recognizes queries by the `name` field
// the repositories always pass (see lib/repositories/*.js) and reproduces
// just enough of Postgres's behavior for those exact statements: unique
// constraints (customer_id, client_legacy_id), the ownership+version WHERE
// pattern, ON CONFLICT DO NOTHING, and soft-delete filtering. It is
// deliberately narrow -- see migrations/001_create_projects_and_homes.sql
// and the "real Postgres integration test" section of the Phase 5C report
// for where actual constraint/FK/transaction behavior is verified against a
// real Postgres engine instead.

const crypto = require('crypto');

function createFakePostgres() {
  let homes = new Map(); // id -> row
  let projects = new Map(); // id -> row

  function reset() {
    homes = new Map();
    projects = new Map();
  }

  // Phase 6B (F7): the real UNIQUE (customer_id, client_legacy_id) constraint
  // has no "WHERE deleted_at IS NULL", so it also covers soft-deleted rows.
  // findHomeByLegacy mirrors the CONSTRAINT (any row); findActiveHomeByLegacy
  // mirrors queries that filter deleted_at IS NULL.
  function findHomeByLegacy(customerId, clientLegacyId) {
    if (!clientLegacyId) return undefined;
    for (const row of homes.values()) {
      if (row.customer_id === customerId && row.client_legacy_id === clientLegacyId) return row;
    }
    return undefined;
  }

  function findActiveHomeByLegacy(customerId, clientLegacyId) {
    const row = findHomeByLegacy(customerId, clientLegacyId);
    return row && !row.deleted_at ? row : undefined;
  }

  function findProjectByLegacy(customerId, clientLegacyId) {
    if (!clientLegacyId) return undefined;
    for (const row of projects.values()) {
      if (row.customer_id === customerId && row.client_legacy_id === clientLegacyId) return row;
    }
    return undefined;
  }

  function cloneRow(row) {
    return row ? { ...row } : row;
  }

  // Phase 6B: every query name is logged so tests can prove that a dry run
  // issues no INSERT/UPDATE/DELETE (see test/studio-cloud-import-6b.test.js).
  const queryLog = [];
  // Phase 6B: inject one non-validation failure: the (skip+1)-th query named `name` throws.
  const faults = [];

  async function query({ name, text, values }) {
    queryLog.push(name || (text || '').trim().split(/\s+/).slice(0, 2).join(' '));
    if (faults.length && faults[0].name === name) {
      const f = faults[0];
      f.skip -= 1;
      if (f.skip < 0) {
        faults.shift();
        throw new Error('fake-postgres: injected fault on ' + name);
      }
    }
    switch (name) {
      case 'homes_insert': {
        const [customerId, clientLegacyId, homeName] = values;
        if (clientLegacyId && findHomeByLegacy(customerId, clientLegacyId)) {
          const err = new Error('duplicate key value violates unique constraint "homes_customer_legacy_unique"');
          err.code = '23505';
          throw err;
        }
        const row = {
          id: crypto.randomUUID(),
          customer_id: customerId,
          client_legacy_id: clientLegacyId,
          name: homeName,
          schema_version: 1,
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        };
        homes.set(row.id, row);
        return { rows: [cloneRow(row)] };
      }

      case 'homes_import_insert': {
        const [customerId, clientLegacyId, homeName, createdAt, updatedAt] = values;
        if (findHomeByLegacy(customerId, clientLegacyId)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        const row = {
          id: crypto.randomUUID(),
          customer_id: customerId,
          client_legacy_id: clientLegacyId,
          name: homeName,
          schema_version: 1,
          version: 1,
          created_at: createdAt ? new Date(createdAt) : new Date(),
          updated_at: updatedAt ? new Date(updatedAt) : new Date(),
          deleted_at: null,
        };
        homes.set(row.id, row);
        return { rows: [cloneRow(row)] };
      }

      case 'homes_get_for_customer':
      case 'homes_get_for_customer_ownercheck':
      case 'homes_get_for_customer_in_tx': {
        const [homeId, customerId] = values;
        const row = homes.get(homeId);
        if (row && row.customer_id === customerId && !row.deleted_at) return { rows: [cloneRow(row)] };
        return { rows: [] };
      }

      case 'homes_get_by_client_legacy_id': {
        const [customerId, clientLegacyId] = values;
        const row = findActiveHomeByLegacy(customerId, clientLegacyId);
        return { rows: row ? [cloneRow(row)] : [] };
      }

      case 'homes_find_by_client_legacy_ids': {
        const [customerId, ids] = values;
        const want = new Set(ids);
        const rows = [...homes.values()]
          .filter((r) => r.customer_id === customerId && want.has(r.client_legacy_id))
          .map((r) => ({ id: r.id, client_legacy_id: r.client_legacy_id, deleted_at: r.deleted_at }));
        return { rows };
      }

      case 'projects_find_by_client_legacy_ids': {
        const [customerId, ids] = values;
        const want = new Set(ids);
        const rows = [...projects.values()]
          .filter((r) => r.customer_id === customerId && want.has(r.client_legacy_id))
          .map((r) => ({ id: r.id, client_legacy_id: r.client_legacy_id, home_id: r.home_id, deleted_at: r.deleted_at }));
        return { rows };
      }

      case 'homes_list_for_customer': {
        const [customerId] = values;
        const rows = [...homes.values()]
          .filter((r) => r.customer_id === customerId && !r.deleted_at)
          .sort((a, b) => b.updated_at - a.updated_at)
          .map(cloneRow);
        return { rows };
      }

      case 'homes_update_name': {
        const [homeId, customerId, expectedVersion, newName] = values;
        const row = homes.get(homeId);
        if (!row || row.customer_id !== customerId || row.deleted_at || row.version !== expectedVersion) {
          return { rows: [] };
        }
        row.name = newName;
        row.version += 1;
        row.updated_at = new Date();
        return { rows: [cloneRow(row)] };
      }

      case 'homes_soft_delete':
      case 'homes_soft_delete_versioned': {
        const homeId = values[0];
        const customerId = values[1];
        const expectedVersion = values.length > 2 ? values[2] : undefined;
        const row = homes.get(homeId);
        if (!row || row.customer_id !== customerId || row.deleted_at) return { rows: [] };
        if (expectedVersion !== undefined && row.version !== expectedVersion) return { rows: [] };
        row.deleted_at = new Date();
        row.version += 1;
        row.updated_at = new Date();
        return { rows: [{ id: row.id }] };
      }

      case 'projects_clear_home_reference':
      case 'projects_clear_home_reference_in_tx': {
        const [customerId, homeId] = values;
        for (const row of projects.values()) {
          if (row.customer_id === customerId && row.home_id === homeId && !row.deleted_at) {
            row.home_id = null;
            row.version += 1;
            row.updated_at = new Date();
          }
        }
        return { rows: [] };
      }

      case 'projects_insert': {
        const [customerId, clientLegacyId, projName, room, roomLabel, moodBoard, spacePlan] = values;
        if (clientLegacyId && findProjectByLegacy(customerId, clientLegacyId)) {
          const err = new Error('duplicate key value violates unique constraint "projects_customer_legacy_unique"');
          err.code = '23505';
          throw err;
        }
        const row = {
          id: crypto.randomUUID(),
          customer_id: customerId,
          client_legacy_id: clientLegacyId,
          home_id: null,
          room_id: null,
          name: projName,
          room,
          room_label: roomLabel,
          mood_board: moodBoard ? JSON.parse(moodBoard) : null,
          space_plan: spacePlan ? JSON.parse(spacePlan) : null,
          schema_version: 1,
          version: 1,
          created_at: new Date(),
          updated_at: new Date(),
          deleted_at: null,
        };
        projects.set(row.id, row);
        return { rows: [cloneRow(row)] };
      }

      case 'projects_import_insert': {
        const [customerId, clientLegacyId, homeId, projName, room, roomLabel, moodBoard, spacePlan, createdAt, updatedAt] = values;
        if (findProjectByLegacy(customerId, clientLegacyId)) {
          return { rows: [] };
        }
        const row = {
          id: crypto.randomUUID(),
          customer_id: customerId,
          client_legacy_id: clientLegacyId,
          home_id: homeId || null,
          room_id: null,
          name: projName,
          room,
          room_label: roomLabel,
          mood_board: moodBoard ? JSON.parse(moodBoard) : null,
          space_plan: spacePlan ? JSON.parse(spacePlan) : null,
          schema_version: 1,
          version: 1,
          created_at: createdAt ? new Date(createdAt) : new Date(),
          updated_at: updatedAt ? new Date(updatedAt) : new Date(),
          deleted_at: null,
        };
        projects.set(row.id, row);
        return { rows: [cloneRow(row)] };
      }

      case 'projects_get_for_customer': {
        const [projectId, customerId] = values;
        const row = projects.get(projectId);
        if (row && row.customer_id === customerId && !row.deleted_at) return { rows: [cloneRow(row)] };
        return { rows: [] };
      }

      case 'projects_list_for_customer': {
        const [customerId] = values;
        const rows = [...projects.values()]
          .filter((r) => r.customer_id === customerId && !r.deleted_at)
          .sort((a, b) => b.updated_at - a.updated_at)
          .map(cloneRow);
        return { rows };
      }

      case 'projects_soft_delete':
      case 'projects_soft_delete_versioned': {
        const projectId = values[0];
        const customerId = values[1];
        const expectedVersion = values.length > 2 ? values[2] : undefined;
        const row = projects.get(projectId);
        if (!row || row.customer_id !== customerId || row.deleted_at) return { rows: [] };
        if (expectedVersion !== undefined && row.version !== expectedVersion) return { rows: [] };
        row.deleted_at = new Date();
        row.version += 1;
        row.updated_at = new Date();
        return { rows: [{ id: row.id }] };
      }

      case 'projects_assign_home': {
        const [projectId, customerId, homeId, expectedVersion] = values;
        const row = projects.get(projectId);
        if (!row || row.customer_id !== customerId || row.deleted_at || row.version !== expectedVersion) {
          return { rows: [] };
        }
        row.home_id = homeId;
        row.version += 1;
        row.updated_at = new Date();
        return { rows: [cloneRow(row)] };
      }

      default: {
        // The dynamic-shape UPDATE in updateProjectForCustomer/updateHomeForCustomer
        // is sent unnamed (see that file's comment on why) -- handle it by text sniffing
        // ONLY for that one known shape, since it can't be matched by name.
        if (text && text.includes('UPDATE projects SET') && text.includes('WHERE id = $1 AND customer_id = $2')) {
          return fakeUpdateProject(values, text);
        }
        throw new Error(`fake-postgres: unrecognized query (name=${name}). Add a case for it.`);
      }
    }
  }

  function fakeUpdateProject(values, text) {
    const [projectId, customerId, expectedVersion] = values;
    const row = projects.get(projectId);
    if (!row || row.customer_id !== customerId || row.deleted_at || row.version !== expectedVersion) {
      return { rows: [] };
    }
    // values[3..] correspond, in order, to whichever SET clauses were built.
    // Reconstruct which fields by matching the SET fragment order in `text`.
    const fieldOrder = [];
    if (text.includes('name = $')) fieldOrder.push('name');
    if (text.includes('room = $')) fieldOrder.push('room');
    if (text.includes('room_label = $')) fieldOrder.push('room_label');
    if (text.includes('mood_board = $')) fieldOrder.push('mood_board');
    if (text.includes('space_plan = $')) fieldOrder.push('space_plan');

    let vi = 3;
    for (const field of fieldOrder) {
      const raw = values[vi++];
      if (field === 'mood_board' || field === 'space_plan') {
        row[field] = raw ? JSON.parse(raw) : null;
      } else {
        row[field] = raw;
      }
    }
    row.version += 1;
    row.updated_at = new Date();
    return { rows: [cloneRow(row)] };
  }

  async function withTransaction(fn) {
    // The fake has no real rollback -- it snapshots and restores on error,
    // which is sufficient for testing outcome/behavior, not durability.
    const homesSnapshot = new Map([...homes].map(([k, v]) => [k, { ...v }]));
    const projectsSnapshot = new Map([...projects].map(([k, v]) => [k, { ...v }]));
    try {
      return await fn(query);
    } catch (err) {
      homes = homesSnapshot;
      projects = projectsSnapshot;
      throw err;
    }
  }

  return {
    query,
    withTransaction,
    reset,
    _debug: { homes, projects },
    // Phase 6B test helpers (live views; `_debug` keeps its original shape).
    queryLog,
    injectFault(name, skip = 0) { faults.push({ name, skip }); },
    allRows() {
      return { homes: [...homes.values()].map(cloneRow), projects: [...projects.values()].map(cloneRow) };
    },
  };
}

module.exports = { createFakePostgres };
