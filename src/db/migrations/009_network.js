/**
 * Migration 009 — network. DRAFT for approval; generated from the reviewed DDL.
 * Creates 3 new table(s), then 17 guarded change(s) to existing tables.
 * Additive only. Safe to re-run: every step checks first (see lib/guarded.js).
 */
'use strict';
const path = require('path');
const guarded = require('./lib/guarded.js');

const SQL_FILE = path.join(__dirname, 'sql', '009_network.sql');
const SQL_SHA256 = 'cfe7d32858d0ad1a64493491943bdcbc488e3ba276a8b2e61f1dea0b23d1404c';
const OPS = [
  {
    "op": "extendEnum",
    "table": "b2b_accounts",
    "column": "account_type",
    "def": "ENUM('retailer','distributor','super_stockist') NOT NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_accounts",
    "column": "status",
    "def": "ENUM('pending','under_review','approved','rejected','suspended','blocked','more_info_required') NOT NULL DEFAULT 'pending'"
  },
  {
    "op": "makeNullable",
    "table": "b2b_accounts",
    "column": "email",
    "def": "VARCHAR(190) NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_accounts",
    "column": "registered_by_staff_id",
    "def": "BIGINT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_accounts",
    "column": "territory_id",
    "def": "INT UNSIGNED NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_accounts",
    "column": "gst_verification",
    "def": "ENUM('none','checksum_ok','api_verified','manual_verified','failed') NOT NULL DEFAULT 'none'"
  },
  {
    "op": "addColumn",
    "table": "b2b_accounts",
    "column": "location_consent_at",
    "def": "DATETIME NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_accounts",
    "name": "ix_b2b_accounts_regby",
    "columns": [
      "registered_by_staff_id"
    ],
    "unique": false
  },
  {
    "op": "addIndex",
    "table": "b2b_accounts",
    "name": "ix_b2b_accounts_territory",
    "columns": [
      "territory_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_accounts",
    "name": "fk_b2b_accounts_regby",
    "column": "registered_by_staff_id",
    "refTable": "b2b_staff",
    "refColumn": "id"
  },
  {
    "op": "addForeignKey",
    "table": "b2b_accounts",
    "name": "fk_b2b_accounts_territory",
    "column": "territory_id",
    "refTable": "b2b_territories",
    "refColumn": "id"
  },
  {
    "op": "makeNullable",
    "table": "b2b_users",
    "column": "email",
    "def": "VARCHAR(190) NULL"
  },
  {
    "op": "extendEnum",
    "table": "b2b_users",
    "column": "role",
    "def": "ENUM('retailer','distributor','super_stockist') NOT NULL"
  },
  {
    "op": "addColumn",
    "table": "b2b_service_areas",
    "column": "territory_id",
    "def": "INT UNSIGNED NULL"
  },
  {
    "op": "addIndex",
    "table": "b2b_service_areas",
    "name": "ix_b2b_sa_territory",
    "columns": [
      "territory_id"
    ],
    "unique": false
  },
  {
    "op": "addForeignKey",
    "table": "b2b_service_areas",
    "name": "fk_b2b_sa_territory",
    "column": "territory_id",
    "refTable": "b2b_territories",
    "refColumn": "id"
  },
  {
    "op": "extendEnum",
    "table": "b2b_retailer_distributor_map",
    "column": "method",
    "def": "ENUM('auto','manual','bulk','direct') NOT NULL DEFAULT 'auto'"
  }
];

async function up(conn, log) {
  await guarded.runSqlFile(conn, SQL_FILE, SQL_SHA256, log);
  return guarded.apply(conn, OPS, log);
}

module.exports = { up, OPS, NEW_TABLES: ["b2b_territories", "b2b_gst_verifications", "b2b_geo_corrections"] };
