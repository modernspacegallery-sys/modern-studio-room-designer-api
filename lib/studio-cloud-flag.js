// Dark-launch feature flag for the Projects/Homes cloud API (Phase 5C
// Section 10). Missing/unset MUST fail closed -- the flag's absence means
// "off," never "on by default." This is the only gate standing between this
// phase's routes and real traffic once deployed, since no theme caller is
// wired to them yet.

function isStudioCloudProjectsEnabled() {
  return process.env.STUDIO_CLOUD_PROJECTS_ENABLED === 'true';
}

module.exports = { isStudioCloudProjectsEnabled };
