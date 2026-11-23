/**
 * Migration 020 — manufacturing and delivery. DRAFT: applied only to disposable test databases
 * until the owner approves it. Additive only:
 *  - new tables from sql/020_manufacturing_delivery.sql: manufacturing facilities, bills of
 *    materials, manufacturing orders with production updates, material issues, batches with QC
 *    and production documents; shipments for trade orders with tracking events and delivery
 *    challans;
 *  - offline operation kind 'delivery' (a driver's update made without signal);
 *  - b2b_asns.delay_alerted_at (a late manufacturer delivery is alerted once);
 *  - b2b_products.item_kind (finished goods / raw material / packaging; existing rows = finished);
 *  - vendor capability 'contract_manufacturer' (makes our own products to our specification);
 *  - stock movement type 'production_issue' (materials consumed by an in-house manufacturing order).
 * No existing row is changed. Needs 004–012 and 015–019. Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '020_manufacturing_delivery.sql');
const SQL_SHA256 = '854453bbe9ea5bd909142bbfe7d0ac88ded1ee184002c1b27a6cfa7f2f1d8042';
const OPS = [
  { "op": "addColumn", "table": "b2b_asns", "column": "delay_alerted_at", "def": "DATETIME NULL" },
  { "op": "extendEnum", "table": "b2b_offline_ops", "column": "kind", "def": "ENUM('event_sale','event_payment','field_order','visit','location','delivery') NOT NULL" },
  { "op": "addColumn", "table": "b2b_products", "column": "item_kind", "def": "ENUM('finished','raw_material','packaging') NOT NULL DEFAULT 'finished'" },
  { "op": "extendEnum", "table": "b2b_vendor_capabilities", "column": "capability", "def": "ENUM('manufacturer','authorised_distributor','supplier_wholesaler','contract_manufacturer') NOT NULL" },
  { "op": "extendEnum", "table": "b2b_stock_movements", "column": "movement_type", "def": "ENUM('opening','purchase','production','reservation','release','allocation','deallocation', 'dispatch','delivery','damage','expiry','adjustment','return','transfer_in','transfer_out', 'grn','quarantine_in','quarantine_out','recall_hold','write_off','purchase_return','b2c_sale','b2c_reversal','counter_sale','counter_return','production_issue') NOT NULL" }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS };
