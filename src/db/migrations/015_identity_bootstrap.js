/**
 * Migration 015 — identity bootstrap. DRAFT: applied only to disposable test
 * databases and new local trial databases until the owner approves it.
 * Additive only: one column on each MySQL account table, so an account created
 * with a temporary password (scripts/seed-accounts.js, or an admin) must choose
 * a new password at its first sign-in. Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '015_identity_bootstrap.sql');
const SQL_SHA256 = '54f6cbab006de1c0bf0d2b16177860fe6893dd4633483ca04cb0f03b45fe9f45';
const OPS = [
  { "op": "addColumn", "table": "b2b_staff", "column": "must_change_password", "def": "TINYINT(1) NOT NULL DEFAULT 0" },
  { "op": "addColumn", "table": "b2b_users", "column": "must_change_password", "def": "TINYINT(1) NOT NULL DEFAULT 0" },
  { "op": "addColumn", "table": "b2b_vendor_users", "column": "must_change_password", "def": "TINYINT(1) NOT NULL DEFAULT 0" }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS };
