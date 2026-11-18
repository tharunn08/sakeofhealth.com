/**
 * Migration 011 — returns recalls. DRAFT for approval; generated from the reviewed DDL.
 * Creates 4 new table(s), then 15 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '011_returns_recalls.sql');
const SQL_SHA256 = '6c256cfa49e4307bd5682934b53cc7b0e0dbfe790cd2f45a9de900469b8af9df';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_returns",
    "column": "return_type",
    "def": "ENUM('retailer','distributor','damaged','wrong_item','expiry','recall') NOT NULL DEFAULT 'retailer'"
  },
  {
    "op": "addColumn",
    "table": "b2b_returns",
    "column": "recall_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_returns",
    "column": "status",
    "def": "ENUM('requested','approved','rejected','pickup_scheduled','received','completed','cancelled','quarantined','disposed') NOT NULL DEFAULT 'requested'"
  },
  {
    "op": "addIndex",
    "table": "b2b_returns",
    "name": "ix_b2b_returns_recall",
    "columns": [
      "recall_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_returns",
    "name": "fk_b2b_returns_recall",
    "column": "recall_id",
    "refTable": "b2b_recalls",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_return_items",
    "column": "lot_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_return_items",
    "column": "photos_json",
    "def": "TEXT NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_return_items",
    "column": "item_condition",
    "def": "ENUM('good','damaged','expired','near_expiry','wrong_item','tampered') NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_return_items",
    "column": "inspection_note",
    "def": "VARCHAR(500) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_return_items",
    "column": "inspected_by",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_return_items",
    "column": "inspected_at",
    "def": "DATETIME NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_return_items",
    "name": "ix_b2b_ri_inspected_by",
    "columns": [
      "inspected_by"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_return_items",
    "name": "fk_b2b_ri_inspected_by",
    "column": "inspected_by",
    "refTable": "b2b_staff",
    "refColumn": "id"
  },
  {
    "op": "addIndex",
    "table": "b2b_return_items",
    "name": "ix_b2b_ri_lot",
    "columns": [
      "lot_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_return_items",
    "name": "fk_b2b_ri_lot",
    "column": "lot_id",
    "refTable": "b2b_lots",
    "refColumn": "id"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_recalls", "b2b_recall_lots", "b2b_recall_parties", "b2b_recall_receipts"] };
