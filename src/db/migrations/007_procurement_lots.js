/**
 * Migration 007 — procurement lots. DRAFT for approval; generated from the reviewed DDL.
 * Creates 23 new table(s), then 12 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '007_procurement_lots.sql');
const SQL_SHA256 = 'be8c873d0c26c32f637b4ebbd91a4be5244464336f1f45569813746554f8025b';
const OPS = [
  {
    "op": "addForeignKey",
    "table": "b2b_lots",
    "name": "fk_b2b_lots_grn",
    "column": "first_grn_id",
    "refTable": "b2b_grns",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_batches",
    "column": "lot_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_batches",
    "column": "qty_quarantine",
    "def": "INT UNSIGNED NOT NULL DEFAULT 0"
  },
  {
    "op": "addIndex",
    "table": "b2b_batches",
    "name": "ix_b2b_batches_lot",
    "columns": [
      "lot_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_batches",
    "name": "fk_b2b_batches_lot",
    "column": "lot_id",
    "refTable": "b2b_lots",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_stock_movements",
    "column": "lot_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_stock_movements",
    "name": "ix_b2b_sm_lot",
    "columns": [
      "lot_id",
      "created_at"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_stock_movements",
    "name": "fk_b2b_sm_lot",
    "column": "lot_id",
    "refTable": "b2b_lots",
    "refColumn": "id"
  },
  {
    "op": "extendEnum",
    "table": "b2b_stock_movements",
    "column": "movement_type",
    "def": "ENUM('opening','purchase','production','reservation','release','allocation','deallocation', 'dispatch','delivery','damage','expiry','adjustment','return','transfer_in','transfer_out', 'grn','quarantine_in','quarantine_out','recall_hold','write_off','purchase_return','b2c_sale','b2c_reversal') NOT NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_order_item_allocations",
    "column": "lot_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_order_item_allocations",
    "name": "ix_b2b_oia_lot",
    "columns": [
      "lot_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_order_item_allocations",
    "name": "fk_b2b_oia_lot",
    "column": "lot_id",
    "refTable": "b2b_lots",
    "refColumn": "id"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_lots", "b2b_purchase_requisitions", "b2b_purchase_requisition_items", "b2b_rfqs", "b2b_rfq_items", "b2b_rfq_vendors", "b2b_rfq_responses", "b2b_rfq_response_items", "b2b_purchase_orders", "b2b_purchase_order_items", "b2b_po_acknowledgements", "b2b_asns", "b2b_asn_items", "b2b_grns", "b2b_grn_items", "b2b_quality_inspections", "b2b_supplier_invoices", "b2b_supplier_invoice_items", "b2b_match_results", "b2b_supplier_payments", "b2b_supplier_payment_allocations", "b2b_purchase_returns", "b2b_purchase_return_items"] };
