/**
 * Change a password at /login — used for the first sign-in with a temporary
 * password, in every account store the person has. For each store the CURRENT
 * password is verified again (and, for an ERP account with two-factor on, the
 * 6-digit code); only matching accounts are changed. Changing ends that
 * account's other sessions (token_version + 1) and clears must_change_password.
 * The environment root admin is never changed here.
 */
'use strict';
const mustChange = require('../db/mustChange.js');

async function changeEverywhere(input, opts) {
  const email = String(input.email || '').trim().toLowerCase();
  const current = String(input.currentPassword || ''), next = String(input.newPassword || '');
  const changed = [], unavailable = [];
  let needCode = false;

  // Shop / trade staff (staff.json)
  const adminAuth = require('../middleware/adminAuth.js');
  const { db } = require('../services/db.js');
  const st = db.staff.findOne({ email });
  if (st && st.active !== false && adminAuth.verifyPassword(current, st.passwordHash)) {
    db.staff.update(st.id, { passwordHash: adminAuth.hashPassword(next), mustChangePassword: false, passwordChangedAt: new Date().toISOString() });
    changed.push('staff');
  }

  if (!opts.mysql) return { changed, unavailable, needCode };
  const sql = require('../db/connection.js');
  const tryStore = async (name, fn) => { try { await fn(); } catch (e) { unavailable.push(name); } };

  if (opts.erp) {
    await tryStore('erp', async () => {
      const sec = require('../modules/erp/core/security.js');
      const s = await sql.queryOne('SELECT id, password_hash, status, mfa_enabled, mfa_secret_enc FROM b2b_staff WHERE email = ?', [email]);
      if (!s || s.status !== 'active' || !sec.verifyPassword(current, s.password_hash)) return;
      const mfaPolicy = require('../modules/erp/core/mfa-policy.js');
      if (Number(s.mfa_enabled) === 1 && await mfaPolicy.requiredForStaff(sql, s.id)) {
        const recovery = require('../modules/erp/core/recovery-codes.js');
        const secret = sec.decrypt(s.mfa_secret_enc);
        const ok = input.totp && (recovery.looksLikeCode(input.totp) ? await recovery.consume(s.id, input.totp) : (!!secret && sec.verifyTotp(secret, input.totp)));
        if (!ok) { needCode = true; return; }
      }
      await sql.query('UPDATE b2b_staff SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [sec.hashPassword(next), s.id]);
      await mustChange.clear('staff', s.id);
      await require('../modules/erp/core/audit.js').write(null, { type: 'staff', id: s.id, label: email, role: 'self', ip: opts.ip },
        { module: 'core', action: 'staff.password_changed', entity: 'staff', entityId: s.id, reason: 'changed at /login' });
      changed.push('erp');
    });
    await tryStore('supplier', async () => {
      const sec = require('../modules/erp/core/security.js');
      const u = await sql.queryOne('SELECT id, password_hash, status FROM b2b_vendor_users WHERE email = ?', [email]);
      if (!u || u.status !== 'active' || !u.password_hash || !sec.verifyPassword(current, u.password_hash)) return;
      await sql.query('UPDATE b2b_vendor_users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [sec.hashPassword(next), u.id]);
      await mustChange.clear('vendor', u.id);
      changed.push('supplier');
    });
  }
  if (opts.b2b) {
    await tryStore('business', async () => {
      const sec = require('../modules/b2b/lib/security.js');
      const u = await sql.queryOne('SELECT id, password_hash, status FROM b2b_users WHERE email = ?', [email]);
      if (!u || u.status !== 'active' || !sec.verifyPassword(current, u.password_hash)) return;
      await sql.query('UPDATE b2b_users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [sec.hashPassword(next), u.id]);
      await mustChange.clear('business', u.id);
      changed.push('business');
    });
  }
  return { changed, unavailable, needCode };
}

module.exports = { changeEverywhere };
