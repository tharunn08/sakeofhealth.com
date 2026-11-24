/**
 * Two-factor sign-in (TOTP) for business staff: one on/off switch for the whole site.
 *
 * Where the answer comes from, first match wins:
 *   1. ERP_MFA_REQUIRED in the server environment (true / false) — an emergency override, e.g. to
 *      get back in after losing a phone. While it is set, the in-app switch cannot be changed.
 *   2. The in-app switch (Administration → My Password & 2FA), stored in b2b_settings under
 *      KEY. A Super Admin (core.settings.edit) turns it on or off; every change is in the audit log.
 *   3. Never switched: OFF (the owner's decision, 24 Nov 2026).
 * If the settings cannot be read (no database, database error), the answer is ON — fail safe.
 *
 * ON:  sign-in asks staff who set up an authenticator for the 6-digit code, and approvals and
 *      sensitive actions (identity.needsMfa) need a session signed in with that code.
 * OFF: no code is asked and no action needs it. Maker-checker, permissions and the failed-login
 *      lock are unchanged.
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

/** → { required, source: 'server' | 'switch' | 'default' | 'fail-safe', changedBy?, changedAt? } */
async function status() {
  const env = envOverride();
  if (env !== null) return { required: env, source: 'server' };
  if (!db.isConfigured()) return { required: true, source: 'fail-safe' };
  if (cache && Date.now() - cache.at < TTL_MS) return cache.status;
  let st;
  try {
    const r = await db.queryOne('SELECT setting_value, updated_by, updated_at FROM b2b_settings WHERE setting_key = ?', [KEY]);
    if (!r) st = { required: false, source: 'default' };
    else {
      let v; try { v = JSON.parse(r.setting_value); } catch (e) { v = null; }
      st = { required: v !== false, source: 'switch', changedBy: r.updated_by || null, changedAt: r.updated_at || null };
    }
  } catch (e) {
    return { required: true, source: 'fail-safe' };   // not cached: the next call tries again
  }
  cache = { status: st, at: Date.now() };
  return st;
}

async function required() { return (await status()).required; }

/**
 * Turns the switch on or off. actor: audit actor; principal: the signed-in staff member (req.erp).
 * Turning it ON needs the person's own authenticator to be set up first, so they can still sign in
 * with a code and switch it off again later.
 */
async function set(tx, actor, principal, on, reason) {
  if (typeof on !== 'boolean') throw fail(400, 'Choose on or off');
  if (envOverride() !== null) {
    throw fail(409, 'Two-factor sign-in is fixed by the server setting ERP_MFA_REQUIRED. Remove that setting in Hostinger to use this switch.', 'fixed_by_server');
  }
  if (on) {
    const me = await tx.queryOne('SELECT mfa_enabled FROM b2b_staff WHERE id = ?', [principal.id]);
    if (!me || Number(me.mfa_enabled) !== 1) {
      throw fail(409, 'Set up two-factor sign-in on your own account first (on this page), then switch it on for everyone.', 'own_mfa_first');
    }
  }
  const before = await tx.queryOne('SELECT setting_value FROM b2b_settings WHERE setting_key = ? FOR UPDATE', [KEY]);
  const old = before ? before.setting_value !== 'false' : false;
  await tx.query('INSERT INTO b2b_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ' +
    'ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)',
    [KEY, JSON.stringify(on), String(actor.label || ('staff #' + principal.id)).slice(0, 190)]);
  const audit = require('./audit.js');
  await audit.write(tx, actor, { module: 'core', action: on ? 'security.mfa_switched_on' : 'security.mfa_switched_off',
    entity: 'setting', entityId: null, old: { required: old }, new: { required: on }, reason: reason || null });
  // This process sees the change as soon as it is committed; others within TTL_MS.
  const apply = function () { cache = { status: { required: on, source: 'switch', changedBy: actor.label || null, changedAt: new Date() }, at: Date.now() }; };
  if (typeof tx.afterCommit === 'function') tx.afterCommit(apply); else cache = null;
  return { required: on };
}

/** For tests: forget the cached answer. */
function reset() { cache = null; }

module.exports = { KEY, status, required, set, envOverride, reset };
