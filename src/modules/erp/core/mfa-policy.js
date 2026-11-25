/**
 * Two-factor sign-in (TOTP) for business staff: off, on for everyone, or on for chosen roles.
 *
 * Where the answer comes from, first match wins:
 *   1. ERP_MFA_REQUIRED in the server environment (true / false) — an emergency override, e.g. to
 *      get back in after losing a phone. While it is set, the in-app setting cannot be changed.
 *   2. The in-app setting (Administration → My account), stored in b2b_settings under KEY:
 *      false = off, true = everyone, {"roles":["super_admin", …]} = only people holding one of those
 *      roles. A Super Admin (core.settings.edit) changes it; every change is in the audit log.
 *   3. Never set: OFF (the owner's decision, 24 Nov 2026).
 * If the settings cannot be read (no database, database error), the answer is ON for everyone — fail safe.
 *
 * Where it applies to a person, sign-in asks for the 6-digit code if they set up an authenticator,
 * and approvals and sensitive actions (identity.needsMfa) need a session signed in with that code.
 * Giving someone a role never asks them to set up an authenticator by itself; only this policy does.
 */
'use strict';
const db = require('../../../db/connection.js');

const KEY = 'security.erp_mfa_required';
const TTL_MS = 15000;          // other server processes see a change within this time
let cache = null;              // { status, at }

function fail(status, msg, code) { return Object.assign(new Error(msg), { status: status, expose: true, code: code }); }

/** true / false when ERP_MFA_REQUIRED is set to exactly that, else null. */
function envOverride() {
  const v = String(process.env.ERP_MFA_REQUIRED || '').trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

/** Stored value → { mode: 'off' | 'all' | 'roles', roles: [] }. Anything unreadable → 'all'. */
function fromStored(v) {
  if (v === false) return { mode: 'off', roles: [] };
  if (v && typeof v === 'object' && Array.isArray(v.roles) && v.roles.length) {
    return { mode: 'roles', roles: Array.from(new Set(v.roles.map(String))).sort() };
  }
  return { mode: 'all', roles: [] };
}
function toStored(p) { return p.mode === 'off' ? false : p.mode === 'all' ? true : { roles: p.roles }; }

/**
 * → { required, mode, roles, source: 'server' | 'switch' | 'default' | 'fail-safe', changedBy?, changedAt? }
 * required: true when the policy applies to anybody (kept for older callers and screens).
 */
async function status() {
  const env = envOverride();
  if (env !== null) return { required: env, mode: env ? 'all' : 'off', roles: [], source: 'server' };
  if (!db.isConfigured()) return { required: true, mode: 'all', roles: [], source: 'fail-safe' };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.status;
  let st;
  try {
    const r = await db.queryOne('SELECT setting_value, updated_by, updated_at FROM b2b_settings WHERE setting_key = ?', [KEY]);
    if (!r) st = { required: false, mode: 'off', roles: [], source: 'default' };
    else {
      let v; try { v = JSON.parse(r.setting_value); } catch (e) { v = null; }
      const p = fromStored(v);
      st = { required: p.mode !== 'off', mode: p.mode, roles: p.roles, source: 'switch', changedBy: r.updated_by || null, changedAt: r.updated_at || null };
    }
  } catch (e) {
    return { required: true, mode: 'all', roles: [], source: 'fail-safe' };   // not cached: the next call tries again
  }
  cache = { status: st, at: Date.now() };
  return st;
}

/** Does the policy apply to a person holding these role codes? */
function appliesTo(st, roles) {
  if (st.mode === 'off') return false;
  if (st.mode === 'all') return true;
  if (!Array.isArray(roles)) return true;                 // roles unknown: fail closed
  return roles.some(function (r) { return st.roles.indexOf(r) !== -1; });
}

/** roles: the person's role codes. */
async function required(roles) { return appliesTo(await status(), roles); }

/** Role codes a staff member holds now (for sign-in, before the full principal is loaded). */
async function rolesOf(q, staffId) {
  const rows = await (q || db).query('SELECT r.code FROM b2b_staff_roles sr JOIN b2b_roles r ON r.id = sr.role_id ' +
    'WHERE sr.staff_id = ? AND sr.revoked_at IS NULL AND r.is_active = 1', [staffId]);
  return Array.isArray(rows) ? rows.map(function (x) { return x.code; }) : [];
}

/** required() for a staff member by id; their roles are read only when the policy names roles. */
async function requiredForStaff(q, staffId) {
  const st = await status();
  return appliesTo(st, st.mode === 'roles' ? await rolesOf(q, staffId) : []);
}

/**
 * Changes the policy. value: true / false (everyone / off), or { mode: 'off' | 'all' | 'roles', roles: [...] }.
 * actor: audit actor; principal: the signed-in staff member (req.erp). If the new policy applies to the
 * person changing it, their own authenticator must be set up first, so they can still sign in.
 */
async function set(tx, actor, principal, value, reason) {
  let next;
  if (typeof value === 'boolean') next = { mode: value ? 'all' : 'off', roles: [] };
  else if (value && typeof value === 'object' && ['off', 'all', 'roles'].indexOf(value.mode) !== -1) {
    next = { mode: value.mode, roles: value.mode === 'roles' && Array.isArray(value.roles) ? Array.from(new Set(value.roles.map(String))).sort() : [] };
    if (next.mode === 'roles' && !next.roles.length) throw fail(400, 'Choose at least one role, or choose off', 'no_roles');
  } else throw fail(400, 'Choose off, everyone, or chosen roles');
  if (envOverride() !== null) {
    throw fail(409, 'Two-factor sign-in is fixed by the server setting ERP_MFA_REQUIRED. Remove that setting in Hostinger to use this switch.', 'fixed_by_server');
  }
  if (next.roles.length) {
    const known = await tx.query('SELECT code FROM b2b_roles WHERE code IN (' + next.roles.map(function () { return '?'; }).join(',') + ')', next.roles);
    const have = new Set(known.map(function (k) { return k.code; }));
    const bad = next.roles.filter(function (c) { return !have.has(c); });
    if (bad.length) throw fail(400, 'Unknown roles: ' + bad.join(', '), 'unknown_role');
  }
  if (appliesTo(next, principal.roles)) {
    const me = await tx.queryOne('SELECT mfa_enabled FROM b2b_staff WHERE id = ?', [principal.id]);
    if (!me || Number(me.mfa_enabled) !== 1) {
      throw fail(409, 'This setting would ask you for a code too. Set up two-factor sign-in on your own account first (on this page), then change it.', 'own_mfa_first');
    }
  }
  const before = await tx.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ? FOR UPDATE', [KEY]);
  let old = { mode: 'off', roles: [] };
  if (before) { try { old = fromStored(JSON.parse(before.setting_value)); } catch (e) { old = { mode: 'all', roles: [] }; } }
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [KEY, JSON.stringify(toStored(next)), String(actor.label || ('staff #' + principal.id)).slice(0, 190)]);
  const audit = require('./audit.js');
  const action = next.mode === 'off' ? 'security.mfa_switched_off' : next.mode === 'all' ? 'security.mfa_switched_on' : 'security.mfa_roles_set';
  await audit.write(tx, actor, { module: 'core', action: action, entity: 'setting', entityId: null,
    old: { required: old.mode !== 'off', mode: old.mode, roles: old.roles }, new: { required: next.mode !== 'off', mode: next.mode, roles: next.roles }, reason: reason || null });
  // This process sees the change as soon as it is committed; others within TTL_MS.
  const apply = function () { cache = { status: { required: next.mode !== 'off', mode: next.mode, roles: next.roles, source: 'switch', changedBy: actor.label || null, changedAt: new Date() }, at: Date.now() }; };
  if (typeof tx.afterCommit === 'function') tx.afterCommit(apply); else cache = null;
  return { required: next.mode !== 'off', mode: next.mode, roles: next.roles };
}

/** For tests: forget the cached answer. */
function reset() { cache = null; }

module.exports = { KEY, status, required, requiredForStaff, appliesTo, rolesOf, set, envOverride, reset };
