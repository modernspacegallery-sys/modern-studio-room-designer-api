// Entitlement rules for the Projects/Homes cloud API, per Phase 5C's
// mandatory Amendment 2. This is intentionally a thin wrapper around the
// existing lib/entitlement.js (unchanged) rather than a new entitlement
// system -- the only new logic is which capabilities each tier gets.
//
// Rule (Amendment 2, "Guiding rule"): reads of a customer's own data are
// NEVER gated by current tier. Only mutations are -- and even then, DELETE
// is carved out as always-allowed for the owner, so a lapsed subscriber can
// always get their data or remove it, never neither.
//
//   Signed-in active AI+                 : read, create, edit, attach,
//                                           import, assign/unassign, delete
//   Signed-in free/lapsed w/ existing data: read, delete only
//
// Entitlement-service failure handling: lib/entitlement.js already fails
// closed to `{ tier: 'free' }` on any error (see its own header comment).
// Because this module's write gate is "must be ai_plus," a failed lookup
// naturally denies AI+-required writes without any new code -- and because
// reads/deletes never call getEntitlement at all, a Shopify outage cannot
// block a customer from reading or deleting their own rows. This file exists
// to make that guarantee explicit and testable in one place, rather than
// leaving each route to reimplement the same reasoning.

const { getEntitlement } = require('./entitlement');

const WRITE_OPERATIONS = new Set(['create', 'edit', 'attach', 'import', 'assign']);

// Phase 5D controlled test override.
//
// This is intentionally scoped ONLY to Studio Cloud Projects/Homes mutations.
// It does not alter the broader Môdern Studio AI+ entitlement system,
// subscription billing, credits, or other AI+ features.
//
// Customer IDs are supplied through a Vercel environment variable rather
// than hard-coded in source control:
//
// STUDIO_CLOUD_AI_PLUS_TEST_CUSTOMER_IDS=1234567890,0987654321
//
// If the variable is absent or empty, this override grants access to nobody.
const AI_PLUS_TEST_CUSTOMER_IDS = new Set(
  (process.env.STUDIO_CLOUD_AI_PLUS_TEST_CUSTOMER_IDS || '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
);

/**
 * @param {string} customerId - verified Shopify customer ID
 * @param {string} operation - one of 'read', 'delete', 'create', 'edit', 'attach', 'import', 'assign'
 * @returns {Promise<{ allowed: boolean, tier: 'free'|'ai_plus'|null }>}
 */
async function checkStudioCloudCapability(customerId, operation) {
  if (operation === 'read' || operation === 'delete') {
    // Never gated by entitlement -- do not even call getEntitlement, so an
    // entitlement-service outage cannot affect this path at all.
    return { allowed: true, tier: null };
  }

  if (!WRITE_OPERATIONS.has(operation)) {
    throw new Error(`Unknown studio cloud operation: ${operation}`);
  }

  // Controlled Phase 5D test-account override.
  // Applies only to Studio Cloud write operations handled by this module.
  if (AI_PLUS_TEST_CUSTOMER_IDS.has(String(customerId))) {
    return { allowed: true, tier: 'ai_plus' };
  }

  const { tier } = await getEntitlement(customerId);
  return { allowed: tier === 'ai_plus', tier };
}

module.exports = {
  checkStudioCloudCapability,
  WRITE_OPERATIONS,
};
