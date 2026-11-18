/**
 * "Must change password at next sign-in" (migration 015) for the MySQL account
 * tables. A database without migration 015 has no such column: that reads as
 * "no change required" and clearing is a no-op, so sign-in never breaks there.
 */
'use strict';
const db = require('./connection.js');

const TABLES = { staff: 'b2b_staff', business: 'b2b_users', vendor: 'b2b_vendor_users' };
const missingColumn = e => !!e && (e.code === 'ER_BAD_FIELD_ERROR' || e.errno === 1054);

async function get(kind, id, q) {
  try {
    const r = await (q || db).queryOne('SELECT must_change_password AS m FROM ' + TABLES[kind] + ' WHERE id = ?', [id]);
    return !!(r && Number(r.m) === 1);
  } catch (e) { if (missingColumn(e)) return false; throw e; }
}

async function clear(kind, id, q) {
  try { await (q || db).query('UPDATE ' + TABLES[kind] + ' SET must_change_password = 0 WHERE id = ?', [id]); }
  catch (e) { if (!missingColumn(e)) throw e; }
}

/** The 403 every module answers while a password change is pending. */
const REQUIRED = { error: 'Please choose a new password before continuing. Sign in at /login to set it.', code: 'password_change_required' };

module.exports = { get, clear, TABLES, REQUIRED, missingColumn };
