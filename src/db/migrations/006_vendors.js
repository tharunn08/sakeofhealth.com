/**
 * Migration 006 — vendors. DRAFT for approval; generated from the reviewed DDL.
 * Creates 11 new table(s), then 2 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '006_vendors.sql');
const SQL_SHA256 = '4004df679afb61c7ea5061bc1d4146380095c815f069d86b14ff43e0964cab7c';
const OPS = [
  {
    "op": "addForeignKey",
    "table": "b2b_products",
    "name": "fk_b2b_products_maker",
    "column": "manufacturer_vendor_id",
    "refTable": "b2b_vendors",
    "refColumn": "id"
  },
  {
    "op": "addForeignKey",
    "table": "b2b_price_lists",
    "name": "fk_b2b_pl_vendor",
    "column": "vendor_id",
    "refTable": "b2b_vendors",
    "refColumn": "id"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_vendors", "b2b_vendor_capabilities", "b2b_vendor_addresses", "b2b_vendor_users", "b2b_vendor_documents", "b2b_vendor_verifications", "b2b_vendor_bank_accounts", "b2b_vendor_products", "b2b_vendor_price_lists", "b2b_vendor_contracts", "b2b_vendor_messages"] };
