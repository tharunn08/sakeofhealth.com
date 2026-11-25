/**
 * Who may give a role, and when a second person must approve it.
 *
 * Stored in b2b_settings under KEY as JSON:
 *   { "mode": "direct", "approvalRoles": ["finance_manager"] }
 *     mode "direct"   — one person holding core.roles.edit gives an ordinary role at once.
 *     mode "approval" — every role waits for an approver (the behaviour before 25 Nov 2026).
 *     approvalRoles   — extra roles that always need an approver (optional).
 * Never set: "direct" with no extra roles (the owner's brief, 25 Nov 2026).
 * Settings unreadable (no database, database error): "approval" — fail safe.
 *
 * Whatever the mode, a grant goes to the approval queue when
 *   - the role is super_admin or carries an admin-level permission (ADMIN_PERMISSIONS),
 *   - the role is in approvalRoles,
 *   - the giver is giving a role to themselves,
 *   - the role has a permission the giver does not hold, or
 *   - the scope is wider than the giver's own scope.
 * So nobody can raise their own access, or anyone else's beyond their own, without a second person.
 */
'use strict';
const db = require('../../../db/connection.js');

const KEY = 'security.role_assignment';
const ADMIN_PERMISSIONS = ['core.roles.edit', 'core.settings.edit', 'core.approvals.unconfigured'];
const MODES = ['direct', 'approval'];
const TTL_MS = 15000;
let cache = null;

function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }

function normalise(v) {
  if (!v || typeof v !== 'object' || MODES.indexOf(v.mode) === -1) return null;
  const roles = Array.isArray(v.approvalRoles) ? v.approvalRoles.map(String).filter(function (c) { return /^[a-z0-9_]{1,40}$/.test(c); }) : [];
  return { mode: v.mode, approvalRoles: Array.from(new Set(roles)).sort() };
}

/** → { mode, approvalRoles, source: 'default' | 'setting' | 'fail-safe', changedBy?, changedAt? } */
async function status() {
  if (!db.isConfigured()) return { mode: 'approval', approvalRoles: [], source: 'fail-safe' };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.status;
  let st;
  try {
    const r = await db.queryOne('SELECT setting_value, updated_by, updated_at FROM b2b_settings WHERE setting_key = ?', [KEY]);
    if (!r) st = { mode: 'direct', approvalRoles: [], source: 'default' };
    else {
      let v; try { v = normalise(JSON.parse(r.setting_value)); } catch (e) { v = null; }
      st = v ? Object.assign(v, { source: 'setting', changedBy: r.updated_by || null, changedAt: r.updated_at || null })
        : { mode: 'approval', approvalRoles: [], source: 'fail-safe' };
    }
  } catch (e) {
    return { mode: 'approval', approvalRoles: [], source: 'fail-safe' };
  }
  cache = { status: st, at: Date.now() };
  return st;
}

/** A role that only ever moves through approval, whatever the mode. */
function isAdminLevel(roleCode, rolePermissions) {
  return roleCode === 'super_admin' || (rolePermissions || []).some(function (p) { return ADMIN_PERMISSIONS.indexOf(p) !== -1; });
}

/** Does the giver's own scope cover the scope being given? */
function scopeCovered(scopes, scopeType, scopeId) {
  scopes = scopes || {};
  if (scopeType === 'all') return ['territory', 'warehouse', 'state'].every(function (d) { return scopes[d] === 'all'; });
  const mine = scopes[scopeType];
  return mine === 'all' || (Array.isArray(mine) && mine.indexOf(Number(scopeId)) !== -1);
}

/**
 * Pure decision, unit-tested without a database.
 * giver: { id, permissions:Set, scopes }; role: { code, permissions:[] }; grant: { staffId, scopeType, scopeId }
 * → { direct: boolean, reason: string }   (reason says why it needs approval)
 */
function decide(policy, giver, role, grant) {
  if (!policy || policy.mode !== 'direct') return { direct: false, reason: 'Every role is set to need approval.' };
  if (isAdminLevel(role.code, role.permissions)) return { direct: false, reason: 'Super Admin and admin-level roles always need a second person to approve.' };
  if ((policy.approvalRoles || []).indexOf(role.code) !== -1) return { direct: false, reason: 'This role is set to need approval.' };
  if (Number(grant.staffId) === Number(giver.id)) return { direct: false, reason: 'Roles you give yourself need someone else to approve.' };
  const missing = (role.permissions || []).filter(function (p) { return !giver.permissions.has(p); });
  if (missing.length) return { direct: false, reason: 'This role can do things your own roles cannot, so someone else approves it.' };
  if (!scopeCovered(giver.scopes, grant.scopeType, grant.scopeId)) return { direct: false, reason: 'This scope is wider than your own, so someone else approves it.' };
  return { direct: true, reason: '' };
}

/** Changes the policy (core.settings.edit). Every change is in the audit log. */
async function set(tx, actor, value, reason) {
  const v = normalise(value);
  if (!v) throw fail(400, 'Mode must be direct or approval', 'bad_mode');
  if (v.approvalRoles.length) {
    const known = await tx.query('SELECT code FROM b2b_roles WHERE code IN (' + v.approvalRoles.map(function () { return '?'; }).join(',') + ')', v.approvalRoles);
    const have = new Set(known.map(function (k) { return k.code; }));
    const bad = v.approvalRoles.filter(function (c) { return !have.has(c); });
    if (bad.length) throw fail(400, 'Unknown roles: ' + bad.join(', '), 'unknown_role');
  }
  const before = await tx.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ? FOR UPDATE', [KEY]);
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [KEY, JSON.stringify(v), String(actor.label || ('staff #' + actor.id)).slice(0, 190)]);
  const audit = require('./audit.js');
  await audit.write(tx, actor, { module: 'core', action: 'security.role_assignment_changed', entity: 'setting', entityId: null,
    old: before ? before.setting_value : null, new: v, reason: reason || null });
  const apply = function () { cache = { status: Object.assign({}, v, { source: 'setting', changedBy: actor.label || null, changedAt: new Date() }), at: Date.now() }; };
  if (typeof tx.afterCommit === 'function') tx.afterCommit(apply); else cache = null;
  return v;
}

function reset() { cache = null; }

module.exports = { KEY, ADMIN_PERMISSIONS, status, decide, isAdminLevel, scopeCovered, set, reset };
