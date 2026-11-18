/**
 * Staff, roles and grants. Reducing access (disable, revoke) is immediate and
 * ends sessions. Increasing access (granting a role, changing a role's
 * permissions) goes through an approval by someone else.
 */
'use strict';
const { posId } = require('../lib/http.js');
const db = require('../../../db/connection.js');
const security = require('./security.js');
const audit = require('./audit.js');
const approvals = require('./approvals.js');
const identity = require('./identity.js');

function fail(status, msg) { return Object.assign(new Error(msg), { status: status, expose: true }); }
const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,180}\.[^@\s]{2,}$/;

async function list(q) {
  const where = ['1=1'], params = [];
  if (q.status) { where.push('s.status = ?'); params.push(String(q.status)); }
  if (q.q) { where.push('(s.name LIKE ? OR s.email LIKE ?)'); const t = '%' + String(q.q).replace(/[\\%_]/g, '\\$&').slice(0, 80) + '%'; params.push(t, t); }
  const limit = db.int(q.limit, 25, 1, 100), after = db.int(q.after, 0, 0, Number.MAX_SAFE_INTEGER);
  if (after) { where.push('s.id > ?'); params.push(after); }
  const rows = await db.query(
    'SELECT s.id, s.name, s.email, s.mobile, s.status, s.mfa_enabled, s.last_login_at, ' +
    "(SELECT GROUP_CONCAT(r.code ORDER BY r.code) FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id WHERE sr.staff_id = s.id AND sr.revoked_at IS NULL) AS roles " +
    'FROM b2b_staff s WHERE ' + where.join(' AND ') + ' ORDER BY s.id LIMIT ' + limit, params);
  return { items: rows.map(function (r) { return Object.assign({}, r, { roles: r.roles ? r.roles.split(',') : [], mfa_enabled: !!Number(r.mfa_enabled) }); }),
    next: rows.length === limit ? Number(rows[rows.length - 1].id) : null };
}

async function create(tx, actor, b) {
  const name = String(b.name || '').trim().slice(0, 120), email = String(b.email || '').trim().toLowerCase();
  if (!name) throw fail(400, 'Name is required');
  if (!EMAIL.test(email)) throw fail(400, 'A valid e-mail is required');
  const mobile = b.mobile ? String(b.mobile).replace(/\D/g, '') : null;
  if (mobile && !/^[6-9]\d{9}$/.test(mobile)) throw fail(400, 'Mobile must be a 10-digit Indian number');
  const hash = security.hashPassword(b.password);
  let r;
  try {
    r = await tx.query('INSERT INTO b2b_staff (name, email, mobile, password_hash, created_by) VALUES (?, ?, ?, ?, ?)', [name, email, mobile, hash, actor.id]);
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A staff member with this e-mail already exists'); throw e; }
  await audit.write(tx, actor, { module: 'core', action: 'staff.created', entity: 'staff', entityId: r.insertId, new: { name: name, email: email, mobile: mobile } });
  return { id: r.insertId };
}

async function update(tx, actor, id, b) {
  const s = await tx.queryOne('SELECT id, name, mobile, status FROM b2b_staff WHERE id = ? FOR UPDATE', [id]);
  if (!s) throw fail(404, 'Not found');
  const next = { name: b.name != null ? String(b.name).trim().slice(0, 120) : s.name, mobile: b.mobile !== undefined ? (b.mobile ? String(b.mobile).replace(/\D/g, '') : null) : s.mobile,
    status: b.status != null ? String(b.status) : s.status };
  if (['active', 'disabled'].indexOf(next.status) === -1) throw fail(400, 'Status must be active or disabled');
  if (next.mobile && !/^[6-9]\d{9}$/.test(next.mobile)) throw fail(400, 'Mobile must be a 10-digit Indian number');
  if (Number(id) === Number(actor.id) && next.status === 'disabled') throw fail(400, 'You cannot disable yourself');
  if (next.status === 'active' && s.status === 'disabled') {
    // Re-activation restores access: it needs approval like any grant.
    return approvals.request(tx, actor, { type: 'core.staff_reactivate', entity: 'staff', entityId: id, reason: b.reason || '', payload: { name: next.name, mobile: next.mobile } });
  }
  await tx.query('UPDATE b2b_staff SET name = ?, mobile = ?, status = ? WHERE id = ?', [next.name, next.mobile, next.status, id]);
  if (next.status === 'disabled' && s.status !== 'disabled') await identity.revokeSessions(tx, id);
  await audit.write(tx, actor, { module: 'core', action: next.status !== s.status ? 'staff.' + next.status : 'staff.updated', entity: 'staff', entityId: id,
    old: { name: s.name, mobile: s.mobile, status: s.status }, new: next, reason: b.reason });
  return { id: Number(id), status: next.status };
}
approvals.register('core.staff_reactivate', async function (tx, req, actor) {
  await tx.query("UPDATE b2b_staff SET status = 'active', name = ?, mobile = ?, failed_logins = 0, locked_until = NULL WHERE id = ?", [req.data.name, req.data.mobile, req.entityId]);
  await audit.write(tx, actor, { module: 'core', action: 'staff.reactivated', entity: 'staff', entityId: req.entityId, approvalId: req.id });
  return { id: req.entityId, status: 'active' };
});

async function changeOwnPassword(tx, principal, actor, oldPw, newPw) {
  const s = await tx.queryOne('SELECT password_hash FROM b2b_staff WHERE id = ? FOR UPDATE', [principal.id]);
  if (!security.verifyPassword(oldPw, s.password_hash)) throw fail(400, 'Current password is not correct');
  if (String(newPw) === String(oldPw)) throw fail(400, 'Choose a new password');
  await tx.query('UPDATE b2b_staff SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [security.hashPassword(newPw), principal.id]);
  await require('../../../db/mustChange.js').clear('staff', principal.id, tx);
  await audit.write(tx, actor, { module: 'core', action: 'staff.password_changed', entity: 'staff', entityId: principal.id });
  return { ok: true, reLogin: true };
}

// ── MFA enrolment ──
async function mfaSetup(principal) {
  const secret = security.newTotpSecret();
  await db.query('UPDATE b2b_staff SET mfa_secret_enc = ? WHERE id = ? AND mfa_enabled = 0', [security.encrypt(secret), principal.id]);
  const issuer = encodeURIComponent(process.env.BRAND_NAME || 'Sake of Health');
  return { secret: secret, otpauth: 'otpauth://totp/' + issuer + ':' + encodeURIComponent(principal.email) + '?secret=' + secret + '&issuer=' + issuer + '&digits=6&period=30' };
}
async function mfaEnable(tx, principal, actor, code) {
  const s = await tx.queryOne('SELECT mfa_secret_enc, mfa_enabled FROM b2b_staff WHERE id = ? FOR UPDATE', [principal.id]);
  if (Number(s.mfa_enabled) === 1) throw fail(409, 'Two-factor sign-in is already on');
  const secret = security.decrypt(s.mfa_secret_enc);
  if (!secret || !security.verifyTotp(secret, code)) throw fail(400, 'That code is not correct. Check the time on your phone and try again.');
  await tx.query('UPDATE b2b_staff SET mfa_enabled = 1, token_version = token_version + 1 WHERE id = ?', [principal.id]);
  await audit.write(tx, actor, { module: 'core', action: 'staff.mfa_enabled', entity: 'staff', entityId: principal.id });
  return { ok: true, reLogin: true };
}

// ── Roles ──
async function roles() {
  const rs = await db.query('SELECT id, code, name, description, is_system, is_active FROM b2b_roles ORDER BY is_system DESC, name');
  const ps = await db.query('SELECT role_id, permission_code FROM b2b_role_permissions');
  return rs.map(function (r) { return Object.assign({}, r, { permissions: ps.filter(function (p) { return Number(p.role_id) === Number(r.id); }).map(function (p) { return p.permission_code; }) }); });
}

async function createRole(tx, actor, b) {
  const code = 'custom_' + String(b.code || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 32);
  if (code === 'custom_') throw fail(400, 'A role code is required (letters, digits, _)');
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) throw fail(400, 'A role name is required');
  let r;
  try { r = await tx.query('INSERT INTO b2b_roles (code, name, description, is_system) VALUES (?, ?, ?, 0)', [code, name, b.description ? String(b.description).slice(0, 255) : null]); }
  catch (e) { if (e.code === 'ER_DUP_ENTRY') throw fail(409, 'A role with this code exists'); throw e; }
  await audit.write(tx, actor, { module: 'core', action: 'role.created', entity: 'role', entityId: r.insertId, new: { code: code, name: name } });
  // A new role starts with NO permissions; adding them is an approved change.
  return { id: r.insertId, code: code };
}

async function requestRolePermissions(tx, actor, roleId, codes, reason) {
  const role = await tx.queryOne('SELECT id, code, is_system FROM b2b_roles WHERE id = ?', [roleId]);
  if (!role) throw fail(404, 'Not found');
  if (!Array.isArray(codes)) throw fail(400, 'permissions must be a list');
  const known = await tx.query('SELECT code FROM b2b_permissions');
  const set = new Set(known.map(function (k) { return k.code; }));
  const bad = codes.filter(function (c) { return !set.has(c); });
  if (bad.length) throw fail(400, 'Unknown permissions: ' + bad.slice(0, 5).join(', '));
  const current = (await tx.query('SELECT permission_code FROM b2b_role_permissions WHERE role_id = ?', [roleId])).map(function (r) { return r.permission_code; });
  return approvals.request(tx, actor, { type: 'core.role_permissions', entity: 'role', entityId: roleId, reason: reason,
    payload: { role: role.code, permissions: Array.from(new Set(codes)).sort(), previous: current.sort() } });
}
approvals.register('core.role_permissions', async function (tx, req, actor) {
  const want = new Set(req.data.permissions);
  const have = (await tx.query('SELECT permission_code FROM b2b_role_permissions WHERE role_id = ?', [req.entityId])).map(function (r) { return r.permission_code; });
  const add = req.data.permissions.filter(function (p) { return have.indexOf(p) === -1; });
  const remove = have.filter(function (p) { return !want.has(p); });
  for (const p of add) await tx.query('INSERT IGNORE INTO b2b_role_permissions (role_id, permission_code) VALUES (?, ?)', [req.entityId, p]);
  // Removing a permission from a role is the one deletion the platform performs: it is a
  // link row, the change is approved, and the before/after lists are in the audit row.
  for (const p of remove) await tx.query('DELETE FROM b2b_role_permissions WHERE role_id = ? AND permission_code = ?', [req.entityId, p]);
  const holders = await tx.query('SELECT DISTINCT staff_id FROM b2b_staff_roles WHERE role_id = ? AND revoked_at IS NULL', [req.entityId]);
  for (const h of holders) await identity.revokeSessions(tx, h.staff_id);
  await audit.write(tx, actor, { module: 'core', action: 'role.permissions_changed', entity: 'role', entityId: req.entityId,
    old: req.data.previous, new: req.data.permissions, approvalId: req.id });
  return { added: add.length, removed: remove.length, sessionsEnded: holders.length };
});

const SCOPES = ['all', 'territory', 'warehouse', 'state'];
async function requestGrant(tx, actor, staffId, b) {
  const role = await tx.queryOne('SELECT id, code FROM b2b_roles WHERE id = ? AND is_active = 1', [b.roleId]);
  if (!role) throw fail(404, 'Role not found');
  const s = await tx.queryOne("SELECT id FROM b2b_staff WHERE id = ? AND status = 'active'", [staffId]);
  if (!s) throw fail(404, 'Staff member not found or disabled');
  const scopeType = b.scopeType || 'all';
  if (SCOPES.indexOf(scopeType) === -1) throw fail(400, 'Scope must be one of ' + SCOPES.join(', '));
  const scopeId = scopeType === 'all' ? null : posId(b.scopeId);
  if (scopeType !== 'all' && !scopeId) throw fail(400, 'scopeId is required for a ' + scopeType + ' scope');
  return approvals.request(tx, actor, { type: 'core.role_grant', entity: 'staff', entityId: staffId, reason: b.reason,
    payload: { roleId: Number(role.id), role: role.code, scopeType: scopeType, scopeId: scopeId } });
}
approvals.register('core.role_grant', async function (tx, req, actor) {
  const d = req.data;
  const dup = await tx.queryOne('SELECT id FROM b2b_staff_roles WHERE staff_id = ? AND role_id = ? AND scope_type = ? AND (scope_id <=> ?) AND revoked_at IS NULL',
    [req.entityId, d.roleId, d.scopeType, d.scopeId]);
  if (dup) return { alreadyGranted: true };
  const r = await tx.query('INSERT INTO b2b_staff_roles (staff_id, role_id, scope_type, scope_id, granted_by) VALUES (?, ?, ?, ?, ?)',
    [req.entityId, d.roleId, d.scopeType, d.scopeId, req.requestedBy]);
  await identity.revokeSessions(tx, req.entityId);
  await audit.write(tx, actor, { module: 'core', action: 'role.granted', entity: 'staff', entityId: req.entityId, new: d, approvalId: req.id });
  return { grantId: r.insertId };
});

/** Revoking is immediate (less access is always safe) and ends the person's sessions. */
async function revokeGrant(tx, actor, staffId, grantId, reason) {
  const g = await tx.queryOne('SELECT sr.*, r.code FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id WHERE sr.id = ? AND sr.staff_id = ? FOR UPDATE', [grantId, staffId]);
  if (!g || g.revoked_at) throw fail(404, 'Not found');
  if (Number(staffId) === Number(actor.id) && g.code === 'super_admin') throw fail(400, 'You cannot remove your own Super Admin role');
  await tx.query('UPDATE b2b_staff_roles SET revoked_at = UTC_TIMESTAMP() WHERE id = ?', [grantId]);
  await identity.revokeSessions(tx, staffId);
  await audit.write(tx, actor, { module: 'core', action: 'role.revoked', entity: 'staff', entityId: staffId, old: { role: g.code, scopeType: g.scope_type, scopeId: g.scope_id }, reason: reason });
  return { ok: true };
}

module.exports = { list, create, update, changeOwnPassword, mfaSetup, mfaEnable, roles, createRole, requestRolePermissions, requestGrant, revokeGrant };
