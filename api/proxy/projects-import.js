// POST /api/proxy/projects-import
//
// The explicit, customer-confirmed import of browser (localStorage)
// Projects/Homes into the customer's cloud library (Phase 5B Section F;
// Phase 6B approved design rev3, decisions D1-D23).
//
// Two modes on one route, sharing every gate and every validation rule:
//
//   dryRun: true   PREVIEW. Stateless and read-only: runs no INSERT, UPDATE
//                  or DELETE. Resolves Home links using only (a) the database
//                  as it is now, scoped to this customer, and (b) the Homes
//                  proposed IN THIS REQUEST (`plannedHomes` plus `homes`).
//                  Nothing is remembered between requests.
//
//   otherwise      REAL IMPORT. Homes in `homes` are inserted first; each
//                  Project's non-null homeId must then resolve to a Home that
//                  exists in the database for this customer and is not
//                  deleted (inserted by this request or an earlier one).
//                  Otherwise the Project is `home_unavailable` and is NOT
//                  inserted. `plannedHomes` is rejected on a real import --
//                  the real import never trusts a proposed Home.
//
// Request body:
//   { dryRun?: boolean, planVersion?: integer,
//     plannedHomes?: [{ id, name }]            (dryRun only, <= 200, unique ids)
//     homes:    [{ id, name, createdAt?, updatedAt?, datePreference? }]
//     projects: [{ id, homeId?, name, room, roomLabel?, moodBoard?, spacePlan?,
//                  createdAt?, updatedAt?, datePreference? }] }
//   `id` on each entry is the browser-generated local id -- stored as
//   client_legacy_id, NEVER used as the server id.
//
// Response (both modes): { dryRun, planVersion, homes: [...], plannedHomes: [...],
//   projects: [...], importedHomes, importedProjects, skippedHomes, skippedProjects }
//   Home status:    imported | would_import | already_imported | previously_deleted | invalid
//   Project status: the same, plus home_unavailable
//   Project homeLink: linked | would_link_existing | would_link_planned | none
//   home_unavailable carries homeReason: not_found | deleted | invalid
//   `field` (invalid) is a field name only, never a value.
//   `dates` (see lib/validation/import-dates.js) on records that would be / were inserted.
//
// Order of evaluation is identical in both modes, so a preview agrees with the
// import for the same database state and clock:
//   validate -> the record's own existing row -> (Projects) Home link -> insert.
//
// Error handling: a ValidationError makes that one entry `invalid`. Any other
// error aborts the request with 500 BEFORE later entries are processed --
// in particular before any Project when a Home fails -- so a retry (always
// safe: unique constraint + ON CONFLICT DO NOTHING) can finish the job and a
// transient failure can never leave a Project imported without its Home.

const { gate } = require('../../lib/studio-cloud-auth');
const { isStudioCloudProjectsWritesEnabled } = require('../../lib/studio-cloud-flag');
const { checkRateLimit } = require('../../lib/rate-limit');
const { checkStudioCloudCapability } = require('../../lib/studio-cloud-entitlement');
const { validateProjectInput, validateHomeInput, requireNonEmptyString, ValidationError } = require('../../lib/validation/project-fields');
const { resolveImportDates } = require('../../lib/validation/import-dates');
const { createProjectsRepo } = require('../../lib/repositories/projects-repo');
const { createHomesRepo } = require('../../lib/repositories/homes-repo');

const projectsRepo = createProjectsRepo();
const homesRepo = createHomesRepo();

const MAX_BATCH_SIZE = 500; // per array, real import and preview alike
const MAX_PLANNED_HOMES = 200;
const MAX_LEGACY_ID_LENGTH = 200;

// Clock seam: one reading per request. Tests replace it to get a fixed clock.
let clock = () => Date.now();

function badRequest(res, message) {
  res.status(400).json({ error: 'invalid_request', message });
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Same id rule as a real Home/Project import entry.
function legacyIdOf(entry, field) {
  if (!isPlainObject(entry)) throw new ValidationError(`${field} entry must be an object.`, null);
  return requireNonEmptyString(entry.id, 'id', MAX_LEGACY_ID_LENGTH);
}

function validateDatePreference(entry) {
  if (entry.datePreference === undefined || entry.datePreference === null) return null;
  if (entry.datePreference !== 'import_time') {
    throw new ValidationError('datePreference must be "import_time" if provided.', 'datePreference');
  }
  return 'import_time';
}

// Validate a Home entry (from `homes` or `plannedHomes`) with exactly the
// rules a real Home import applies. Returns { legacyId, fields, dates }.
function validateHomeEntry(entry, now) {
  const legacyId = legacyIdOf(entry, 'home');
  const fields = validateHomeInput(entry, { partial: false });
  const datePreference = validateDatePreference(entry);
  const dates = resolveImportDates({
    legacyId, createdAt: entry.createdAt, updatedAt: entry.updatedAt, datePreference, now,
  });
  return { legacyId, fields, dates };
}

// Validate a Project entry. Board/plan savedAt are resolved by the date rules
// BEFORE field validation, so an unreadable savedAt never rejects a Project.
function validateProjectEntry(entry, now) {
  const legacyId = legacyIdOf(entry, 'project');
  let homeId = null;
  if (entry.homeId !== undefined && entry.homeId !== null) {
    homeId = requireNonEmptyString(entry.homeId, 'homeId', MAX_LEGACY_ID_LENGTH);
  }
  const datePreference = validateDatePreference(entry);

  const board = isPlainObject(entry.moodBoard) ? entry.moodBoard : null;
  const plan = isPlainObject(entry.spacePlan) ? entry.spacePlan : null;
  const dates = resolveImportDates({
    legacyId,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    boardSavedAt: board && 'savedAt' in board ? board.savedAt : undefined,
    planSavedAt: plan && 'savedAt' in plan ? plan.savedAt : undefined,
    datePreference,
    now,
  });

  const input = Object.assign({}, entry);
  if (board && dates.boardSavedAt) input.moodBoard = Object.assign({}, board, { savedAt: dates.boardSavedAt.value });
  if (plan && dates.planSavedAt) input.spacePlan = Object.assign({}, plan, { savedAt: dates.planSavedAt.value });
  const fields = validateProjectInput(input, { partial: false });

  return { legacyId, homeId, fields, dates };
}

function toDateObjects(dates) {
  return { createdAt: new Date(dates.createdAt.value), updatedAt: new Date(dates.updatedAt.value) };
}

function invalidResult(legacyId, err) {
  const out = { legacyId: legacyId || null, status: 'invalid' };
  if (err && err.field) out.field = err.field;
  return out;
}

function mapByLegacyId(rows) {
  const m = new Map();
  for (const r of rows) m.set(r.client_legacy_id, r);
  return m;
}

function safeLegacyId(entry) {
  return isPlainObject(entry) && typeof entry.id === 'string' ? entry.id.trim() : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Stricter, lower bucket than the other routes (Phase 5B Section D.2).
  const allowed = await checkRateLimit(req, 'proxy_projects_import');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const gated = gate(req, res);
  if (!gated.ok) return;
  const { customerId } = gated;

  // Same write-rollout gate for preview and import: a preview of an import
  // that cannot run would mislead the customer.
  if (!isStudioCloudProjectsWritesEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const cap = await checkStudioCloudCapability(customerId, 'import');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }

  const body = isPlainObject(req.body) ? req.body : {};
  const dryRun = body.dryRun === true;
  const { homes, projects } = body;
  const plannedHomes = body.plannedHomes;
  const planVersion = Number.isInteger(body.planVersion) ? body.planVersion : null;

  if (!Array.isArray(homes) || !Array.isArray(projects)) {
    badRequest(res, 'homes and projects must both be arrays.');
    return;
  }
  if (homes.length > MAX_BATCH_SIZE || projects.length > MAX_BATCH_SIZE) {
    badRequest(res, `Each array must have at most ${MAX_BATCH_SIZE} entries.`);
    return;
  }
  if (plannedHomes !== undefined) {
    if (!dryRun) {
      badRequest(res, 'plannedHomes is only allowed with dryRun.');
      return;
    }
    if (!Array.isArray(plannedHomes) || plannedHomes.length > MAX_PLANNED_HOMES) {
      badRequest(res, `plannedHomes must be an array of at most ${MAX_PLANNED_HOMES} entries.`);
      return;
    }
    const seen = new Set();
    for (const ph of plannedHomes) {
      const id = safeLegacyId(ph);
      if (id && seen.has(id)) {
        badRequest(res, 'plannedHomes must not contain duplicate ids.');
        return;
      }
      if (id) seen.add(id);
    }
  }

  const now = clock();

  try {
    const result = dryRun
      ? await preview(customerId, { homes, projects, plannedHomes: plannedHomes || [] }, now)
      : await importForReal(customerId, { homes, projects }, now);

    res.status(200).json(Object.assign({ dryRun, planVersion }, result));
  } catch (err) {
    console.error('proxy projects-import route failed', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};

// ---------------------------------------------------------------------------
// PREVIEW (read-only; no INSERT/UPDATE/DELETE is ever issued from here)
// ---------------------------------------------------------------------------

async function preview(customerId, { homes, projects, plannedHomes }, now) {
  const allHomeIds = new Set();
  for (const e of homes.concat(plannedHomes)) { const id = safeLegacyId(e); if (id) allHomeIds.add(id); }
  for (const p of projects) {
    if (isPlainObject(p) && typeof p.homeId === 'string' && p.homeId.trim()) allHomeIds.add(p.homeId.trim());
  }
  const projectIds = projects.map(safeLegacyId).filter(Boolean);

  const homeRows = mapByLegacyId(await homesRepo.findHomesByClientLegacyIds(customerId, [...allHomeIds]));
  const projectRows = mapByLegacyId(await projectsRepo.findProjectsByClientLegacyIds(customerId, projectIds));

  // Evaluate one Home entry exactly as a real Home import would.
  function evaluateHome(entry) {
    let v;
    try {
      v = validateHomeEntry(entry, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return invalidResult(safeLegacyId(entry), err);
    }
    const row = homeRows.get(v.legacyId);
    if (row && !row.deleted_at) return { legacyId: v.legacyId, status: 'already_imported', id: row.id };
    if (row && row.deleted_at) return { legacyId: v.legacyId, status: 'previously_deleted' };
    return { legacyId: v.legacyId, status: 'would_import', dates: v.dates };
  }

  const homeResults = homes.map(evaluateHome);
  const plannedResults = plannedHomes.map(evaluateHome);

  // Proposed Homes in THIS request: plannedHomes plus homes (the real import
  // would insert `homes` before resolving Projects in the same request).
  const proposed = new Map();
  for (const r of homeResults.concat(plannedResults)) {
    if (!r.legacyId) continue;
    const prev = proposed.get(r.legacyId);
    // If the same id appears twice with different outcomes, the worse one wins.
    if (!prev || (prev.status === 'would_import' && r.status !== 'would_import')) proposed.set(r.legacyId, r);
  }

  const projectResults = projects.map((entry) => {
    let v;
    try {
      v = validateProjectEntry(entry, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      return invalidResult(safeLegacyId(entry), err);
    }
    const own = projectRows.get(v.legacyId);
    if (own && !own.deleted_at) return { legacyId: v.legacyId, status: 'already_imported', id: own.id };
    if (own && own.deleted_at) return { legacyId: v.legacyId, status: 'previously_deleted' };

    if (v.homeId === null) {
      return { legacyId: v.legacyId, status: 'would_import', homeLink: 'none', dates: v.dates };
    }
    const dbHome = homeRows.get(v.homeId);
    if (dbHome && !dbHome.deleted_at) {
      return { legacyId: v.legacyId, status: 'would_import', homeLink: 'would_link_existing', homeLegacyId: v.homeId, dates: v.dates };
    }
    if (dbHome && dbHome.deleted_at) {
      return { legacyId: v.legacyId, status: 'home_unavailable', homeReason: 'deleted', homeLegacyId: v.homeId };
    }
    const planned = proposed.get(v.homeId);
    if (planned && planned.status === 'would_import') {
      return { legacyId: v.legacyId, status: 'would_import', homeLink: 'would_link_planned', homeLegacyId: v.homeId, dates: v.dates };
    }
    if (planned && planned.status === 'invalid') {
      return { legacyId: v.legacyId, status: 'home_unavailable', homeReason: 'invalid', homeLegacyId: v.homeId };
    }
    return { legacyId: v.legacyId, status: 'home_unavailable', homeReason: 'not_found', homeLegacyId: v.homeId };
  });

  return withCounts({ homes: homeResults, plannedHomes: plannedResults, projects: projectResults });
}

// ---------------------------------------------------------------------------
// REAL IMPORT
// ---------------------------------------------------------------------------

async function importForReal(customerId, { homes, projects }, now) {
  // Homes first. Unexpected errors propagate -> 500 before any Project.
  const homeResults = [];
  const invalidHomeIds = new Set();
  const homeIds = homes.map(safeLegacyId).filter(Boolean);
  const existingHomes = mapByLegacyId(await homesRepo.findHomesByClientLegacyIds(customerId, homeIds));

  for (const entry of homes) {
    let v;
    try {
      v = validateHomeEntry(entry, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      const r = invalidResult(safeLegacyId(entry), err);
      if (r.legacyId) invalidHomeIds.add(r.legacyId);
      homeResults.push(r);
      continue;
    }
    const existing = existingHomes.get(v.legacyId);
    if (existing) {
      homeResults.push(existing.deleted_at
        ? { legacyId: v.legacyId, status: 'previously_deleted' }
        : { legacyId: v.legacyId, status: 'already_imported', id: existing.id });
      continue;
    }
    const row = await homesRepo.importHome(customerId, v.fields, v.legacyId, toDateObjects(v.dates));
    if (row) {
      homeResults.push({ legacyId: v.legacyId, status: 'imported', id: row.id, dates: v.dates });
    } else {
      // Raced with a concurrent import of the same Home: report what is there now.
      const [now2] = await homesRepo.findHomesByClientLegacyIds(customerId, [v.legacyId]);
      homeResults.push(now2 && now2.deleted_at
        ? { legacyId: v.legacyId, status: 'previously_deleted' }
        : { legacyId: v.legacyId, status: 'already_imported', id: now2 ? now2.id : null });
    }
  }

  // Projects. Look up their own rows and every referenced Home AFTER the
  // Homes above were inserted, so Homes from this request resolve too.
  const projectIds = projects.map(safeLegacyId).filter(Boolean);
  const referencedHomeIds = [...new Set(projects
    .filter((p) => isPlainObject(p) && typeof p.homeId === 'string' && p.homeId.trim())
    .map((p) => p.homeId.trim()))];
  const ownRows = mapByLegacyId(await projectsRepo.findProjectsByClientLegacyIds(customerId, projectIds));
  const homeRows = mapByLegacyId(await homesRepo.findHomesByClientLegacyIds(customerId, referencedHomeIds));

  const projectResults = [];
  for (const entry of projects) {
    let v;
    try {
      v = validateProjectEntry(entry, now);
    } catch (err) {
      if (!(err instanceof ValidationError)) throw err;
      projectResults.push(invalidResult(safeLegacyId(entry), err));
      continue;
    }
    const own = ownRows.get(v.legacyId);
    if (own) {
      projectResults.push(own.deleted_at
        ? { legacyId: v.legacyId, status: 'previously_deleted' }
        : { legacyId: v.legacyId, status: 'already_imported', id: own.id });
      continue;
    }

    let homeServerId = null;
    if (v.homeId !== null) {
      const h = homeRows.get(v.homeId);
      if (!h || h.deleted_at) {
        projectResults.push({
          legacyId: v.legacyId,
          status: 'home_unavailable',
          homeReason: h ? 'deleted' : (invalidHomeIds.has(v.homeId) ? 'invalid' : 'not_found'),
          homeLegacyId: v.homeId,
        });
        continue;
      }
      homeServerId = h.id;
    }

    const row = await projectsRepo.importProject(customerId, v.fields, v.legacyId, homeServerId, toDateObjects(v.dates));
    if (row) {
      projectResults.push({
        legacyId: v.legacyId,
        status: 'imported',
        id: row.id,
        homeLink: homeServerId ? 'linked' : 'none',
        dates: v.dates,
      });
    } else {
      const [now2] = await projectsRepo.findProjectsByClientLegacyIds(customerId, [v.legacyId]);
      projectResults.push(now2 && now2.deleted_at
        ? { legacyId: v.legacyId, status: 'previously_deleted' }
        : { legacyId: v.legacyId, status: 'already_imported', id: now2 ? now2.id : null });
    }
  }

  return withCounts({ homes: homeResults, plannedHomes: [], projects: projectResults });
}

function withCounts(r) {
  const importedHomes = r.homes.filter((x) => x.status === 'imported').length;
  const importedProjects = r.projects.filter((x) => x.status === 'imported').length;
  return Object.assign(r, {
    importedHomes,
    importedProjects,
    skippedHomes: r.homes.length - importedHomes,
    skippedProjects: r.projects.length - importedProjects,
  });
}

// Test-only clock seam (fixed-clock date-equivalence tests). Not used in production.
module.exports._setClockForTests = (fn) => { clock = typeof fn === 'function' ? fn : () => Date.now(); };
