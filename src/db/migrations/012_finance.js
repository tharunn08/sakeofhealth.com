/**
 * Migration 012 — finance. DRAFT for approval; generated from the reviewed DDL.
 * Creates 5 new table(s), then 1 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '012_finance.sql');
const SQL_SHA256 = '25d3210e15c630850a5c4be2d29465bf65c8e5c74baa0db46aed6d880dcfff99';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "unallocated_amount",
    "def": "DECIMAL(14,2) NOT NULL DEFAULT 0.00"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_payment_allocations", "b2b_debit_notes", "b2b_bank_accounts", "b2b_bank_statement_lines", "b2b_distributor_settlements"] };
