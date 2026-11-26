// Committed config for the CreatorDigest test page.
// The Production client-side environment key is public by design: Flagsmith client keys ship to
// every browser that loads a page. It cannot change flags; the Admin API token is never here.
// For local runs, site/config.local.js (git-ignored) overrides this with the Development key.
export const FLAGSMITH_ENVIRONMENT_KEY = 'ak4YXxCgLeaDDk6rY4wunj';
export const FLAGSMITH_ENVIRONMENT_NAME = 'Production';
export const FLAG_KEY = 'pilot_rehearsal_1';
