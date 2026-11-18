/**
 * B2B module configuration — everything comes from environment variables.
 */
const os = require('os');
const path = require('path');

function enabled() {
  return String(process.env.B2B_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Private storage for uploaded KYC documents and import files. Deliberately
 * OUTSIDE the repository and outside the web root: files here are never
 * served statically and survive every GitHub redeploy.
 */
function privateDir() {
  return process.env.B2B_PRIVATE_DIR
    ? path.resolve(process.env.B2B_PRIVATE_DIR)
    : path.join(os.homedir(), 'sakeofhealth-private');
}

/** Production secrets: 48+ characters and never shared with another audience (Phase 1.1, correction 1). */
const MIN_PROD_SECRET = 48;
function prodSecretProblem(s) {
  if (!s) return 'B2B_JWT_SECRET is not set';
  if (s.length < MIN_PROD_SECRET) return 'B2B_JWT_SECRET must be at least ' + MIN_PROD_SECRET + ' random characters';
  if (s === process.env.ADMIN_JWT_SECRET || s === process.env.CUSTOMER_JWT_SECRET) return 'B2B_JWT_SECRET must differ from the admin and customer secrets';
  return null;
}

function tokenSecret() {
  const s = process.env.B2B_JWT_SECRET || process.env.JWT_SECRET;
  if (process.env.NODE_ENV === 'production') {
    // No derivation from, or fallback to, another secret in production.
    const problem = prodSecretProblem(s);
    if (problem) throw new Error(problem);
    return s;
  }
  if (s) return s;
  if (process.env.ADMIN_JWT_SECRET) return process.env.ADMIN_JWT_SECRET + ':b2b-portal';   // development only
  return 'dev-insecure-b2b-secret-change-me';   // local development and tests only
}

function hasStrongSecret() {
  const s = process.env.B2B_JWT_SECRET || process.env.JWT_SECRET || '';
  if (process.env.NODE_ENV === 'production') return prodSecretProblem(s) === null;
  return (s || process.env.ADMIN_JWT_SECRET || '').length >= 24;
}

module.exports = {
  enabled, privateDir, tokenSecret, hasStrongSecret,
  sessionHours: () => Number(process.env.B2B_SESSION_HOURS || 72),
  maxUploadBytes: () => Number(process.env.B2B_MAX_UPLOAD_MB || 5) * 1024 * 1024,
  maxImportBytes: () => Number(process.env.B2B_MAX_IMPORT_MB || 15) * 1024 * 1024,
  autoMigrate: () => String(process.env.DB_AUTO_MIGRATE || 'false').toLowerCase() === 'true',
  siteUrl: () => (process.env.PUBLIC_SITE_URL || process.env.SITE_URL || '').replace(/\/$/, ''),
  appVersion: () => { try { return require('../../../package.json').version; } catch (e) { return '0'; } },
};
