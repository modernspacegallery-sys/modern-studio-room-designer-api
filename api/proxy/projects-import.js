// POST /api/proxy/projects-import
//
// The one-time, explicit, customer-confirmed import of existing localStorage
// Projects/Homes (Phase 5B Section F). A dedicated endpoint rather than an
// `op` on the routes above because it is a bulk, multi-row, one-shot
// operation with its own conflict semantics (skip-duplicate, never
// overwrite) and its own, stricter rate-limit bucket.
//
// NOT wired to the theme in this phase (Phase 5C Section 9) -- this file
// exists and is tested, but nothing on the storefront calls it yet.
//
// Request body: { homes: LegacyHome[], projects: LegacyProject[] }
//   LegacyHome    = { id: string, name: string }
//   LegacyProject = { id: string, homeId?: string, name, room, roomLabel?,
//                      moodBoard?, spacePlan? }
// `id` on each legacy record is the browser-generated local id -- stored as
// clientLegacyId, NEVER as the new server id, and used only for
// de-duplication and for resolving a Project's homeId reference against the
// Homes in the same (or an earlier, retried) import call.
//
// Response body: { importedProjects, importedHomes, skippedProjects, skippedHomes }
// Every entry is validated and imported independently -- one malformed
// entry is skipped and counted, never aborts the batch (Section F.4).

const { gate } = require('../../lib/studio-cloud-auth');
const { isStudioCloudProjectsWritesEnabled } = require('../../lib/studio-cloud-flag');
const { checkRateLimit } = require('../../lib/rate-limit');
const { checkStudioCloudCapability } = require('../../lib/studio-cloud-entitlement');
const { validateProjectInput, validateHomeInput, requireNonEmptyString, ValidationError } = require('../../lib/validation/project-fields');
const { createProjectsRepo } = require('../../lib/repositories/projects-repo');
const { createHomesRepo } = require('../../lib/repositories/homes-repo');

const projectsRepo = createProjectsRepo();
const homesRepo = createHomesRepo();

const MAX_BATCH_SIZE = 500; // sanity bound -- no real customer has anywhere near this many localStorage records today

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  // Stricter, lower bucket than the other routes -- this is a rare,
  // customer-initiated bulk action, never a hot path (Phase 5B Section D.2).
  const allowed = await checkRateLimit(req, 'proxy_projects_import');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const gated = gate(req, res);
  if (!gated.ok) return;
  const { customerId } = gated;

  // Phase 5D.2B: import is entirely a mutation (bulk create). Gate it here,
  // before entitlement and before any repository/Postgres call below --
  // same write-rollout flag and same fail-closed response as
  // api/proxy/projects.js and api/proxy/homes.js.
  if (!isStudioCloudProjectsWritesEnabled()) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  const cap = await checkStudioCloudCapability(customerId, 'import');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }

  const body = req.body || {};
  const { homes, projects } = body;
  if (!Array.isArray(homes) || !Array.isArray(projects)) {
    res.status(400).json({ error: 'invalid_request', message: 'homes and projects must both be arrays.' });
    return;
  }
  if (homes.length > MAX_BATCH_SIZE || projects.length > MAX_BATCH_SIZE) {
    res.status(400).json({ error: 'invalid_request', message: `Each array must have at most ${MAX_BATCH_SIZE} entries.` });
    return;
  }

  try {
    let importedHomes = 0;
    let skippedHomes = 0;
    // legacyHomeId -> real server UUID, for resolving each project's homeId
    const homeIdMap = new Map();

    for (const legacyHome of homes) {
      try {
        if (typeof legacyHome !== 'object' || legacyHome === null) throw new ValidationError('home entry must be an object.', null);
        const legacyId = requireNonEmptyString(legacyHome.id, 'home.id', 200);
        const fields = validateHomeInput(legacyHome, { partial: false });

        let row = await homesRepo.getHomeByClientLegacyId(customerId, legacyId);
        if (row) {
          skippedHomes += 1; // already imported on a previous, retried call
        } else {
          row = await homesRepo.importHome(customerId, fields, legacyId);
          if (row) {
            importedHomes += 1;
          } else {
            // Raced with a concurrent identical import -- treat as a skip, not an error.
            skippedHomes += 1;
            row = await homesRepo.getHomeByClientLegacyId(customerId, legacyId);
          }
        }
        if (row) homeIdMap.set(legacyId, row.id);
      } catch (err) {
        skippedHomes += 1;
        if (!(err instanceof ValidationError)) console.error('projects-import: unexpected home import error', err);
      }
    }

    let importedProjects = 0;
    let skippedProjects = 0;

    for (const legacyProject of projects) {
      try {
        if (typeof legacyProject !== 'object' || legacyProject === null) throw new ValidationError('project entry must be an object.', null);
        const legacyId = requireNonEmptyString(legacyProject.id, 'project.id', 200);
        const fields = validateProjectInput(legacyProject, { partial: false });
        const resolvedHomeId = legacyProject.homeId ? homeIdMap.get(legacyProject.homeId) || null : null;

        const row = await projectsRepo.importProject(customerId, fields, legacyId, resolvedHomeId);
        if (row) {
          importedProjects += 1;
        } else {
          skippedProjects += 1; // duplicate clientLegacyId -- already imported
        }
      } catch (err) {
        skippedProjects += 1;
        if (!(err instanceof ValidationError)) console.error('projects-import: unexpected project import error', err);
      }
    }

    res.status(200).json({ importedProjects, importedHomes, skippedProjects, skippedHomes });
  } catch (err) {
    console.error('proxy projects-import route failed', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
