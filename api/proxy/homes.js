// GET /api/proxy/homes  -- list, or fetch a single Home by id
// POST /api/proxy/homes -- create / edit / delete (dispatched by `op`, same
// flat-route convention as api/proxy/projects.js -- see that file's header
// for why).
//
// Behind STUDIO_CLOUD_PROJECTS_ENABLED; not live to any theme caller yet.

const { gate } = require('../../lib/studio-cloud-auth');
const { checkRateLimit } = require('../../lib/rate-limit');
const { checkStudioCloudCapability } = require('../../lib/studio-cloud-entitlement');
const { validateHomeInput, ValidationError } = require('../../lib/validation/project-fields');
const { serializeHome } = require('../../lib/studio-cloud-serialize');
const { createHomesRepo } = require('../../lib/repositories/homes-repo');

const homesRepo = createHomesRepo();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidId(id) {
  return typeof id === 'string' && UUID_RE.test(id);
}

async function handleGet(req, res, customerId) {
  const { id } = req.query;
  if (id !== undefined) {
    if (!isValidId(id)) {
      res.status(400).json({ error: 'invalid_id' });
      return;
    }
    const home = await homesRepo.getHomeForCustomer(customerId, id);
    if (!home) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    res.status(200).json({ home: serializeHome(home) });
    return;
  }
  const homes = await homesRepo.listHomesForCustomer(customerId);
  res.status(200).json({ homes: homes.map(serializeHome) });
}

async function handleCreate(req, res, customerId, body) {
  const cap = await checkStudioCloudCapability(customerId, 'create');
  if (!cap.allowed) {
    res.status(403).json({ error: 'ai_plus_required' });
    return;
  }
  let fields;
  try {
    fields = validateHomeInput(body, { partial: false });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: 'invalid_request', field: err.field, message: err.message });
      return;
    }
    throw err;
  }
  const row = await homesRepo.createHome(customerId, fields);
  res.status(200).json({ home: serializeHome(row) });
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
    patch = validateHomeInput(body, { partial: true });
  } catch (err) {
    if (err instanceof ValidationError) {
      res.status(400).json({ error: 'invalid_request', field: err.field, message: err.message });
      return;
    }
    throw err;
  }
  const result = await homesRepo.updateHomeForCustomer(customerId, id, patch, version);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'version_conflict') {
    res.status(409).json({ error: 'version_conflict', current: serializeHome(result.current) });
    return;
  }
  res.status(200).json({ home: serializeHome(result.row) });
}

async function handleDelete(req, res, customerId, body) {
  // Owner delete always allowed regardless of tier -- Amendment 2.
  const { id, version } = body;
  if (!isValidId(id)) {
    res.status(400).json({ error: 'invalid_request', message: 'id is required.' });
    return;
  }
  const result = await homesRepo.softDeleteHomeForCustomer(customerId, id, version);
  if (result.status === 'not_found') {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  if (result.status === 'version_conflict') {
    res.status(409).json({ error: 'version_conflict', current: serializeHome(result.current) });
    return;
  }
  res.status(200).json({ deleted: true });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  const allowed = await checkRateLimit(req, 'proxy_homes');
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

    const body = req.body || {};
    switch (body.op) {
      case 'create':
        await handleCreate(req, res, customerId, body);
        return;
      case 'edit':
        await handleEdit(req, res, customerId, body);
        return;
      case 'delete':
        await handleDelete(req, res, customerId, body);
        return;
      default:
        res.status(400).json({ error: 'invalid_request', message: 'op must be one of: create, edit, delete.' });
        return;
    }
  } catch (err) {
    console.error('proxy homes route failed', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
