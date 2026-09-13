// Dark-launch feature flag for the Projects/Homes cloud API (Phase 5C
// Section 10). Missing/unset MUST fail closed -- the flag's absence means
// "off," never "on by default." This is the only gate standing between this
// phase's routes and real traffic once deployed, since no theme caller is
// wired to them yet.

function isStudioCloudProjectsEnabled() {
  return process.env.STUDIO_CLOUD_PROJECTS_ENABLED === 'true';
}

// Phase 5D.2B: a second, independent rollout control layered on top of the
// flag above. STUDIO_CLOUD_PROJECTS_ENABLED remains the master route/read
// gate -- when it is off, nothing below this ever runs, exactly as before.
// When it is on, this second flag decides whether MUTATIONS (create, edit,
// attach, assign, delete, import) are allowed to proceed, independent of
// entitlement tier -- it exists to let reads go live for verification while
// every write path stays fail-closed. Same fail-closed contract as the
// master flag: absent, or any value other than the literal string "true",
// means off.
function isStudioCloudProjectsWritesEnabled() {
  return process.env.STUDIO_CLOUD_PROJECTS_WRITES_ENABLED === 'true';
}

module.exports = { isStudioCloudProjectsEnabled, isStudioCloudProjectsWritesEnabled };
