// Converts internal (snake_case) Postgres rows into the external (camelCase)
// API shapes from Phase 5B Section C. Centralized so no route hand-rolls its
// own field list and risks leaking an internal-only column (there are none
// today, but this is the seam where that discipline lives).

function serializeProject(row) {
  return {
    id: row.id,
    clientLegacyId: row.client_legacy_id,
    customerId: row.customer_id,
    homeId: row.home_id,
    roomId: row.room_id,
    name: row.name,
    room: row.room,
    roomLabel: row.room_label,
    moodBoard: row.mood_board,
    spacePlan: row.space_plan,
    schemaVersion: row.schema_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeHome(row) {
  return {
    id: row.id,
    clientLegacyId: row.client_legacy_id,
    customerId: row.customer_id,
    name: row.name,
    schemaVersion: row.schema_version,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = { serializeProject, serializeHome };
