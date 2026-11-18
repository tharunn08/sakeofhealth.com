/**
 * Migration 017 — central inventory ledger (Milestone 3b.1). DRAFT: applied only to
 * disposable test databases until the owner approves it. Additive only:
 *  - b2b_stock_movements.idem_key + unique index: the database refuses a second movement
 *    with the same key (retries can never post twice);
 *  - warehouse types 'event' and 'salesman'; movement types 'counter_sale', 'counter_return';
 *  - b2b_salesmen.stock_warehouse_id (a salesman's own stock location);
 *  - one business product per shop product (unique b2c_ref) — refused with the list of
 *    duplicates if live data has any (nothing is changed then);
 *  - tables b2b_stock_reservations and b2b_stock_adjustments.
 * Needs 001–012. Safe to re-run (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '017_inventory_ledger.sql');
const SQL_SHA256 = '929b3bd389df8b408f433667b76cf91bef13c24faa8ac3eeff0ee10633e6bf33';
const OPS = [
  { "op": "addColumn", "table": "b2b_stock_movements", "column": "idem_key", "def": "VARCHAR(120) NULL" },
  { "op": "addIndex", "table": "b2b_stock_movements", "name": "uq_b2b_sm_idem", "columns": ["idem_key"], "unique": true },
  { "op": "extendEnum", "table": "b2b_stock_movements", "column": "movement_type", "def": "ENUM('opening','purchase','production','reservation','release','allocation','deallocation', 'dispatch','delivery','damage','expiry','adjustment','return','transfer_in','transfer_out', 'grn','quarantine_in','quarantine_out','recall_hold','write_off','purchase_return','b2c_sale','b2c_reversal','counter_sale','counter_return') NOT NULL" },
  { "op": "extendEnum", "table": "b2b_warehouses", "column": "warehouse_type", "def": "ENUM('company','distributor','online_shop','transit','event','salesman') NOT NULL DEFAULT 'company'" },
  { "op": "addColumn", "table": "b2b_salesmen", "column": "stock_warehouse_id", "def": "INT UNSIGNED NULL" },
  { "op": "addForeignKey", "table": "b2b_salesmen", "name": "fk_b2b_sm_stock_wh", "column": "stock_warehouse_id", "refTable": "b2b_warehouses", "refColumn": "id" },
  { "op": "addIndex", "table": "b2b_products", "name": "uq_b2b_products_b2c_ref", "columns": ["b2c_ref"], "unique": true }
];

/** Two business products claiming one shop product: refuse with the list, change nothing. */
async function duplicateShopRefs(conn) {
  const [rows] = await conn.raw.query('SELECT b2c_ref, GROUP_CONCAT(id ORDER BY id) AS ids FROM b2b_products WHERE b2c_ref IS NOT NULL GROUP BY b2c_ref HAVING COUNT(*) > 1');
  return rows;
}

async function up(conn, log) {
  const dups = await duplicateShopRefs(conn);
  if (dups.length) {
    throw new Error('Refused before any change: these shop products are linked to more than one business product — ' +
      dups.map(function (d) { return d.b2c_ref + ' → products ' + d.ids; }).join('; ') + '. Decide which link is right, then run again.');
  }
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, duplicateShopRefs };
