// GET /api/proxy/projects  -- list, or fetch a single Project by id
// POST /api/proxy/projects -- create / update / delete / assign / unassign
//
// Reached ONLY through the Shopify App Proxy, same trust model as every
// other file in api/proxy/ -- see lib/studio-cloud-auth.js. Flat route, no
// dynamic segments, per Phase 5B Section 4/D and Phase 5C Section 7 ("Preserve
// the flat-route design"): every mutating operation on this route is
// dispatched by an `op` field in the POST body, not by a URL path parameter,
// because plain (non-framework) Vercel functions supporting bracketed
// dynamic route segments was never verified in this codebase (every existing
// route here is flat) and Phase 5B was explicit: do not assume.
//
// Behind the STUDIO_CLOUD_PROJECTS_ENABLED dark-launch flag -- see
// lib/studio-cloud-flag.js. No theme caller exists yet; this route is not
// live to any customer traffic.

const { gate } = require('../../lib/studio-cloud-auth');
const { isStudioCloudProjectsWritesEnabled } = require('../../lib/studio-cloud-flag');
const { checkRateLimit } = require('../../lib/rate-limit');
const { checkStudioCloudCapability } = require('../../lib/studio-cloud-entitlement');
const { validateProjectInput, ValidationError } = require('../../lib/validation/project-fields');
const { serializeProject } = require('../../lib/studio-cloud-serialize');
const { createProjectsRepo } = require('../../lib/repositories/projects-repo');

const projectsRepo = createProjectsRepo();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

async function handleGet(req, res, customerId) {
  const cap = await checkStudioCloudCapability(customerId, 'read');
  if (!cap.allowed) {
    // Reads are never gated -- this branch is unreachable today, kept only
    // so a future change to checkStudioCloudCapability can't silently start
    // blocking reads without this route also needing an update.
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }

  const { id } = req.query;
  if (id !== undefined) {
    if (!isValidId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const project = await projectsRepo.getProjectForCustomer(customerId, id);
    if (!project) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ project: serializeProject(project) });
    return;
  }

  const projects = await projectsRepo.listProjectsForCustomer(customerId);
  res.status(200).json({ projects: projects.map(serializeProject) });
}

async function handleCreate(req, res, customerId, body) {
  const cap = await checkStudioCloudCapability(customerId, 'create');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }
  let fields;
  try {
    fields = validateProjectInput(body, { partial: false });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: 'invalid_request', field: err.field, message: err.message });
      return;
    }
    throw err;
  }
  const row = await projectsRepo.createProject(customerId, fields);
  res.status(200).json({ project: serializeProject(row) });
}

async function handleEdit(req, res, customerId, body) {
  const cap = await checkStudioCloudCapability(customerId, 'edit');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }
  const { id, version } = body;
  if (!isValidId(id) || typeof version !== 'number') {
    res.status(400).json({ error: 'invalid_request', message: 'id and version are required.' });
    return;
  }
  let patch;
  try {
    patch = validateProjectInput(body, { partial: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: 'invalid_request', field: err.field, message: err.message });
      return;
    }
    throw err;
  }
  const result = await projectsRepo.updateProjectForCustomer(customerId, id, patch, version);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'version_conflict') {
    res.status(409).json({ error: 'version_conflict', current: serializeProject(result.current) });
    return;
  }
  res.status(200).json({ project: serializeProject(result.row) });
}

async function handleAttach(req, res, customerId, body) {
  // "attach" is Mood Board / Space Plan data being written onto an existing
  // Project -- same entitlement class and same code path as an edit, kept
  // as a distinct `op` value only because Phase 5B's contract names it
  // separately from a general field edit.
  await handleEdit(req, res, customerId, body);
}

async function handleAssign(req, res, customerId, body) {
  const cap = await checkStudioCloudCapability(customerId, 'assign');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }
  const { id, homeId, version } = body;
  if (!isValidId(id) || typeof version !== 'number') {
    res.status(400).json({ error: 'invalid_request', message: 'id and version are required.' });
    return;
  }
  if (homeId !== null && !isValidId(homeId)) {
    res.status(400).json({ error: 'invalid_request', message: 'homeId must be a UUID or null.' });
    return;
  }
  const result = await projectsRepo.assignProjectHome(customerId, id, homeId === undefined ? null : homeId, version);
  if (result.status === 'home_not_found') {
    // The target home doesn't exist for this customer -- 404, not 403, per
    // the same never-distinguish-ownership rule as everything else here.
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'version_conflict') {
    res.status(409).json({ error: 'version_conflict', current: serializeProject(result.current) });
    return;
  }
  res.status(200).json({ project: serializeProject(result.row) });
}

async function handleDelete(req, res, customerId, body) {
  // Owner delete is ALWAYS allowed regardless of tier -- Phase 5C Amendment 2.
  const cap = await checkStudioCloudCapability(customerId, 'delete');
  if (!cap.allowed) {
    // Unreachable today (delete is never denied), kept for the same reason
    // as the read branch above.
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }
  const { id, version } = body;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'invalid_request', message: 'id is required.' });
    return;
  }
  const result = await projectsRepo.softDeleteProjectForCustomer(customerId, id, version);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'version_conflict') {
    res.status(409).json({ error: 'version_conflict', current: serializeProject(result.current) });
    return;
  }
  res.status(200).json({ deleted: true });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'proxy_projects');
  if (!allowed) {
    res.status(429).json({ error: 'Too many requests. Please try again shortly.' });
    return;
  }

  const gated = gate(req, res);
  if (!gated.ok) return;
  const { customerId } = gated;

  try {
    if (req.method === 'GET') {
      await handleGet(req, res, customerId);
      return;
    }

    // Phase 5D.2B: every POST op on this route is a mutation (create, edit,
    // attach, assign, delete). Gate them all here, in one place, before
    // dispatch -- so a write-rollout-off request never reaches entitlement
    // (checkStudioCloudCapability) or the repositories (Postgres) below.
    // Same fail-closed, non-disclosing response shape as the master flag in
    // lib/studio-cloud-auth.js's gate(): a real caller cannot tell "writes
    // disabled" apart from "route does not exist."
    if (!isStudioCloudProjectsWritesEnabled()) {
      res.status(404).json({ error: 'not_found' });
      return;
    }

    const body = req.body || {};
    switch (body.op) {
      case 'create':
        await handleCreate(req, res, customerId, body);
        return;
      case 'edit':
        await handleEdit(req, res, customerId, body);
        return;
      case 'attach':
        await handleAttach(req, res, customerId, body);
        return;
      case 'assign':
        await handleAssign(req, res, customerId, body);
        return;
      case 'delete':
        await handleDelete(req, res, customerId, body);
        return;
      default:
        res.status(400).json({ error: 'invalid_request', message: 'op must be one of: create, edit, attach, assign, delete.' });
        return;
    }
  } catch (err) {
    console.error('proxy projects route failed', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
