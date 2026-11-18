/**
 * Migration 008 — inventory. DRAFT for approval; generated from the reviewed DDL.
 * Creates 9 new table(s), then 4 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '008_inventory.sql');
const SQL_SHA256 = '981e9ba5817feb9f680cb0c5176b7b2d68b72df3d1ed8bca19957745aa7e5613';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_stock",
    "column": "qty_quarantine",
    "def": "INT UNSIGNED NOT NULL DEFAULT 0"
  },
  {
    "op": "addColumn",
    "table": "b2b_warehouses",
    "column": "warehouse_type",
    "def": "ENUM('company','distributor','online_shop','transit') NOT NULL DEFAULT 'company'"
  },
  {
    "op": "addColumn",
    "table": "b2b_warehouses",
    "column": "latitude",
    "def": "DECIMAL(10,7) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_warehouses",
    "column": "longitude",
    "def": "DECIMAL(10,7) NULL"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_warehouse_locations", "b2b_stock_transfers", "b2b_stock_transfer_items", "b2b_stock_counts", "b2b_stock_count_items", "b2b_dispositions", "b2b_reorder_rules", "b2b_b2c_sync_cursor", "b2b_b2c_order_postings"] };
