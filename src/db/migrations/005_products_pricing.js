/**
 * Migration 005 — products pricing. DRAFT for approval; generated from the reviewed DDL.
 * Creates 4 new table(s), then 16 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '005_products_pricing.sql');
const SQL_SHA256 = '6c20871af2cfb21cfddec6519af936a9f5601e06bb3874cef3ae67abf5860be0';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "sap_code",
    "def": "VARCHAR(30) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "uom",
    "def": "VARCHAR(20) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "shipper_size",
    "def": "INT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "shelf_life_days",
    "def": "SMALLINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "min_shelf_life_pct",
    "def": "TINYINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "is_batch_tracked",
    "def": "TINYINT(1) NOT NULL DEFAULT 1"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "manufacturer_vendor_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "super_stockist_price",
    "def": "DECIMAL(12,2) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "super_stockist_margin",
    "def": "DECIMAL(7,3) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_products",
    "column": "avail_super_stockist",
    "def": "TINYINT(1) NOT NULL DEFAULT 0"
  },
  {
    "op": "addIndex",
    "table": "b2b_products",
    "name": "uq_b2b_products_sap",
    "columns": [
      "sap_code"
    ],
    "unique": true
  },
  {
    "op": "addIndex",
    "table": "b2b_products",
    "name": "ix_b2b_products_maker",
    "columns": [
      "manufacturer_vendor_id"
    ],
    "unique": false
  },
  {
    "op": "extendEnum",
    "table": "b2b_pricing_rules",
    "column": "audience",
    "def": "ENUM('distributor','retailer','super_stockist') NOT NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_pricing_rules",
    "column": "rule_type",
    "def": "ENUM('margin_pct','fixed_price','discount_pct','free_qty') NOT NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_pricing_rules",
    "column": "buy_qty",
    "def": "INT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_pricing_rules",
    "column": "free_qty",
    "def": "INT UNSIGNED NULL"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_tax_rates", "b2b_price_lists", "b2b_price_list_items", "b2b_product_aliases"] };
