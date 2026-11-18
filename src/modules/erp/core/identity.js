/**
 * ERP staff identity: login (password + TOTP when enabled), lockout, and the
 * per-request principal. The token only says WHO; roles, permissions, scopes and
 * status are re-read from MySQL on every request, so revoking a role, disabling a
 * person or changing a password takes effect on their next request.
 * This identity is separate from the B2C admin login (staff.json is never read).
 */
'use strict';
const crypto = require('crypto');
const db = require('../../../db/connection.js');
const security = require('./security.js');
const config = require('../config.js');
const audit = require('./audit.js');
const monitor = require('./monitor.js');
const mustChange = require('../../../db/mustChange.js');

function fail(status, message, code) { return Object.assign(new Error(message), { status: status, expose: true, code: code }); }

/** Permissions that need a second factor (match the API spec's MFA rule). */
const MFA_SUFFIX = ['.approve', '.decide', '.publish', '.pay', 'roles.edit', 'settings.edit', '.activate', '.close', '.award'];
function needsMfa(permission) { return MFA_SUFFIX.some(function (s) { return permission.endsWith(s); }); }

/**
 * @param {object} [opts]
 *   countFailure (default true) — false only when the central sign-in (/login)
 *   already accepted this password for another of the person's accounts: a
 *   mismatch with their ERP password is then not a guessing attempt and must
 *   not lock their ERP account. Wrong-everywhere attempts are always counted.
 */
async function login(email, password, totp, ctx, opts) {
  const count = !(opts && opts.countFailure === false);
  email = String(email || '').trim().toLowerCase();
  const generic = fail(401, 'Invalid email or password', 'bad_credentials');
  if (!email || !password) throw generic;
  const s = await db.queryOne('SELECT * FROM b2b_staff WHERE email = ?', [email]);
  if (!s) { security.burnTime(password); if (count) await monitor.event('auth', 'warning', 'erp_login_unknown', 'Login for unknown e-mail', { ip: ctx.ip }); throw generic; }
  if (s.status !== 'active') { security.burnTime(password); throw generic; }
  if (s.locked_until && new Date(s.locked_until).getTime() > Date.now()) {
    throw fail(423, 'Too many failed attempts. Try again in ' + config.lockMinutes() + ' minutes.', 'locked');
  }
  const okPassword = security.verifyPassword(password, s.password_hash);
  let okTotp = true;
  if (okPassword && Number(s.mfa_enabled) === 1) {
    const secret = security.decrypt(s.mfa_secret_enc);
    okTotp = !!secret && security.verifyTotp(secret, totp);
    if (!totp) throw fail(401, 'Enter the 6-digit code from your authenticator app', 'mfa_required');
  }
  if (!okPassword || !okTotp) {
    // A wrong 6-digit code after a correct password is ALWAYS counted (guessing codes).
    if (!count && !okPassword) throw generic;
    await db.query(
      // MySQL evaluates SET left to right: compute the lock from the OLD count first.
      'UPDATE b2b_staff SET locked_until = IF(failed_logins + 1 >= ?, UTC_TIMESTAMP() + INTERVAL ? MINUTE, locked_until), ' +
      'failed_logins = failed_logins + 1 WHERE id = ?',
      [config.maxFailedLogins(), config.lockMinutes(), s.id]);
    await monitor.event('auth', 'warning', okPassword ? 'erp_mfa_failed' : 'erp_login_failed', 'Failed login', { actorType: 'staff', actorId: s.id, ip: ctx.ip });
    throw generic;
  }
  await db.query('UPDATE b2b_staff SET failed_logins = 0, locked_until = NULL, last_login_at = UTC_TIMESTAMP() WHERE id = ?', [s.id]);
  const sessionId = crypto.randomBytes(12).toString('hex');
  await audit.write(null, { type: 'staff', id: s.id, label: s.email, role: 'login', ip: ctx.ip, sessionId: sessionId, userAgent: ctx.userAgent },
    { module: 'core', action: 'staff.login', entity: 'staff', entityId: s.id });
  return { token: security.sign({ sid: Number(s.id), tv: Number(s.token_version), mfa: Number(s.mfa_enabled) === 1, ses: sessionId }), staff: { id: Number(s.id), name: s.name, email: s.email },
    mustChangePassword: Number(s.must_change_password) === 1 };
}

/** Loads the principal: active staff, current token_version, live roles → permissions → scopes. */
async function principal(payload) {
  if (!payload || !payload.sid) return null;
  const s = await db.queryOne('SELECT id, name, email, status, token_version, mfa_enabled FROM b2b_staff WHERE id = ?', [payload.sid]);
  if (!s || s.status !== 'active' || Number(s.token_version) !== Number(payload.tv)) return null;
  const grants = await db.query(
    'SELECT r.code AS role, sr.scope_type, sr.scope_id FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id ' +
    'WHERE sr.staff_id = ? AND sr.revoked_at IS NULL AND r.is_active = 1', [s.id]);
  const perms = grants.length ? await db.query(
    'SELECT DISTINCT rp.permission_code AS p FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id ' +
    'JOIN b2b_role_permissions rp ON rp.role_id = r.id WHERE sr.staff_id = ? AND sr.revoked_at IS NULL AND r.is_active = 1', [s.id]) : [];
  const scopes = {};
  grants.forEach(function (g) {
    const dim = g.scope_type;
    if (dim === 'all') { scopes.territory = 'all'; scopes.warehouse = 'all'; scopes.state = 'all'; return; }
    if (scopes[dim] === 'all') return;
    (scopes[dim] = scopes[dim] || []).push(Number(g.scope_id));
  });
  return {
    kind: 'staff', id: Number(s.id), name: s.name, email: s.email,
    roles: Array.from(new Set(grants.map(function (g) { return g.role; }))),
    permissions: new Set(perms.map(function (r) { return r.p; })), scopes: scopes,
    mfa: !!payload.mfa && Number(s.mfa_enabled) === 1, sessionId: payload.ses || null,
    mustChangePassword: await mustChange.get('staff', s.id),
  };
}

function tokenFrom(req) {
  const a = req.headers['authorization'] || '';
  return a.startsWith('Bearer ') ? a.slice(7) : '';   // header only: tokens never travel in URLs
}

/** Express middleware: any signed-in ERP staff member. */
function requireStaff(req, res, next) {
  const payload = security.verify(tokenFrom(req));
  if (!payload) return res.status(401).json({ error: 'Please log in to continue' });
  principal(payload).then(function (p) {
    if (!p) return res.status(401).json({ error: 'Your session has ended. Please log in again.' });
    // A temporary password must be replaced first: only "who am I" and "change my password" work.
    if (p.mustChangePassword && !/\/me(\/password)?$/.test(req.path)) return res.status(403).json(mustChange.REQUIRED);
    req.erp = p; next();
  }).catch(next);
}

/** Express middleware: permission (and MFA when the permission is sensitive). */
function can(permission, opts) {
  opts = opts || {};
  return function (req, res, next) {
    const p = req.erp;
    if (!p) return res.status(401).json({ error: 'Please log in to continue' });
    if (!p.permissions.has(permission)) return res.status(403).json({ error: 'You do not have permission to do that', required: permission });
    if ((opts.mfa || needsMfa(permission)) && !p.mfa) return res.status(403).json({ error: 'This action needs two-factor sign-in. Turn on MFA and log in again.', code: 'mfa_required' });
    next();
  };
}

/** Ends every session of a staff member (deactivation, password change, role change). */
async function revokeSessions(tx, staffId) {
  await (tx || db).query('UPDATE b2b_staff SET token_version = token_version + 1 WHERE id = ?', [staffId]);
}

module.exports = { login, principal, requireStaff, can, needsMfa, revokeSessions, tokenFrom };
