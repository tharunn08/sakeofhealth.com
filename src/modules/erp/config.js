/**
 * Business-platform (ERP) configuration. Everything comes from environment
 * variables. The ERP only exists when BOTH B2B_ENABLED and ERP_ENABLED are true;
 * with either off there is no ERP route, timer or database call.
 */
'use strict';

function enabled() {
  return String(process.env.B2B_ENABLED || 'false').toLowerCase() === 'true' &&
    String(process.env.ERP_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * ERP staff tokens use their own secret: B2C admin, B2B portal and ERP tokens can never be swapped.
 * Production: 48+ characters and different from every other audience's secret (Phase 1.1,
 * correction 1). Development/test keep the existing 32-character rule.
 */
const MIN_PROD_SECRET = 48;
function prodSecretProblem(s) {
  if (s.length < MIN_PROD_SECRET) return 'ERP_JWT_SECRET must be set (at least ' + MIN_PROD_SECRET + ' random characters)';
  if ([process.env.ADMIN_JWT_SECRET, process.env.CUSTOMER_JWT_SECRET, process.env.B2B_JWT_SECRET, process.env.JWT_SECRET].indexOf(s) !== -1) {
    return 'ERP_JWT_SECRET must differ from the admin, customer and B2B secrets';
  }
  return null;
}

function tokenSecret() {
  const s = process.env.ERP_JWT_SECRET || '';
  if (process.env.NODE_ENV === 'production') {
    const problem = prodSecretProblem(s);
    if (problem) throw new Error(problem);
    return s;
  }
  if (s.length >= 32) return s;
  return 'dev-only-erp-secret-not-for-production-use';
}

function hasStrongSecret() {
  const s = String(process.env.ERP_JWT_SECRET || '');
  return process.env.NODE_ENV === 'production' ? prodSecretProblem(s) === null : s.length >= 32;
}

module.exports = {
  enabled, tokenSecret, hasStrongSecret,
  sessionHours: function () { return Math.min(24, Math.max(1, Number(process.env.ERP_SESSION_HOURS || 8))); },
  idleMinutes: function () { return Math.max(5, Number(process.env.ERP_IDLE_MINUTES || 60)); },
  /**
   * Two-step sign-in (TOTP). true (default): sign-in asks enrolled staff for the 6-digit code, and
   * approvals and sensitive actions need it. ERP_MFA_REQUIRED=false switches it off for everyone:
   * no code is asked at sign-in and no action requires it. The owner's decision; it weakens security.
   */
  mfaRequired: function () { return String(process.env.ERP_MFA_REQUIRED || 'true').trim().toLowerCase() !== 'false'; },
  maxFailedLogins: function () { return 5; },
  lockMinutes: function () { return 15; },
  workerIntervalMs: function () { return Math.max(5000, Number(process.env.ERP_WORKER_INTERVAL_MS || 30000)); },
  whatsappAppSecret: function () { return process.env.WHATSAPP_APP_SECRET || ''; },
  whatsappVerifyToken: function () { return process.env.WHATSAPP_VERIFY_TOKEN || ''; },
};
