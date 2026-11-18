/**
 * Migration 010 — field sales. DRAFT for approval; generated from the reviewed DDL.
 * Creates 7 new table(s), then 32 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '010_field_sales.sql');
const SQL_SHA256 = '94d675f77ac6a2eb04fa155cb1cabf5cfe4abe610a993cbf8fa52e4eea46f36d';
const OPS = [
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "channel",
    "def": "ENUM('portal','salesman','admin') NOT NULL DEFAULT 'portal'"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "salesman_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "otp_verified_at",
    "def": "DATETIME NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "otp_override_approval_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "reservation_expires_at",
    "def": "DATETIME NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_orders",
    "column": "buyer_type",
    "def": "ENUM('retailer','distributor','super_stockist') NOT NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_orders",
    "column": "status",
    "def": "ENUM('draft','submitted','pending_admin_approval','approved','assigned','accepted','processing', 'packed','dispatched','out_for_delivery','delivered','partially_delivered', 'cancelled','rejected','returned','refunded','pending_otp','otp_expired') NOT NULL DEFAULT 'submitted'"
  },
  {
    "op": "addIndex",
    "table": "b2b_orders",
    "name": "ix_b2b_orders_salesman",
    "columns": [
      "salesman_id",
      "created_at"
    ],
    "unique": false
  },
  {
    "op": "addIndex",
    "table": "b2b_orders",
    "name": "ix_b2b_orders_otp_exp",
    "columns": [
      "status",
      "reservation_expires_at"
    ],
    "unique": false
  },
  {
    "op": "addIndex",
    "table": "b2b_orders",
    "name": "ix_b2b_orders_otp_override",
    "columns": [
      "otp_override_approval_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_orders",
    "name": "fk_b2b_orders_salesman",
    "column": "salesman_id",
    "refTable": "b2b_salesmen",
    "refColumn": "id"
  },
  {
    "op": "addForeignKey",
    "table": "b2b_orders",
    "name": "fk_b2b_orders_otp_override",
    "column": "otp_override_approval_id",
    "refTable": "b2b_approval_requests",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_order_items",
    "column": "price_list_item_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_order_items",
    "column": "scheme_pct",
    "def": "DECIMAL(7,4) NOT NULL DEFAULT 0.0000"
  },
  {
    "op": "addIndex",
    "table": "b2b_order_items",
    "name": "ix_b2b_oi_pli",
    "columns": [
      "price_list_item_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_order_items",
    "name": "fk_b2b_oi_pli",
    "column": "price_list_item_id",
    "refTable": "b2b_price_list_items",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "delivery_staff_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "delivery_proof",
    "def": "VARCHAR(80) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_orders",
    "column": "delivery_failure_reason",
    "def": "VARCHAR(300) NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_orders",
    "name": "ix_b2b_orders_delivery_staff",
    "columns": [
      "delivery_staff_id",
      "status"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_orders",
    "name": "fk_b2b_orders_delivery_staff",
    "column": "delivery_staff_id",
    "refTable": "b2b_staff",
    "refColumn": "id"
  },
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "receipt_no",
    "def": "VARCHAR(24) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "client_uuid",
    "def": "CHAR(36) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "collected_by_salesman_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "handover_confirmed_by",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_payments",
    "column": "handover_confirmed_at",
    "def": "DATETIME NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_payments",
    "name": "uq_b2b_payments_receipt",
    "columns": [
      "receipt_no"
    ],
    "unique": true
  },
  {
    "op": "addIndex",
    "table": "b2b_payments",
    "name": "uq_b2b_payments_client_uuid",
    "columns": [
      "client_uuid"
    ],
    "unique": true
  },
  {
    "op": "addIndex",
    "table": "b2b_payments",
    "name": "ix_b2b_payments_salesman",
    "columns": [
      "collected_by_salesman_id",
      "status"
    ],
    "unique": false
  },
  {
    "op": "addIndex",
    "table": "b2b_payments",
    "name": "ix_b2b_payments_handover_by",
    "columns": [
      "handover_confirmed_by"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_payments",
    "name": "fk_b2b_payments_salesman",
    "column": "collected_by_salesman_id",
    "refTable": "b2b_salesmen",
    "refColumn": "id"
  },
  {
    "op": "addForeignKey",
    "table": "b2b_payments",
    "name": "fk_b2b_payments_handover_by",
    "column": "handover_confirmed_by",
    "refTable": "b2b_staff",
    "refColumn": "id"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_salesmen", "b2b_beats", "b2b_beat_stops", "b2b_visits", "b2b_otp_challenges", "b2b_otp_attempts", "b2b_sales_targets"] };
